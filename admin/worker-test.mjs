// 本地验证 admin/worker.js：用 node:sqlite 模拟 D1 接口，跑通全部 /api 路由。
// 运行：node admin/worker-test.mjs（Node 22.5+）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './worker.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// 模拟 D1 的 prepare().bind().all()/first()/run()
function makeMockD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let bound = [];
      const api = {
        bind(...args) { bound = args; return api; },
        async all() { return { results: stmt.all(...bound), success: true }; },
        async first() { const r = stmt.get(...bound); return r ?? null; },
        async run() {
          const r = stmt.run(...bound);
          return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) }, results: r };
        },
      };
      return api;
    },
    // D1 的 batch：接收若干已 prepare 的语句，逐个执行
    async batch(stmts) {
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return { results, success: true };
    },
  };
}

const env = {
  DB: makeMockD1(db),
  ASSETS: { fetch: () => new Response('static', { status: 200 }) },
  ADMIN_PASSWORD: 'fuyao',
};

const call = async (method, path, body, token) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = 'Bearer ' + token;
  const req = new Request('https://example.com' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, data, text };
};

let fail = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) { console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); fail++; }
  else console.log('  ✓ ' + name);
};

// 1. 埋点
let r = await call('POST', '/api/track', { vid: 'v1', path: '/l/3', title: '矩阵乘法' });
assert('track 缺失 vid → 400', (await call('POST', '/api/track', {})).status === 400);
assert('track 返回 ok', r.status === 200 && r.data && r.data.ok, JSON.stringify(r.data));
const pv1l3 = r.data.id;
assert('track 返回 pageview id', !!pv1l3, 'id=' + pv1l3);
await call('POST', '/api/track', { vid: 'v1', path: '/l/4', title: '线性变换' });
await call('POST', '/api/track', { vid: 'v2', path: '/l/3', title: '矩阵乘法' });

// 1.5 健康诊断（无需登录）
r = await call('GET', '/api/health');
assert('health 返回 admin:true', r.status === 200 && r.data.admin === true, JSON.stringify(r.data));

// 1.6 停留时长心跳
r = await call('POST', '/api/dwell', { vid: 'v1', id: pv1l3, dt: 45 });
assert('dwell 累加 ok', r.status === 200 && r.data.ok, JSON.stringify(r.data));
assert('dwell 缺 id → 400', (await call('POST', '/api/dwell', { vid: 'v1', dt: 5 })).status === 400);
assert('异 vid 不能改他人 dwell(仍 ok)', (await call('POST', '/api/dwell', { vid: 'zz', id: pv1l3, dt: 10 })).status === 200);

// 2. 后台免密访问：未登录也能读 stats
assert('未登录 stats → 200(免密)', (await call('GET', '/api/admin/stats')).status === 200);

// 3. 登录（免密模式：任意口令都返回 token）
r = await call('POST', '/api/admin/login', { password: 'fuyao' });
assert('登录返回 token', r.status === 200 && r.data && r.data.token, JSON.stringify(r.data));
const token = r.data.token;
assert('任意口令也返回 token(免密)', (await call('POST', '/api/admin/login', { password: 'wrong' })).status === 200);

// 4. 统计
r = await call('GET', '/api/admin/stats', null, token);
assert('stats 返回 200', r.status === 200, JSON.stringify(r.data));
assert('总PV=3', r.data.kpi.totalPv === 3, 'totalPv=' + r.data.kpi.totalPv);
assert('总UV=2', r.data.kpi.totalUv === 2, 'totalUv=' + r.data.kpi.totalUv);
assert('累计停留=45', r.data.kpi.totalDwell === 45, 'totalDwell=' + r.data.kpi.totalDwell);
assert('平均停留=15', r.data.kpi.avgDwell === 15, 'avgDwell=' + r.data.kpi.avgDwell);
assert('回访=0(同窗口内不算回访)', r.data.kpi.returnRate === 0, 'returnRate=' + r.data.kpi.returnRate);
assert('走势30天', r.data.series.length === 30, 'len=' + r.data.series.length);
assert('stats 含在线人数', typeof r.data.onlineCount === 'number', 'onlineCount=' + r.data.onlineCount);
assert('stats 含真实地图节点数组', Array.isArray(r.data.mapNodes), JSON.stringify(r.data.mapNodes));

