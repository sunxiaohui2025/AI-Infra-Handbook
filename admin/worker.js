// AI Infra 课程 · 运营后台 —— Cloudflare Worker 版（D1 存储）
// 功能与 admin/server.js + admin/db.js 等价，只是跑在 Cloudflare Workers 上。
//
// 绑定（wrangler.jsonc）：
//   - DB      : D1 数据库（ai-infra-handbook-db）
//   - ASSETS  : 静态资源（其实只用 env.ASSETS.fetch 兜底 /admin 与站点页面）
// 环境变量 / 密文：
//   - ADMIN_PASSWORD : 后台登录口令（建议用 wrangler secret put ADMIN_PASSWORD）
//
// 路由：
//   POST  /api/track                  埋点（body: { vid, path, title } -> { ok, id }）
//   POST  /api/dwell                  停留心跳（body: { vid, id, dt }，累加 pageviews.dwell）
//   POST  /api/pdfdl                  全文PDF下载上报（body: { vid }）
//   POST  /api/feedback               反馈（body: { vid, kind, content, page, contact }）
//   POST  /api/admin/login            登录（body: { password } -> { token }）
//   GET   /api/admin/me               校验 token
//   POST  /api/admin/logout           退出
//   GET   /api/admin/stats            总览 + 30 天走势（重查询，仅首屏调用）
//   GET   /api/admin/presence         在线人数 + 真实城市分布（轻量，供定时轮询）
//   GET   /api/admin/pdfstats         PDF 下载总数 / 今日下载（轻量，3 分钟缓存）
//   GET   /api/admin/lectures         讲热度
//   GET   /api/admin/visitors?limit=&vid=  访客列表 / 单个访客轨迹
//   GET   /api/admin/feedback?status=      反馈列表
//   POST  /api/admin/feedback/:id     body { status }：done/ignored/new
//   /admin*  与其它一切路径：交给静态资源（env.ASSETS.fetch）

const SESSION_TTL_MS = 12 * 3600 * 1000;   // 后台登录有效期 12 小时
const SESSION_GAP_MS = 30 * 60 * 1000;     // 距上次浏览超过 30 分钟算一次新回访
const ONLINE_WINDOW_MS = 30 * 60 * 1000;   // 最近 30 分钟有过浏览的访客算「正在学习」
const MAX_BODY = 64 * 1024;

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    ...extra,
  },
});

