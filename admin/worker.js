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
//   POST  /api/feedback               反馈（body: { vid, kind, content, page, contact }）
//   POST  /api/admin/login            登录（body: { password } -> { token }）
//   GET   /api/admin/me               校验 token
//   POST  /api/admin/logout           退出
//   GET   /api/admin/stats            总览 + 30 天走势（重查询，仅首屏调用）
//   GET   /api/admin/presence         在线人数 + 真实城市分布（轻量，供定时轮询）
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
    status  TEXT NOT NULL DEFAULT 'new'
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
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
];

let schemaPromise = null;
function ensureTables(env) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      // 1) 建表：必须成功，失败则整个服务不可用（会抛错）
      await env.DB.batch(CREATE_TABLES.map((s) => env.DB.prepare(s)));
      // 2) 索引：CREATE INDEX 会读全表，且额度耗尽时会失败；
      //    失败不应阻断请求（缺索引只是变慢），单独容错，避免拖垮写入。
      await env.DB.batch(CREATE_INDEXES.map((s) => env.DB.prepare(s))).catch(() => {});
      // 3) 补列迁移：同样是幂等的 ALTER，失败也忽略
      await migrateColumns(env);
    })().catch((err) => {
      schemaPromise = null; // 失败后可重试
      throw err;
    });
  }
  return schemaPromise;
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

async function getLectureRanking(env, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT p.path,
        COALESCE((SELECT title FROM pageviews WHERE path = p.path ORDER BY ts DESC LIMIT 1), '') AS title,
        COUNT(*) AS views,
        COUNT(DISTINCT p.vid) AS uv,
        COALESCE(SUM(p.dwell), 0) AS dwell,
        ROUND(AVG(p.dwell), 1) AS avgDwell
     FROM pageviews p
     GROUP BY p.path
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
  const sql = status
    ? 'SELECT * FROM feedback WHERE status = ? ORDER BY ts DESC LIMIT ?'
    : 'SELECT * FROM feedback ORDER BY ts DESC LIMIT ?';
  const stmt = status ? env.DB.prepare(sql).bind(status, limit) : env.DB.prepare(sql).bind(limit);
  const rows = await stmt.all();
  return rows.results;
}
async function setFeedbackStatus(env, id, status) {
  await env.DB.prepare('UPDATE feedback SET status = ? WHERE id = ?').bind(status, id).run();
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
    return json({ ok: true, id });
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
    if (path === '/api/admin/stats') return json(await getDashboard(env));
    // 轻量：只查在线人数与城市分布，走 last_seen 索引，读数极低，供前端每 60 秒轮询
    if (path === '/api/admin/presence') return json(await getLivePresence(env));
    if (path === '/api/admin/lectures') return json({ list: await getLectureRanking(env, 100) });
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