// 5. 每讲热度
r = await call('GET', '/api/admin/lectures', null, token);
assert('lectures 返回 list', r.status === 200 && Array.isArray(r.data.list), JSON.stringify(r.data));
const l3 = r.data.list.find((x) => x.path === '/l/3');
assert('标题补全=矩阵乘法', l3 && l3.title === '矩阵乘法', JSON.stringify(l3));
assert('/l/3 views=2', l3 && l3.views === 2, 'views=' + (l3 && l3.views));
assert('/l/3 dwell=45', l3 && l3.dwell === 45, 'dwell=' + (l3 && l3.dwell));
assert('/l/3 avgDwell=22.5', l3 && l3.avgDwell === 22.5, 'avgDwell=' + (l3 && l3.avgDwell));

// 6. 访客列表
r = await call('GET', '/api/admin/visitors?limit=10', null, token);
assert('visitors 有 2 条', r.status === 200 && r.data.list.length === 2, JSON.stringify(r.data));
assert('visitors 带 ip 字段', r.data.list.every((v) => 'ip' in v));
const vv1 = r.data.list.find((v) => v.vid === 'v1');
assert('v1 停留=45', vv1 && vv1.dwell === 45, 'dwell=' + (vv1 && vv1.dwell));

// 7. 访客明细
r = await call('GET', '/api/admin/visitors?vid=v1', null, token);
assert('明细最新为 /l/4', r.data.detail[0].path === '/l/4', JSON.stringify(r.data.detail));
assert('明细带 dwell 字段', r.data.detail.every((p) => 'dwell' in p));

// 8. 反馈
r = await call('POST', '/api/feedback', { vid: 'v1', kind: 'error', content: '测试反馈', page: '/l/3' });
assert('提交反馈返回 id', r.status === 200 && r.data && r.data.id, JSON.stringify(r.data));
const fid = r.data.id;
r = await call('GET', '/api/admin/feedback?status=new', null, token);
assert('new 列表 1 条', r.data.list.length === 1, JSON.stringify(r.data.list));
assert('标记 done', (await call('POST', `/api/admin/feedback/${fid}`, { status: 'done' }, token)).status === 200);
r = await call('GET', '/api/admin/feedback?status=done', null, token);
assert('done 列表 1 条', r.data.list.length === 1, JSON.stringify(r.data.list));

// 8.1 status=all 必须返回全部（回归 bug：曾把 'all' 当真实状态过滤，导致列表为空）
r = await call('GET', '/api/admin/feedback?status=all', null, token);
assert('status=all 返回全部 1 条', r.data.list.length === 1, JSON.stringify(r.data.list));

// 8.2 公开留言板：可读、含内容与回复字段、不含隐私字段
r = await call('GET', '/api/board');
assert('留言板可公开读取', r.status === 200 && Array.isArray(r.data.list), JSON.stringify(r.data));
const b0 = r.data.list.find((x) => x.id === fid);
assert('留言板含该留言内容', b0 && b0.content === '测试反馈', JSON.stringify(b0));
assert('留言板不含 contact/vid/ua/ip', b0 && !('contact' in b0) && !('vid' in b0) && !('ua' in b0) && !('ip' in b0), Object.keys(b0 || {}).join(','));

// 8.3 管理员回复：密码错误拒绝，正确密码成功，且回复公开可见
assert('回复-密码错误 → 401', (await call('POST', `/api/admin/feedback/${fid}/reply`, { password: 'wrong', reply: 'x' })).status === 401);
r = await call('POST', `/api/admin/feedback/${fid}/reply`, { password: 'fuyao', reply: '已收到，会尽快修复。' });
assert('回复-正确密码 → 200', r.status === 200 && r.data.ok, JSON.stringify(r.data));
r = await call('GET', '/api/board');
const b1 = r.data.list.find((x) => x.id === fid);
assert('回复已公开显示', b1 && b1.reply === '已收到，会尽快修复。', JSON.stringify(b1));
assert('回复带 reply_at 时间', b1 && !!b1.reply_at, JSON.stringify(b1 && b1.reply_at));
r = await call('GET', '/api/admin/feedback?status=all', null, token);
const a1 = r.data.list.find((x) => x.id === fid);
assert('回复后自动标记 done', a1 && a1.status === 'done', JSON.stringify(a1));