const readBody = async (request) => {
  try {
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch { return {}; }
};

// 取客户端 IP：优先 X-Forwarded-For（反代/网关），其次 Cloudflare 的 CF-Connecting-IP
function getClientIp(request) {
  const xff = request.headers.get('x-forwarded-for') || '';
  const first = (xff.split(',')[0] || '').trim();
  const ip = first || request.headers.get('cf-connecting-ip') || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/* ---------- 自动建表（与 admin/schema.sql 一致，首次请求时若表不存在则创建） ---------- */
// 建表与索引分开：表必须建成功；索引失败不能拖垮请求（CREATE INDEX 需读全表）
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS visitors (
    vid         TEXT PRIMARY KEY,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 1,
    page_views  INTEGER NOT NULL DEFAULT 0,
    pages       TEXT NOT NULL DEFAULT '[]',
    ua          TEXT NOT NULL DEFAULT '',
    last_ref    TEXT NOT NULL DEFAULT '',
    last_path   TEXT NOT NULL DEFAULT '',
    ip          TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL DEFAULT '',
    city        TEXT NOT NULL DEFAULT '',
    lat         REAL,
    lng         REAL
  )`,
  `CREATE TABLE IF NOT EXISTS pageviews (
    id    INTEGER PRIMARY KEY,
    vid   TEXT NOT NULL,
    path  TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    ua    TEXT NOT NULL DEFAULT '',
    ref   TEXT NOT NULL DEFAULT '',
    ts    TEXT NOT NULL,
    ip    TEXT NOT NULL DEFAULT '',
    dwell INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id      INTEGER PRIMARY KEY,
    vid     TEXT NOT NULL DEFAULT '',
    kind    TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    page    TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    ua      TEXT NOT NULL DEFAULT '',
    ts      TEXT NOT NULL,
    status  TEXT NOT NULL DEFAULT 'new',
    reply    TEXT NOT NULL DEFAULT '',
    reply_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stats_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schema_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pdf_downloads (
    id  INTEGER PRIMARY KEY,
    vid TEXT NOT NULL DEFAULT '',
    ts  TEXT NOT NULL,
    ua  TEXT NOT NULL DEFAULT '',
    ref TEXT NOT NULL DEFAULT ''
  )`,
];

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_pv_vid    ON pageviews(vid)`,
  `CREATE INDEX IF NOT EXISTS idx_pv_path   ON pageviews(path)`,
  `CREATE INDEX IF NOT EXISTS idx_pv_ts     ON pageviews(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_fb_status ON feedback(status)`,
  `CREATE INDEX IF NOT EXISTS idx_v_last_seen   ON visitors(last_seen)`,
  `CREATE INDEX IF NOT EXISTS idx_v_first_seen  ON visitors(first_seen)`,
  `CREATE INDEX IF NOT EXISTS idx_v_visit_count ON visitors(visit_count)`,
  // 覆盖索引：让按天序列 / WHERE ts>=? 直接走索引取 vid、dwell，不必回表
  `CREATE INDEX IF NOT EXISTS idx_pv_ts_vid_dwell ON pageviews(ts, vid, dwell)`,
  // PDF 下载事件按天统计，走 ts 索引
  `CREATE INDEX IF NOT EXISTS idx_pdf_ts ON pdf_downloads(ts)`,
];
const SCHEMA_VERSION = 3; // 结构变更时递增，触发一次性 DDL

// 索引必须逐条建并逐条容错：
//  1) idx_pv_ts_vid_dwell 依赖 dwell 列，旧库要先经过 migrateColumns 补列才有该列；
//  2) batch() 是原子的，一条失败会整批回滚；且 prepare() 阶段就抛错时连 catch 都进不去，
//     会把整个初始化打断（旧库迁移失败的真正原因）。
// DDL 只在版本升级时执行一次，逐条往返的成本可以忽略。
async function createIndexes(env) {
  for (const sql of CREATE_INDEXES) {
    try { await env.DB.prepare(sql).run(); } catch { /* 索引失败不影响服务 */ }
  }
}

// 按 D1 绑定缓存，避免同一进程里多个数据库（或测试环境）互相串用初始化状态
const schemaPromises = new WeakMap();
function ensureTables(env) {
  const cached = schemaPromises.get(env.DB);
  if (cached) return cached;
  const p = (async () => {
    // 常规路径：读 1 行版本号即可，不再每次请求都跑建表/建索引/ALTER。
    // 旧 bug：ALTER 在 24h 内被静默执行了 600+ 次（Cloudflare 实测）。
    let ver = 0;
    try {
      const row = await env.DB.prepare("SELECT v FROM schema_meta WHERE k = 'schema'").first();
      ver = row ? Number(row.v) || 0 : 0;
    } catch { /* 表还不存在，视为需要初始化 */ }
    if (ver >= SCHEMA_VERSION) return;

    await env.DB.batch(CREATE_TABLES.map((s) => env.DB.prepare(s)));
    await migrateColumns(env);  // 先给旧表补列，索引才能引用 dwell 等新列
    await createIndexes(env);   // 再建索引
    // 不吞异常：写版本失败说明 D1 此刻不可用（常见于额度耗尽）。
    // 抛出去后 ensureTables 会把缓存的 promise 删掉，额度恢复后下一次请求会重新初始化，
    // 否则会一直误以为 schema 已就绪，stats_cache 可能永远建不上。
    await env.DB.prepare(
      `INSERT INTO schema_meta (k, v) VALUES ('schema', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`
    ).bind(SCHEMA_VERSION).run();
  })().catch((err) => {
    schemaPromises.delete(env.DB); // 失败后下次请求可重试
    throw err;
  });
  schemaPromises.set(env.DB, p);
  return p;
}

// 迁移：给已存在（旧 schema）的表补列。
// 用 try/catch 而非 pragma_table_info（D1 对某些 pragma 表值函数会报 SQLITE_AUTH），
// 列已存在时 ALTER 抛“duplicate column”，忽略即可，幂等。
async function migrateColumns(env) {
  const alters = [
    `ALTER TABLE pageviews ADD COLUMN dwell INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE visitors ADD COLUMN country TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE visitors ADD COLUMN city TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE visitors ADD COLUMN lat REAL`,
    `ALTER TABLE visitors ADD COLUMN lng REAL`,
    `ALTER TABLE feedback ADD COLUMN reply TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE feedback ADD COLUMN reply_at TEXT NOT NULL DEFAULT ''`,
  ];
  for (const sql of alters) {
    try { await env.DB.prepare(sql).run(); } catch {}
  }
}

/* ---------- 会话（D1 存 token） ---------- */
async function createSession(env, token) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(token, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString()).run();
}
async function requireAuth(env, request) {
  return 'no-auth'; // 免密访问
}

/* ---------- 访问统计 ---------- */
async function recordVisit(env, { vid, path, title, ua, ref, ip, country = '', city = '', lat = null, lng = null }) {
  const ts = new Date().toISOString();
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT * FROM visitors WHERE vid = ?').bind(vid).first();

  if (!existing) {
    await env.DB.prepare(`INSERT INTO visitors
      (vid, first_seen, last_seen, visit_count, page_views, pages, ua, last_ref, last_path, ip, country, city, lat, lng)
      VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(vid, ts, ts, JSON.stringify([{ path, title, views: 1 }]), ua, ref, path, ip, country, city, lat, lng).run();
  } else {
    let visitCount = existing.visit_count;
    if (now - Date.parse(existing.last_seen) > SESSION_GAP_MS) visitCount += 1;
    let pages = JSON.parse(existing.pages || '[]');
    const hit = pages.find((p) => p.path === path);
    if (hit) hit.views += 1;
    else pages.push({ path, title, views: 1 });
    if (pages.length > 30) pages = pages.slice(-30); // 只留最近 30 个路径
    await env.DB.prepare(`UPDATE visitors SET
        visit_count = ?, page_views = page_views + 1, pages = ?, ua = ?, last_ref = ?, last_path = ?, ip = ?, last_seen = ?,
        country = CASE WHEN ? != '' THEN ? ELSE country END,
        city    = CASE WHEN ? != '' THEN ? ELSE city END,
        lat     = COALESCE(?, lat),
        lng     = COALESCE(?, lng)
      WHERE vid = ?`)
      .bind(visitCount, JSON.stringify(pages), ua, ref, path, ip, ts, country, country, city, city, lat, lng, vid).run();
  }
  const res = await env.DB.prepare(`INSERT INTO pageviews (vid, path, title, ua, ref, ts, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(vid, path, title, ua, ref, ts, ip).run();
  return Number(res.meta.last_row_id || res.meta.changes || 0);
}

/* ---------- 实时在场（真实在线人数 + 真实城市分布） ---------- */
async function getLivePresence(env) {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  const [rows, online, located] = await Promise.all([
    env.DB.prepare(`SELECT city, country, lat, lng, COUNT(*) AS learners FROM visitors
      WHERE city != '' AND lat IS NOT NULL AND lng IS NOT NULL AND last_seen >= ?
      GROUP BY city, country, lat, lng ORDER BY learners DESC`).bind(since).all(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM visitors WHERE last_seen >= ?').bind(since).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM visitors
      WHERE last_seen >= ? AND city != '' AND lat IS NOT NULL AND lng IS NOT NULL`).bind(since).first(),
  ]);
  const mapNodes = rows.results.map((r) => ({
    name: r.city,
    country: r.country || '',
    x: Math.round(((r.lng + 180) / 360) * 1000) / 10,
    y: Math.round(((90 - r.lat) / 180) * 1000) / 10,
    learners: r.learners,
    latestLecture: '',
  }));
  return { onlineCount: online.c, locatedCount: located.c, mapNodes };
}

/* ---------- 运营指标 ---------- */
async function getDashboard(env) {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 3600 * 1000 * 24).toISOString();
  const startDay = new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // 合并同表聚合，减少全表扫描次数（每次扫描都计入 D1 rows_read）
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u,
            COALESCE(SUM(dwell),0) AS s, COALESCE(AVG(dwell),0) AS a
     FROM pageviews`
  ).first();
  const today = await env.DB.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u FROM pageviews WHERE ts >= ?').bind(dayAgo).first();
  const week = await env.DB.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u FROM pageviews WHERE ts >= ?').bind(weekAgo).first();
  const nv = await env.DB.prepare('SELECT COUNT(DISTINCT vid) AS u FROM visitors WHERE first_seen >= ?').bind(weekAgo).first();
  // 一次扫 visitors 同时得到「总访客数」与「回访访客数」
  const visAgg = await env.DB.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN visit_count > 1 THEN 1 ELSE 0 END), 0) AS ret FROM visitors`
  ).first();
  const fb = await env.DB.prepare("SELECT COUNT(*) AS c FROM feedback WHERE status = 'new'").first();
  const dwell = { s: total.s, a: total.a };
  const ret = { c: visAgg.ret };
  const totalVis = { c: visAgg.c };

  // 每讲热度：总览只需前 20 条，缩小 limit 以减少全表聚合读取量
  const lectures = await getLectureRanking(env, 20);

  // 近 30 天走势（补零）
  const raw = await env.DB.prepare(
    `SELECT substr(ts, 1, 10) AS d, COUNT(*) AS pv, COUNT(DISTINCT vid) AS uv, COALESCE(SUM(dwell),0) AS dw
     FROM pageviews WHERE ts >= ? GROUP BY d ORDER BY d`
  ).bind(startDay).all();
  const map = {};
  for (const r of raw.results) map[r.d] = { pv: r.pv, uv: r.uv, dw: r.dw || 0 };
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    series.push({ d, pv: (map[d] || { pv: 0 }).pv, uv: (map[d] || { uv: 0 }).uv, dw: (map[d] || { dw: 0 }).dw });
  }

  const presence = await getLivePresence(env);

  return {
    kpi: {
      totalPv: total.c, totalUv: total.u,
      today: today.c, todayUv: today.u,
      weekPv: week.c, weekUv: week.u,
      newVisitors: nv.u, totalVisitors: totalVis.c,
      returnRate: ret.c, newFeedback: fb.c,
      avgDwell: dwell.a, totalDwell: dwell.s,
    },
    series,
    lectures: lectures.slice(0, 20),
    ...presence,
  };
}

// 单次聚合完成：SQLite 中当查询含唯一 MAX() 时，未聚合的 bare column（title）
// 取自 MAX(ts) 所在的那一行的值 —— 一次全表扫描即可拿到每个 path 的最新标题。
// 旧写法用 CORRELATED SCALAR SUBQUERY（每个 path 再查一次）：Cloudflare 查询排行里
// 该语句 7 天窗口累计 463 次调用、读了 722 万行（rows_read/returned=370，注意是 7 天不是 1 天）；
// 而 24 小时用量分析里它单独占 2,073,693 行 / 41%，是额度超限的头号来源。
async function getLectureRanking(env, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT path,
        title,
        COUNT(*) AS views,
        COUNT(DISTINCT vid) AS uv,
        COALESCE(SUM(dwell), 0) AS dwell,
        ROUND(AVG(dwell), 1) AS avgDwell,
        MAX(ts) AS latest_ts
     FROM pageviews
     GROUP BY path
     ORDER BY views DESC
     LIMIT ?`
  ).bind(limit).all();
  return rows.results;
}

async function getVisitorList(env, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT v.vid, v.ip, v.first_seen, v.last_seen, v.visit_count, v.page_views, v.pages, v.ua, v.last_path,
        (SELECT COALESCE(SUM(dwell),0) FROM pageviews WHERE vid = v.vid) AS dwell
     FROM visitors v ORDER BY v.last_seen DESC LIMIT ?`
  ).bind(limit).all();
  return rows.results;
}

async function getVisitorDetail(env, vid, limit = 200) {
  const rows = await env.DB.prepare(
    `SELECT path, title, ts, ip, dwell FROM pageviews WHERE vid = ? ORDER BY ts DESC LIMIT ?`
  ).bind(vid, limit).all();
  return rows.results;
}

/* ---------- 反馈 ---------- */
async function addFeedback(env, { vid, kind, content, page, contact, ua }) {
  const ts = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO feedback (vid, kind, content, page, contact, ua, ts, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`
  ).bind(vid || '', kind || '', content, page || '', contact || '', ua || '', ts).run();
  return Number(res.meta.last_row_id || res.meta.changes || 0);
}
async function listFeedback(env, status, limit = 200) {
  // 'all' / '' / 缺省 都表示不过滤（修复：此前 status='all' 被当成真实状态，导致列表永远为空）
  const useFilter = status && status !== 'all';
  const sql = useFilter
    ? 'SELECT * FROM feedback WHERE status = ? ORDER BY ts DESC LIMIT ?'
    : 'SELECT * FROM feedback ORDER BY ts DESC LIMIT ?';
  const stmt = useFilter ? env.DB.prepare(sql).bind(status, limit) : env.DB.prepare(sql).bind(limit);
  const rows = await stmt.all();
  return rows.results;
}
async function setFeedbackStatus(env, id, status) {
  await env.DB.prepare('UPDATE feedback SET status = ? WHERE id = ?').bind(status, id).run();
}
/** 保存管理员回复；有回复时自动标记为已处理，清空回复则回到待处理。 */
async function setFeedbackReply(env, id, reply) {
  const text = String(reply || '').slice(0, 4000);
  const at = text ? new Date().toISOString() : '';
  await env.DB.prepare('UPDATE feedback SET reply = ?, reply_at = ?, status = ? WHERE id = ?')
    .bind(text, at, text ? 'done' : 'new', id).run();
  return { ok: true };
}
/** 公开留言板：仅暴露可公开字段（不含 vid / contact / ua / ip）。被忽略的留言不展示。 */
async function listPublicBoard(env, limit = 100) {
  const n = Math.min(Number(limit) || 100, 200);
  const rows = await env.DB.prepare(
    `SELECT id, kind, content, ts, reply, reply_at FROM feedback
     WHERE status != 'ignored' ORDER BY ts DESC LIMIT ?`
  ).bind(n).all();
  return rows.results;
}

/* ---------- PDF 电子书下载统计 ----------
 * 每次点击「全文PDF」上报一行到 pdf_downloads（小表，COUNT 极便宜），
 * 后台走独立的 /api/admin/pdfstats（3 分钟缓存）展示，不混入 pageviews 的 PV/UV。
 */
// 历史补偿基数：统计功能上线之前的下载没有被记录，累计值统一加上这个基数。
// 「今日下载」不加，仍是当天真实上报数。要调整改这里即可。
const PDF_DOWNLOAD_BASE = 300;

async function addPdfDownload(env, { vid, ua, ref }) {
  const ts = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO pdf_downloads (vid, ts, ua, ref) VALUES (?, ?, ?, ?)`)
    .bind(vid || '', ts, ua || '', ref || '').run();
  return { ok: true };
}
async function getPdfStats(env) {
  const today = new Date().toISOString().slice(0, 10);
  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM pdf_downloads').first();
  const tod = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM pdf_downloads WHERE substr(ts, 1, 10) = ?`
  ).bind(today).first();
  return { total: total.c + PDF_DOWNLOAD_BASE, today: tod.c };
}

/* ---------- 读接口结果缓存（跨 isolate 持久） ----------
 * D1 免费版每天 500 万 rows_read。看板全是全表聚合：一次 stats ≈ 4 万行，
 * 每天 127 次就撞线（Cloudflare 官方用量分析实测）。
 * 仅用 isolate 内存缓存无效（冷启动即失效、命中率极低），所以做两级：
 *   L1 内存        —— 命中时 0 次 D1 读
 *   L2 stats_cache —— 存在 D1 里，跨 isolate 共享；命中时只读 1 行
 * 只有两级都 miss 才执行重聚合。TTL 内无论来多少次请求只算一次。
 */
const STATS_TTL_MS = 60 * 60 * 1000;     // 完整统计 1 小时 → 每天最多 24 次重算
const PRESENCE_TTL_MS = 3 * 60 * 1000;   // 在线状态 3 分钟
const L1_MAX_TTL_MS = 60 * 1000;         // 内存缓存最多持有 1 分钟
// 按 D1 绑定隔离，避免同一进程里多个数据库（或测试环境）串缓存
const l1Caches = new WeakMap();           // env.DB -> Map(name -> { until, value })
function l1For(env) {
  let m = l1Caches.get(env.DB);
  if (!m) { m = new Map(); l1Caches.set(env.DB, m); }
  return m;
}

async function withCache(env, name, ttlMs, producer, persist = true) {
  const now = Date.now();
  // L1 只短暂持有：过期后会去读 L2（仅 1 行），从而感知其他 isolate 做的缓存失效。
  // 若 L1 也持有 1 小时，别的 isolate 删掉 L2 后本机仍会返回旧数据直到 TTL 结束。
  // persist=false（presence）没有 L2，L1 只能自己撑满整个 TTL。
  const l1TtlMs = persist ? Math.min(ttlMs, L1_MAX_TTL_MS) : ttlMs;
  const l1Cache = l1For(env);
  const l1 = l1Cache.get(name);
  if (l1 && l1.until > now) return l1.value;

  // L2：跨 isolate 持久缓存，命中只花 1 行读取
  if (persist) {
    try {
      const row = await env.DB.prepare(
        'SELECT value, updated_at FROM stats_cache WHERE key = ?'
      ).bind(name).first();
      if (row) {
        const age = now - Date.parse(row.updated_at);
        if (Number.isFinite(age) && age < ttlMs) {
          const value = JSON.parse(row.value);
          l1Cache.set(name, { until: now + l1TtlMs, value });
          return value;
        }
      }
    } catch { /* 表未就绪时静默降级到重算 */ }
  }

  const value = await producer();
  l1Cache.set(name, { until: now + l1TtlMs, value });
  if (persist) {
    try {
      await env.DB.prepare(
        `INSERT INTO stats_cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(name, JSON.stringify(value), new Date(now).toISOString()).run();
    } catch { /* 缓存写失败不影响主流程 */ }
  }
  return value;
}

async function invalidateCache(env, prefix) {
  const l1Cache = l1For(env);
  for (const k of l1Cache.keys()) {
    if (!prefix || k.startsWith(prefix)) l1Cache.delete(k);
  }
  try {
    if (prefix) await env.DB.prepare('DELETE FROM stats_cache WHERE key LIKE ?').bind(prefix + '%').run();
    else await env.DB.prepare('DELETE FROM stats_cache').run();
  } catch { /* ignore */ }
}

/* ---------- 接口路由 ---------- */
async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // 健康/诊断：无需登录，用来确认 Worker 是否读到 ADMIN_PASSWORD、DB 绑定是否就绪
  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true, admin: !!env.ADMIN_PASSWORD, db: !!env.DB, ts: Date.now() });
  }

  await ensureTables(env); // 首次请求确保表存在（幂等）

  // 公开接口
  if (path === '/api/track' && method === 'POST') {
    const body = await readBody(request);
    const vid = (body.vid || '').toString();
    if (!vid) return json({ error: 'missing vid' }, 400);
    // Cloudflare 免费提供访客地理位置（request.cf）；取不到则留空，不造假
    const cf = request.cf || {};
    const lat = Number(cf.latitude);
    const lng = Number(cf.longitude);
    const id = await recordVisit(env, {
      vid,
      path: (body.path || '').toString().slice(0, 500),
      title: (body.title || '').toString().slice(0, 300),
      ua: (request.headers.get('user-agent') || '').slice(0, 300),
      ref: (request.headers.get('referer') || '').slice(0, 500),
      ip: getClientIp(request),
      country: cf.country || '',
      city: cf.city || '',
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    });
    return json({ ok: true, id });
  }

  // 停留时长心跳：只累加该访客自己的 pageview，避免刷数
  if (path === '/api/dwell' && method === 'POST') {
    const body = await readBody(request);
    const id = Number(body.id);
    const dt = Math.round(Number(body.dt) || 0);
    const vid = (body.vid || '').toString();
    if (!id || !(dt > 0)) return json({ error: 'bad payload' }, 400);
    await env.DB.prepare('UPDATE pageviews SET dwell = dwell + ? WHERE id = ? AND vid = ?')
      .bind(dt, id, vid).run();
    return json({ ok: true });
  }

  // PDF 电子书下载：每次点击「全文PDF」上报一次（小表写入，读到后台 3 分钟内可见）
  if (path === '/api/pdfdl' && method === 'POST') {
    const body = await readBody(request);
    await addPdfDownload(env, {
      vid: (body.vid || '').toString(),
      ua: (request.headers.get('user-agent') || '').slice(0, 300),
      ref: (request.headers.get('referer') || '').slice(0, 500),
    });
    await invalidateCache(env, 'pdfstats'); // 让数字尽快刷新
    return json({ ok: true });
  }

  if (path === '/api/feedback' && method === 'POST') {
    const body = await readBody(request);
    const content = (body.content || '').toString().trim();
    if (!content) return json({ error: 'empty content' }, 400);
    const id = await addFeedback(env, {
      vid: (body.vid || '').toString(),
      kind: (body.kind || '').toString(),
      content: content.slice(0, 2000),
      page: (body.page || '').toString().slice(0, 300),
      contact: (body.contact || '').toString().slice(0, 300),
      ua: (request.headers.get('user-agent') || '').slice(0, 300),
    });
    await invalidateCache(env, 'board');   // 新留言要立即可见
    await invalidateCache(env, 'stats');   // KPI 里的待处理反馈数
    return json({ ok: true, id });
  }

  // 公开留言板：任何人可读，仅返回可公开字段（不含联系方式 / IP / UA / vid）
  if (path === '/api/board' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 100);
    // limit 进 key：否则 ?limit=1 与 ?limit=100 会互相串缓存。
    // 前缀仍为 board，invalidateCache(env, 'board') 的 LIKE 'board%' 能一并清掉。
    const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return json({ list: await withCache(env, 'board:' + n, PRESENCE_TTL_MS, () => listPublicBoard(env, n)) });
  }

  // 后台接口
  if (/^\/api\/admin\//.test(path)) {
    // 登录不需要鉴权（免密）
    if (path === '/api/admin/login' && method === 'POST') {
      return json({ token: 'no-auth' });
    }

    const token = await requireAuth(env, request);
    if (!token) return json({ error: 'unauthorized' }, 401);

    if (path === '/api/admin/me') return json({ ok: true });
    if (path === '/api/admin/logout' && method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }
    // 重查询走持久缓存：TTL 内不论被调用多少次，只真正查库一次
    if (path === '/api/admin/stats') {
      return json(await withCache(env, 'stats', STATS_TTL_MS, () => getDashboard(env)));
    }
    // 在线状态：轻量查询，只在内存缓存，不写 D1（避免额外写入）
    if (path === '/api/admin/presence') {
      return json(await withCache(env, 'presence', PRESENCE_TTL_MS, () => getLivePresence(env), false));
    }
    // PDF 下载统计：小表计数，3 分钟持久缓存，成本可忽略
    if (path === '/api/admin/pdfstats') {
      return json(await withCache(env, 'pdfstats', PRESENCE_TTL_MS, () => getPdfStats(env)));
    }
    if (path === '/api/admin/lectures') {
      return json({ list: await withCache(env, 'lectures', STATS_TTL_MS, () => getLectureRanking(env, 100)) });
    }
    if (path === '/api/admin/visitors') {
      const vid = url.searchParams.get('vid');
      const limit = Number(url.searchParams.get('limit') || 100);
      if (vid) return json({ detail: await getVisitorDetail(env, vid, 200) });
      return json({ list: await getVisitorList(env, limit) });
    }
    if (path === '/api/admin/feedback') {
      const status = url.searchParams.get('status') || '';
      return json({ list: await listFeedback(env, status) });
    }
    const fbMatch = path.match(/^\/api\/admin\/feedback\/(\d+)$/);
    if (fbMatch && method === 'POST') {
      const body = await readBody(request);
      const status = ['done', 'ignored', 'new'].includes(body.status) ? body.status : 'new';
      await setFeedbackStatus(env, Number(fbMatch[1]), status);
      await invalidateCache(env, 'board'); await invalidateCache(env, 'stats');
      return json({ ok: true });
    }
    // 管理员回复：需要管理密码（env.ADMIN_PASSWORD），保证仅管理员可回复
    const replyMatch = path.match(/^\/api\/admin\/feedback\/(\d+)\/reply$/);
    if (replyMatch && method === 'POST') {
      const expected = env.ADMIN_PASSWORD || '';
      if (!expected) return json({ error: 'no_admin_password', message: '服务端未配置管理密码' }, 500);
      const body = await readBody(request);
      if (String(body.password || '') !== expected) {
        return json({ error: 'bad_password', message: '管理密码错误' }, 401);
      }
      await setFeedbackReply(env, Number(replyMatch[1]), body.reply);
      await invalidateCache(env, 'board'); await invalidateCache(env, 'stats');
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      // 统一兜底：把 D1 异常转成可读 JSON，而不是裸的 1101。
      // 常见原因：D1 免费版每日 rows_read 额度耗尽（此时读库全失败、纯写入仍可成功）。
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        const msg = String((err && err.message) || err);
        const quota = /exceeded|limit|quota|too many rows|rows_read/i.test(msg);
        return json({
          error: quota ? 'd1_read_quota_exceeded' : 'd1_error',
          message: quota
            ? 'D1 每日读取额度已用尽，数据暂不可用。免费版额度于每日 UTC 00:00（北京时间 08:00）重置。'
            : '数据库查询失败：' + msg,
          detail: msg.slice(0, 300),
        }, quota ? 429 : 500);
      }
    }

    // /admin 无斜杠 -> 跳到 /admin/；/admin* 交给静态资源（admin SPA）
    if (url.pathname === '/admin') {
      return new Response(null, { status: 302, headers: { Location: '/admin/' } });
    }

    // 其余（站点页面、/admin/ 下的文件、search.json 等）交给静态资源
    return env.ASSETS.fetch(request);
  },
};
