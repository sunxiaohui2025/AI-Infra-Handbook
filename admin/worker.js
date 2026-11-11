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
//   POST  /api/track                  埋点（body: { vid, path, title }）
//   POST  /api/feedback               反馈（body: { vid, kind, content, page, contact }）
//   POST  /api/admin/login            登录（body: { password } -> { token }）
//   GET   /api/admin/me               校验 token
//   POST  /api/admin/logout           退出
//   GET   /api/admin/stats            总览 + 14 天走势
//   GET   /api/admin/lectures         讲热度
//   GET   /api/admin/visitors?limit=&vid=  访客列表 / 单个访客轨迹
//   GET   /api/admin/feedback?status=      反馈列表
//   POST  /api/admin/feedback/:id     body { status }：done/ignored/new
//   /admin*  与其它一切路径：交给静态资源（env.ASSETS.fetch）

const SESSION_TTL_MS = 12 * 3600 * 1000;   // 后台登录有效期 12 小时
const SESSION_GAP_MS = 30 * 60 * 1000;     // 距上次浏览超过 30 分钟算一次新回访
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
const SCHEMA = [
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
    ip          TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS pageviews (
    id    INTEGER PRIMARY KEY,
    vid   TEXT NOT NULL,
    path  TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    ua    TEXT NOT NULL DEFAULT '',
    ref   TEXT NOT NULL DEFAULT '',
    ts    TEXT NOT NULL,
    ip    TEXT NOT NULL DEFAULT ''
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
  `CREATE INDEX IF NOT EXISTS idx_pv_vid    ON pageviews(vid)`,
  `CREATE INDEX IF NOT EXISTS idx_pv_path   ON pageviews(path)`,
  `CREATE INDEX IF NOT EXISTS idx_pv_ts     ON pageviews(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_fb_status ON feedback(status)`,
];

let schemaPromise = null;
function ensureTables(env) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    })().catch((err) => {
      schemaPromise = null; // 失败后可重试
      throw err;
    });
  }
  return schemaPromise;
}

/* ---------- 会话（D1 存 token） ---------- */
async function createSession(env, token) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(token, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString()).run();
}
async function requireAuth(env, request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!row || Date.parse(row.expires_at) < Date.now()) return null;
  return token;
}

/* ---------- 访问统计 ---------- */
async function recordVisit(env, { vid, path, title, ua, ref, ip }) {
  const ts = new Date().toISOString();
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT * FROM visitors WHERE vid = ?').bind(vid).first();

  if (!existing) {
    await env.DB.prepare(`INSERT INTO visitors
      (vid, first_seen, last_seen, visit_count, page_views, pages, ua, last_ref, last_path, ip)
      VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`)
      .bind(vid, ts, ts, JSON.stringify([{ path, title, views: 1 }]), ua, ref, path, ip).run();
  } else {
    let visitCount = existing.visit_count;
    if (now - Date.parse(existing.last_seen) > SESSION_GAP_MS) visitCount += 1;
    let pages = JSON.parse(existing.pages || '[]');
    const hit = pages.find((p) => p.path === path);
    if (hit) hit.views += 1;
    else pages.push({ path, title, views: 1 });
    if (pages.length > 30) pages = pages.slice(-30); // 只留最近 30 个路径
    await env.DB.prepare(`UPDATE visitors SET
        visit_count = ?, page_views = page_views + 1, pages = ?, ua = ?, last_ref = ?, last_path = ?, ip = ?, last_seen = ?
      WHERE vid = ?`)
      .bind(visitCount, JSON.stringify(pages), ua, ref, path, ip, ts, vid).run();
  }
  await env.DB.prepare(`INSERT INTO pageviews (vid, path, title, ua, ref, ts, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(vid, path, title, ua, ref, ts, ip).run();
}

/* ---------- 运营指标 ---------- */
async function getDashboard(env) {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 3600 * 1000 * 24).toISOString();
  const startDay = new Date(Date.now() - 13 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const total = await env.DB.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u FROM pageviews').first();
  const today = await env.DB.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u FROM pageviews WHERE ts >= ?').bind(dayAgo).first();
  const week = await env.DB.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u FROM pageviews WHERE ts >= ?').bind(weekAgo).first();
  const nv = await env.DB.prepare('SELECT COUNT(DISTINCT vid) AS u FROM visitors WHERE first_seen >= ?').bind(weekAgo).first();
  const ret = await env.DB.prepare('SELECT COUNT(*) AS c FROM visitors WHERE visit_count > 1').first();
  const totalVis = await env.DB.prepare('SELECT COUNT(*) AS c FROM visitors').first();
  const fb = await env.DB.prepare("SELECT COUNT(*) AS c FROM feedback WHERE status = 'new'").first();

  // 每讲热度，附最近一次标题
  const lectures = await getLectureRanking(env, 100);
  const byPath = {};
  for (const l of lectures) {
    byPath[l.path] = l.title;
  }

  // 近 14 天走势（补零）
  const raw = await env.DB.prepare(
    `SELECT substr(ts, 1, 10) AS d, COUNT(*) AS pv, COUNT(DISTINCT vid) AS uv
     FROM pageviews WHERE ts >= ? GROUP BY d ORDER BY d`
  ).bind(startDay).all();
  const map = {};
  for (const r of raw.results) map[r.d] = { pv: r.pv, uv: r.uv };
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    series.push({ d, pv: (map[d] || { pv: 0 }).pv, uv: (map[d] || { uv: 0 }).uv });
  }

  return {
    kpi: {
      totalPv: total.c, totalUv: total.u,
      today: today.c, todayUv: today.u,
      weekPv: week.c, weekUv: week.u,
      newVisitors: nv.u, totalVisitors: totalVis.c,
      returnRate: ret.c, newFeedback: fb.c,
    },
    series,
    lectures: lectures.slice(0, 20),
  };
}

async function getLectureRanking(env, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT p.path,
        COALESCE((SELECT title FROM pageviews WHERE path = p.path ORDER BY ts DESC LIMIT 1), '') AS title,
        COUNT(*) AS views,
        COUNT(DISTINCT p.vid) AS uv
     FROM pageviews p
     GROUP BY p.path
     ORDER BY views DESC
     LIMIT ?`
  ).bind(limit).all();
  return rows.results;
}