// 9. me / logout
assert('me ok', (await call('GET', '/api/admin/me', null, token)).status === 200);
assert('logout ok', (await call('POST', '/api/admin/logout', null, token)).status === 200);
assert('登出后 stats 仍可读(免密)', (await call('GET', '/api/admin/stats', null, token)).status === 200);

// 10. 路由
const admin = await call('GET', '/admin');
assert('/admin 无斜杠 → 302', admin.status === 302, 'status=' + admin.status);
assert('/admin → Location /admin/', admin.headers.get('location') === '/admin/');
assert('站点路径走 ASSETS → 200', (await call('GET', '/')).status === 200);

// 11. 旧 schema 迁移：pageviews 没有 dwell 列时，首次请求自动补列（不走 pragma，用 try/catch）
{
  // 用带 query 的动态 import 拿到全新的 worker 模块（schemaPromise 单例为 null），
  // 才能让 ensureTables 真正在旧库上跑。生产是单隔离单 env，不涉及此问题。
  const workerFresh = (await import('./worker.js?mig=' + Date.now())).default;
  const old = new DatabaseSync(':memory:');
  old.exec(`
    CREATE TABLE visitors (
      vid TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 1, page_views INTEGER NOT NULL DEFAULT 0,
      pages TEXT NOT NULL DEFAULT '[]', ua TEXT NOT NULL DEFAULT '',
      last_ref TEXT NOT NULL DEFAULT '', last_path TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE pageviews (
      id INTEGER PRIMARY KEY, vid TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      ua TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL, ip TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE feedback (
      id INTEGER PRIMARY KEY, vid TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL, page TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
      ua TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new'
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
  `);
  const oldEnv = {
    DB: makeMockD1(old),
    ASSETS: { fetch: () => new Response('static', { status: 200 }) },
    ADMIN_PASSWORD: 'fuyao',
  };
  const rr = await workerFresh.fetch(new Request('https://example.com/api/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vid: 'm1', path: '/l/9', title: '迁移测试' }),
  }), oldEnv);
  assert('旧库 track 成功(自动迁移)', rr.status === 200, 'status=' + rr.status);
  const cols = old.prepare(`SELECT name FROM pragma_table_info('pageviews')`).all().map((r) => r.name);
  assert('迁移后 pageviews 有 dwell 列', cols.includes('dwell'), cols.join(','));
  const row = old.prepare(`SELECT dwell FROM pageviews WHERE vid = 'm1'`).get();
  assert('迁移后 dwell 默认 0', row && row.dwell === 0, JSON.stringify(row));
  const meta = old.prepare(`SELECT v FROM schema_meta WHERE k = 'schema'`).get();
  assert('迁移后写入 schema_meta 版本 2', meta && meta.v === 2, JSON.stringify(meta));
  const idx = old.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pv_ts_vid_dwell'`).get();
  assert('补列后才建成依赖 dwell 的覆盖索引', !!idx, JSON.stringify(idx));
  const cacheTbl = old.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stats_cache'`).get();
  assert('迁移后补建 stats_cache 表', !!cacheTbl, JSON.stringify(cacheTbl));

  // 版本已是最新时，新的 isolate 必须直接跳过全部 DDL（旧 bug：每次请求都跑 ALTER）。
  // 把版本改成 999：若仍在跑初始化，末尾会把版本写回 2。
  old.prepare(`UPDATE schema_meta SET v = 999 WHERE k = 'schema'`).run();
  const oldEnv2 = {
    DB: makeMockD1(old),
    ASSETS: { fetch: () => new Response('static', { status: 200 }) },
    ADMIN_PASSWORD: 'fuyao',
  };
  // 注意用 /api/board 而非 /api/health：health 在 ensureTables 之前就返回了
  const rr2 = await workerFresh.fetch(new Request('https://example.com/api/board'), oldEnv2);
  assert('版本已最新时请求正常', rr2.status === 200, 'status=' + rr2.status);
  const meta2 = old.prepare(`SELECT v FROM schema_meta WHERE k = 'schema'`).get();
  assert('新 isolate 跳过重复 DDL', meta2 && meta2.v === 999, 'v=' + (meta2 && meta2.v));
}

