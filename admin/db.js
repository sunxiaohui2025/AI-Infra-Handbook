// 运营后台数据库层：用 Node 内置 node:sqlite（Node 22.5+），零 npm 依赖。
// 数据文件默认放在 admin/data/app.db，可通过环境变量 AI_DB 覆盖。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AI_DB || join(__dirname, 'data', 'app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// 页面在被看作「新一次回访」前，允许的最大间隔（毫秒）。超过则 visit_count +1。
export const SESSION_GAP_MS = 30 * 60 * 1000;

// 必须先建表，再 prepare 语句（prepare 在模块加载时就会执行）
initSchema();

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitors (
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
    );
    CREATE TABLE IF NOT EXISTS pageviews (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      vid   TEXT NOT NULL,
      path  TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      ua    TEXT NOT NULL DEFAULT '',
      ref   TEXT NOT NULL DEFAULT '',
      ts    TEXT NOT NULL,
      ip    TEXT NOT NULL DEFAULT '',
      dwell INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      vid     TEXT NOT NULL DEFAULT '',
      kind    TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      page    TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      ua      TEXT NOT NULL DEFAULT '',
      ts      TEXT NOT NULL,
      status  TEXT NOT NULL DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pv_vid  ON pageviews(vid);
    CREATE INDEX IF NOT EXISTS idx_pv_path ON pageviews(path);
    CREATE INDEX IF NOT EXISTS idx_pv_ts   ON pageviews(ts);
    CREATE INDEX IF NOT EXISTS idx_fb_status ON feedback(status);
  `);

  // 迁移：给已有的库补 ip 列（新库 CREATE TABLE 已含该列，ALTER 已有列会抛错，忽略即可）
  try { db.exec(`ALTER TABLE visitors ADD COLUMN ip TEXT NOT NULL DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE pageviews ADD COLUMN ip TEXT NOT NULL DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE pageviews ADD COLUMN dwell INTEGER NOT NULL DEFAULT 0`); } catch {}
  // 迁移：v2 真实地理位置字段
  try { db.exec(`ALTER TABLE visitors ADD COLUMN country TEXT NOT NULL DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE visitors ADD COLUMN city TEXT NOT NULL DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE visitors ADD COLUMN lat REAL`); } catch {}
  try { db.exec(`ALTER TABLE visitors ADD COLUMN lng REAL`); } catch {}
}

/* ---------- 访问统计 ---------- */

const upsertVisitor = db.prepare(`
  INSERT INTO visitors (vid, first_seen, last_seen, visit_count, page_views, pages, ua, last_ref, last_path, ip, country, city, lat, lng)
  VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getVisitor = db.prepare(`SELECT * FROM visitors WHERE vid = ?`);
const bumpVisitor = db.prepare(`
  UPDATE visitors
  SET visit_count = ?, page_views = page_views + 1, pages = ?, ua = ?, last_ref = ?, last_path = ?, ip = ?, last_seen = ?,
      country = CASE WHEN ? != '' THEN ? ELSE country END,
      city    = CASE WHEN ? != '' THEN ? ELSE city END,
      lat     = COALESCE(?, lat),
      lng     = COALESCE(?, lng)
  WHERE vid = ?
`);
const insertPageview = db.prepare(`
  INSERT INTO pageviews (vid, path, title, ua, ref, ts, ip) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export function recordVisit({ vid, path, title, ua, ref, ip = '', country = '', city = '', lat = null, lng = null }) {
  const ts = new Date().toISOString();
  const now = Date.now();
  const existing = getVisitor.get(vid);

  if (!existing) {
    upsertVisitor.run(vid, ts, ts, JSON.stringify([{ path, title, views: 1 }]), ua, ref, path, ip, country, city, lat, lng);
  } else {
    // 距上次访问超过会话窗口 => 记为新一次回访
    let visitCount = existing.visit_count;
    if (now - Date.parse(existing.last_seen) > SESSION_GAP_MS) visitCount += 1;

    let pages = JSON.parse(existing.pages || '[]');
    const hit = pages.find((p) => p.path === path);
    if (hit) hit.views += 1;
    else pages.push({ path, title, views: 1 });
    if (pages.length > 30) pages = pages.slice(-30); // 只保留最近 30 个路径，避免单个访客行无限膨胀

    bumpVisitor.run(visitCount, JSON.stringify(pages), ua, ref, path, ip, ts, country, country, city, city, lat, lng, vid);
  }
  const res = insertPageview.run(vid, path, title, ua, ref, ts, ip);
  return Number(res.lastInsertRowid);
}

const addDwellStmt = db.prepare(`
  UPDATE pageviews SET dwell = dwell + ? WHERE id = ? AND vid = ?
`);
export function addDwell({ vid, id, dt }) {
  addDwellStmt.run(dt, id, vid);
  return true;
}

/* ---------- 运营指标 ---------- */

const kpiOne = db.prepare(`
  SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u FROM pageviews
`);
const kpiSince = db.prepare(`
  SELECT COUNT(*) AS c, COUNT(DISTINCT vid) AS u FROM pageviews WHERE ts >= ?
`);
const visitorsSince = db.prepare(`
  SELECT COUNT(DISTINCT vid) AS u FROM visitors WHERE first_seen >= ?
`);
const returnRate = db.prepare(`
  SELECT COUNT(*) AS c FROM visitors WHERE visit_count > 1
`);
const totalVisitors = db.prepare(`SELECT COUNT(*) AS c FROM visitors`);
const dwellAgg = db.prepare(`SELECT COALESCE(SUM(dwell),0) AS s, COALESCE(AVG(dwell),0) AS a FROM pageviews`);
const dailySeries = db.prepare(`
  SELECT substr(ts, 1, 10) AS d,
         COUNT(*) AS pv,
         COUNT(DISTINCT vid) AS uv,
         COALESCE(SUM(dwell),0) AS dw
  FROM pageviews
  WHERE ts >= ?
  GROUP BY d ORDER BY d
`);
const topPages = db.prepare(`
  SELECT path, COUNT(*) AS views, COUNT(DISTINCT vid) AS uv,
         COALESCE(SUM(dwell),0) AS dwell, ROUND(AVG(dwell),1) AS avgDwell
  FROM pageviews
  WHERE path LIKE ?
  GROUP BY path
  ORDER BY views DESC
  LIMIT ?
`);
const latestTitle = db.prepare(`
  SELECT title FROM pageviews WHERE path = ? ORDER BY ts DESC LIMIT 1
`);
const visitorList = db.prepare(`
  SELECT v.vid, v.ip, v.first_seen, v.last_seen, v.visit_count, v.page_views, v.pages, v.ua, v.last_path,
         (SELECT COALESCE(SUM(dwell),0) FROM pageviews WHERE vid = v.vid) AS dwell
  FROM visitors v
  ORDER BY v.last_seen DESC
  LIMIT ?
`);
const visitorDetail = db.prepare(`
  SELECT path, title, ts, ip, dwell FROM pageviews WHERE vid = ? ORDER BY ts DESC LIMIT ?
`);
const feedbackCount = db.prepare(`SELECT COUNT(*) AS c FROM feedback WHERE status = 'new'`);

const hardcorePages = db.prepare(`
  SELECT path, COUNT(*) AS views, COUNT(DISTINCT vid) AS uv,
         COALESCE(SUM(dwell),0) AS dwell, ROUND(AVG(dwell),1) AS avgDwell
  FROM pageviews
  WHERE path LIKE '/l/%'
  GROUP BY path
  ORDER BY avgDwell DESC, views DESC
  LIMIT ?
`);
const recentPageviewsStmt = db.prepare(`
  SELECT id, vid, path, title, ip, ts, dwell FROM pageviews ORDER BY id DESC LIMIT ?
`);

// 在线窗口：最近 30 分钟内有过浏览(track 会刷新 last_seen)的访客算「正在学习」
export const ONLINE_WINDOW_MS = 30 * 60 * 1000;

// 真实地图节点：按城市聚合在线访客，并给出该城市最近浏览的讲
const onlineCitiesStmt = db.prepare(`
  SELECT city, country, lat, lng,
         COUNT(*) AS learners,
         (SELECT title FROM pageviews p WHERE p.vid IN (
            SELECT vid FROM visitors WHERE city = v.city AND city != ''
          ) ORDER BY p.ts DESC LIMIT 1) AS latestLecture
  FROM visitors v
  WHERE city != '' AND lat IS NOT NULL AND lng IS NOT NULL
        AND last_seen >= ?
  GROUP BY city, country, lat, lng
  ORDER BY learners DESC
`);
// 在线人数：窗口内独立访客
const onlineCountStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM visitors WHERE last_seen >= ?
`);
// 窗口内有地理信息的独立访客数（用于「已定位」提示）
const onlineLocatedStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM visitors
  WHERE last_seen >= ? AND city != '' AND lat IS NOT NULL AND lng IS NOT NULL
`);

/** 返回在线人数与按城市聚合的真实地图节点。 */
export function getLivePresence() {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  const rows = onlineCitiesStmt.all(since);
  // 等距柱状投影：经纬度 -> 地图百分比坐标（与 index.html 的浅色世界地图一致）
  const nodes = rows.map((r) => ({
    name: r.city,
    country: r.country || '',
    x: Math.round(((r.lng + 180) / 360) * 1000) / 10,
    y: Math.round(((90 - r.lat) / 180) * 1000) / 10,
    learners: r.learners,
    latestLecture: r.latestLecture || '',
  }));
  return {
    onlineCount: onlineCountStmt.get(since).c,
    locatedCount: onlineLocatedStmt.get(since).c,
    mapNodes: nodes,
  };
}

export function getHardcoreLectures(limit = 6) {
  const rows = hardcorePages.all(limit);
  return rows.map((r) => ({ ...r, title: latestTitle.get(r.path)?.title || '' }));
}

export function getRecentPageviews(limit = 15) {
  return recentPageviewsStmt.all(limit);
}

export function getDashboard() {
  const nowIso = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const startDay = new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const t = kpiOne.get();
  const td = kpiSince.get(dayAgo);
  const tw = kpiSince.get(weekAgo);
  const nv = visitorsSince.get(weekAgo).u;
  const ret = returnRate.get().c;
  const total = totalVisitors.get().c;
  const fb = feedbackCount.get().c;
  const dw = dwellAgg.get();
  const series = dailySeries.all(startDay);
  const hardcore = getHardcoreLectures(6);
  const recent = getRecentPageviews(15);

  return {
    kpi: {
      totalPv: t.c,
      totalUv: t.u,
      today: td.c,
      todayUv: td.u,
      weekPv: tw.c,
      weekUv: tw.u,
      newVisitors: nv,
      totalVisitors: total,
      returnRate: total ? Math.round((ret / total) * 100) : 0,
      newFeedback: fb,
      avgDwell: dw.a, totalDwell: dw.s,
    },
    series,
    hardcore,
    recent,
    ...getLivePresence(),
  };
}

export function getLectureRanking(limit = 25) {
  const rows = topPages.all('/l/%', limit);
  return rows.map((r) => ({ ...r, title: latestTitle.get(r.path)?.title || '' }));
}

export function getVisitorList(limit = 100) {
  return visitorList.all(limit).map((v) => ({ ...v, pages: JSON.parse(v.pages || '[]') }));
}

export function getVisitorDetail(vid, limit = 200) {
  return visitorDetail.all(vid, limit);
}

/* ---------- 反馈 ---------- */

export function addFeedback({ vid, kind, content, page, contact, ua }) {
  const info = db.prepare(`
    INSERT INTO feedback (vid, kind, content, page, contact, ua, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(vid, kind || '', content, page || '', contact || '', ua || '', new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function listFeedback(status) {
  if (status && status !== 'all') {
    return db.prepare(`
      SELECT id, vid, kind, content, page, contact, ua, ts, status
      FROM feedback WHERE status = ? ORDER BY ts DESC LIMIT 500
    `).all(status);
  }
  return db.prepare(`
    SELECT id, vid, kind, content, page, contact, ua, ts, status
    FROM feedback ORDER BY ts DESC LIMIT 500
  `).all();
}

export function setFeedbackStatus(id, status) {
  db.prepare(`UPDATE feedback SET status = ? WHERE id = ?`).run(status, id);
}

/* ---------- 会话（后台登录） ---------- */

export function createSession(token, expiresAt) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)`).run(token, now, expiresAt);
}

export function validSession(token) {
  if (!token) return false;
  const row = db.prepare(`SELECT expires_at FROM sessions WHERE token = ?`).get(token);
  if (!row) return false;
  return Date.parse(row.expires_at) > Date.now();
}

export function deleteSession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