async function getVisitorList(env, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT vid, ip, first_seen, last_seen, visit_count, page_views, pages, ua, last_path
     FROM visitors ORDER BY last_seen DESC LIMIT ?`
  ).bind(limit).all();
  return rows.results;
}

async function getVisitorDetail(env, vid, limit = 200) {
  const rows = await env.DB.prepare(
    `SELECT path, title, ts, ip FROM pageviews WHERE vid = ? ORDER BY ts DESC LIMIT ?`
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
  await ensureTables(env); // 首次请求确保表存在（幂等）
  const path = url.pathname;
  const method = request.method;

  // 公开接口
  if (path === '/api/track' && method === 'POST') {
    const body = await readBody(request);
    const vid = (body.vid || '').toString();
    if (!vid) return json({ error: 'missing vid' }, 400);
    await recordVisit(env, {
      vid,
      path: (body.path || '').toString().slice(0, 500),
      title: (body.title || '').toString().slice(0, 300),
      ua: (request.headers.get('user-agent') || '').slice(0, 300),
      ref: (request.headers.get('referer') || '').slice(0, 500),
      ip: getClientIp(request),
    });
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
    // 登录不需要鉴权
    if (path === '/api/admin/login' && method === 'POST') {
      const body = await readBody(request);
      const pw = env.ADMIN_PASSWORD || '';
      if (!pw) return json({ error: '未配置 ADMIN_PASSWORD' }, 500);
      if ((body.password || '').toString() !== pw) return json({ error: '口令错误' }, 401);
      const token = crypto.randomUUID();
      await createSession(env, token);
      return json({ token });
    }

    const token = await requireAuth(env, request);
    if (!token) return json({ error: 'unauthorized' }, 401);

    if (path === '/api/admin/me') return json({ ok: true });
    if (path === '/api/admin/logout' && method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }
    if (path === '/api/admin/stats') return json(await getDashboard(env));
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

    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

    // /admin 无斜杠 -> 跳到 /admin/；/admin* 交给静态资源（admin SPA）
    if (url.pathname === '/admin') {
      return new Response(null, { status: 302, headers: { Location: '/admin/' } });
    }

    // 其余（站点页面、/admin/ 下的文件、search.json 等）交给静态资源
    return env.ASSETS.fetch(request);
  },
};