// 12. 真实地理位置：模拟 Cloudflare request.cf，验证按城市聚合到地图节点
//     用独立内存库：stats 结果会持久化到 D1 的 stats_cache（跨 isolate 共享），
//     复用主库会命中前面的旧快照，这里要验证的是全新隔离环境下的真实聚合。
{
  const geoDb = new DatabaseSync(':memory:');
  geoDb.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const geoEnv = {
    DB: makeMockD1(geoDb),
    ASSETS: { fetch: () => new Response('static', { status: 200 }) },
    ADMIN_PASSWORD: 'fuyao',
  };
  const trackWithCf = (vid, cf) => {
    const req = new Request('https://example.com/api/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vid, path: '/', title: '首页' }),
    });
    // Node 原生 Request 没有 cf，模拟 Cloudflare 注入的 request.cf
    Object.defineProperty(req, 'cf', { value: cf });
    return worker.fetch(req, geoEnv);
  };
  await trackWithCf('geo-bj', { country: 'CN', city: 'Beijing', latitude: '39.9042', longitude: '116.4074' });
  await trackWithCf('geo-bj2', { country: 'CN', city: 'Beijing', latitude: '39.9042', longitude: '116.4074' });
  await trackWithCf('geo-ny', { country: 'US', city: 'New York', latitude: '40.7128', longitude: '-74.0060' });
  const statsRes = await worker.fetch(new Request('https://example.com/api/admin/stats'), geoEnv);
  const gdata = await statsRes.json();
  const bj = gdata.mapNodes.find((n) => n.name === 'Beijing');
  const ny = gdata.mapNodes.find((n) => n.name === 'New York');
  assert('真实城市聚合：Beijing 2 人', bj && bj.learners === 2, JSON.stringify(bj));
  assert('经纬度→地图坐标：Beijing x≈82.3', bj && Math.abs(bj.x - 82.3) < 0.5, 'x=' + (bj && bj.x));
  assert('真实城市聚合：New York 1 人', ny && ny.learners === 1, JSON.stringify(ny));
  assert('经纬度→地图坐标：New York x≈29.4', ny && Math.abs(ny.x - 29.4) < 0.5, 'x=' + (ny && ny.x));
  assert('在线人数≥3', gdata.onlineCount >= 3, 'onlineCount=' + gdata.onlineCount);

  // 轻量 presence 接口：返回字段齐全，且与 stats 的在线数据一致（供前端高频轮询、不再触发重聚合）
  const presRes = await worker.fetch(new Request('https://example.com/api/admin/presence'), geoEnv);
  const pres = await presRes.json();
  assert('presence 接口 200', presRes.status === 200, 'status=' + presRes.status);
  assert('presence 含 onlineCount', typeof pres.onlineCount === 'number', JSON.stringify(pres));
  assert('presence 含 mapNodes', Array.isArray(pres.mapNodes), JSON.stringify(pres.mapNodes));
  assert('presence 与 stats 在线人数一致', pres.onlineCount === gdata.onlineCount,
    'presence=' + pres.onlineCount + ' stats=' + gdata.onlineCount);
  assert('presence 城市数与 stats 一致', pres.mapNodes.length === gdata.mapNodes.length);
}

// 13. D1 异常兜底：读额度耗尽时应返回可读 JSON（而非裸 1101）
{
  const badEnv = {
    DB: {
      prepare() { throw new Error('D1_ERROR: Exceeded maximum allowed rows read'); },
      batch() { throw new Error('D1_ERROR: Exceeded maximum allowed rows read'); },
    },
    ASSETS: { fetch: () => new Response('static', { status: 200 }) },
    ADMIN_PASSWORD: 'x',
  };
  const res = await worker.fetch(new Request('https://example.com/api/admin/stats'), badEnv);
  const data = await res.json().catch(() => ({}));
  assert('D1 异常 → 429', res.status === 429, 'status=' + res.status);
  assert('返回可读错误码', data.error === 'd1_read_quota_exceeded', JSON.stringify(data));
  assert('错误信息含中文提示', /额度/.test(String(data.message || '')), JSON.stringify(data.message));
}

