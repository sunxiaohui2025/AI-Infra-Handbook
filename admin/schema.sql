-- AI Infra 课程 · 运营后台 D1 表结构
-- 用 `wrangler d1 execute <DB名称> --remote --file=./admin/schema.sql` 初始化。
-- 与 admin/db.js 里的表一致（id 用 INTEGER PRIMARY KEY，SQLite 自动自增，D1 兼容）。

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
  id    INTEGER PRIMARY KEY,
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
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pv_vid   ON pageviews(vid);
CREATE INDEX IF NOT EXISTS idx_pv_path  ON pageviews(path);
CREATE INDEX IF NOT EXISTS idx_pv_ts    ON pageviews(ts);
CREATE INDEX IF NOT EXISTS idx_fb_status ON feedback(status);
-- 在线状态/城市聚合与 KPI 高频过滤字段：走索引，避免全表扫描抬高 D1 rows_read
CREATE INDEX IF NOT EXISTS idx_v_last_seen  ON visitors(last_seen);
CREATE INDEX IF NOT EXISTS idx_v_first_seen ON visitors(first_seen);
CREATE INDEX IF NOT EXISTS idx_v_visit_count ON visitors(visit_count);
-- 跨 isolate 持久缓存表 + schema 版本表（Worker 端用于避免每次请求跑 DDL）
CREATE TABLE IF NOT EXISTS stats_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);

-- 覆盖索引：按天序列 / WHERE ts>=? 可直接从索引取 vid、dwell，避免回表。
-- 注意：它引用了 dwell 列。若是给「早期旧库」补跑本文件，需先单独执行
--   ALTER TABLE pageviews ADD COLUMN dwell INTEGER NOT NULL DEFAULT 0;
-- 正常部署无需手动处理：Worker 的 ensureTables() 会先补列、再建索引。
CREATE INDEX IF NOT EXISTS idx_pv_ts_vid_dwell ON pageviews(ts, vid, dwell);
