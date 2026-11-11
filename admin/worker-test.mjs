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
await call('POST', '/api/track', { vid: 'v1', path: '/l/4', title: '线性变换' });
await call('POST', '/api/track', { vid: 'v2', path: '/l/3', title: '矩阵乘法' });

// 1.5 健康诊断（无需登录）
r = await call('GET', '/api/health');
assert('health 返回 admin:true', r.status === 200 && r.data.admin === true, JSON.stringify(r.data));

// 2. 后台未登录 → 401
assert('未登录 stats → 401', (await call('GET', '/api/admin/stats')).status === 401);

// 3. 登录
r = await call('POST', '/api/admin/login', { password: 'fuyao' });
assert('正确口令登录返回 token', r.status === 200 && r.data && r.data.token, JSON.stringify(r.data));
const token = r.data.token;
assert('错误口令 → 401', (await call('POST', '/api/admin/login', { password: 'wrong' })).status === 401);

// 4. 统计
r = await call('GET', '/api/admin/stats', null, token);
assert('stats 返回 200', r.status === 200, JSON.stringify(r.data));
assert('总PV=3', r.data.kpi.totalPv === 3, 'totalPv=' + r.data.kpi.totalPv);
assert('总UV=2', r.data.kpi.totalUv === 2, 'totalUv=' + r.data.kpi.totalUv);
assert('回访=0(同窗口内不算回访)', r.data.kpi.returnRate === 0, 'returnRate=' + r.data.kpi.returnRate);
assert('走势14天', r.data.series.length === 14, 'len=' + r.data.series.length);

// 5. 每讲热度
r = await call('GET', '/api/admin/lectures', null, token);
assert('lectures 返回 list', r.status === 200 && Array.isArray(r.data.list), JSON.stringify(r.data));
const l3 = r.data.list.find((x) => x.path === '/l/3');
assert('标题补全=矩阵乘法', l3 && l3.title === '矩阵乘法', JSON.stringify(l3));
assert('/l/3 views=2', l3 && l3.views === 2, 'views=' + (l3 && l3.views));

// 6. 访客列表
r = await call('GET', '/api/admin/visitors?limit=10', null, token);
assert('visitors 有 2 条', r.status === 200 && r.data.list.length === 2, JSON.stringify(r.data));
assert('visitors 带 ip 字段', r.data.list.every((v) => 'ip' in v));

// 7. 访客明细
r = await call('GET', '/api/admin/visitors?vid=v1', null, token);
assert('明细最新为 /l/4', r.data.detail[0].path === '/l/4', JSON.stringify(r.data.detail));

// 8. 反馈
r = await call('POST', '/api/feedback', { vid: 'v1', kind: 'error', content: '测试反馈', page: '/l/3' });
assert('提交反馈返回 id', r.status === 200 && r.data && r.data.id, JSON.stringify(r.data));
const fid = r.data.id;
r = await call('GET', '/api/admin/feedback?status=new', null, token);
assert('new 列表 1 条', r.data.list.length === 1, JSON.stringify(r.data.list));
assert('标记 done', (await call('POST', `/api/admin/feedback/${fid}`, { status: 'done' }, token)).status === 200);
r = await call('GET', '/api/admin/feedback?status=done', null, token);
assert('done 列表 1 条', r.data.list.length === 1, JSON.stringify(r.data.list));

// 9. me / logout
assert('me ok', (await call('GET', '/api/admin/me', null, token)).status === 200);
assert('logout ok', (await call('POST', '/api/admin/logout', null, token)).status === 200);
assert('登出后 stats → 401', (await call('GET', '/api/admin/stats', null, token)).status === 401);

// 10. 路由
const admin = await call('GET', '/admin');
assert('/admin 无斜杠 → 302', admin.status === 302, 'status=' + admin.status);
assert('/admin → Location /admin/', admin.headers.get('location') === '/admin/');
assert('站点路径走 ASSETS → 200', (await call('GET', '/')).status === 200);

console.log('');
console.log(fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