// 14. 两级缓存：TTL 内不重算、跨 isolate 命中 L2、写操作失效、limit 不串缓存
{
  const cacheDb = new DatabaseSync(':memory:');
  cacheDb.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  // 标记为最新 schema，让每个新 env 跳过 DDL，专注观察全表聚合次数
  cacheDb.exec(`INSERT INTO schema_meta (k, v) VALUES ('schema', 2)`);
  const base = makeMockD1(cacheDb);
  let heavy = 0; // 含 COUNT() 且扫 pageviews 的全表聚合执行次数
  // 每个 env 都是新对象 → 模拟不同 isolate（各自独立的 L1 内存缓存）
  const mkEnv = () => ({
    DB: {
      prepare(sql) {
        if (/FROM pageviews/i.test(sql) && /COUNT\(/i.test(sql)) heavy++;
        return base.prepare(sql);
      },
      batch: (stmts) => base.batch(stmts),
    },
    ASSETS: { fetch: () => new Response('static', { status: 200 }) },
    ADMIN_PASSWORD: 'x',
  });
  const hit = async (e, path, method = 'GET', body) => {
    const res = await worker.fetch(new Request('https://example.com' + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }), e);
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const eA = mkEnv();
  const first = await hit(eA, '/api/admin/stats');
  assert('缓存用例 stats 返回 200', first.status === 200, 'status=' + first.status);
  const afterFirst = heavy;
  assert('首次 stats 触发全表聚合', afterFirst > 0, 'heavy=' + afterFirst);
  const sameIso = await hit(eA, '/api/admin/stats');
  assert('同 isolate 二次请求命中内存缓存(0 次重算)', heavy === afterFirst, 'heavy=' + heavy);
  assert('缓存返回一致结果', sameIso.data.kpi.totalPv === first.data.kpi.totalPv);

  const eB = mkEnv();
  const across = await hit(eB, '/api/admin/stats');
  assert('跨 isolate 命中 D1 持久缓存(0 次重算)', heavy === afterFirst, 'heavy=' + heavy);
  assert('跨 isolate 结果一致', across.data.kpi.totalPv === first.data.kpi.totalPv);
  const cachedRow = cacheDb.prepare(`SELECT value, updated_at FROM stats_cache WHERE key = 'stats'`).get();
  assert('stats 结果已持久化到 stats_cache', !!cachedRow && !!JSON.parse(cachedRow.value).kpi,
    JSON.stringify(cachedRow && cachedRow.updated_at));

  const w = await hit(eB, '/api/feedback', 'POST', { vid: 'c1', content: '缓存失效测试' });
  assert('写反馈成功', w.status === 200, 'status=' + w.status);
  const eC = mkEnv();
  const afterWrite = await hit(eC, '/api/admin/stats');
  assert('写操作后缓存失效并重新聚合', heavy > afterFirst, 'heavy=' + heavy);
  assert('新反馈计入 KPI', afterWrite.data.kpi.newFeedback >= 1,
    'newFeedback=' + afterWrite.data.kpi.newFeedback);

  await hit(eC, '/api/feedback', 'POST', { vid: 'c2', content: '第二条' });
  await hit(eC, '/api/feedback', 'POST', { vid: 'c3', content: '第三条' });
  const one = await hit(eC, '/api/board?limit=1');
  const many = await hit(eC, '/api/board?limit=100');
  assert('board?limit=1 只返回 1 条', one.data.list.length === 1, 'len=' + one.data.list.length);
  assert('board?limit=100 返回全部(缓存未串)', many.data.list.length === 3, 'len=' + many.data.list.length);

  // 排行榜用 MAX(ts) + bare column 一次扫描取最新标题，替代原来的相关子查询（N+1）
  cacheDb.exec(`INSERT INTO pageviews (vid, path, title, ua, ref, ts, ip, dwell) VALUES
    ('x1', '/l/77', '旧标题', '', '', '2026-01-01T00:00:00.000Z', '', 0),
    ('x1', '/l/77', '新标题', '', '', '2026-01-02T00:00:00.000Z', '', 10)`);
  const lec = await hit(mkEnv(), '/api/admin/lectures');
  const item = (lec.data.list || []).find((x) => x.path === '/l/77');
  assert('排行榜 title 取最新一条(MAX(ts) bare column)', item && item.title === '新标题', JSON.stringify(item));
  assert('排行榜聚合正确(views=2, dwell=10)', item && item.views === 2 && item.dwell === 10, JSON.stringify(item));
}

console.log('');
console.log(fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
