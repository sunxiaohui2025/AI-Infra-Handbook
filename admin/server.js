// 运营后台服务：零 npm 依赖（只用 Node 内置 http + node:sqlite）。
// 运行：node server.js
// 默认监听 8787，后台页在 /admin，统计/反馈接口在 /api/*。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, recordVisit, getDashboard, getLectureRanking,
  getVisitorList, getVisitorDetail,
  addFeedback, listFeedback, setFeedbackStatus,
  createSession, validSession, deleteSession,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const CONFIG_PATH = join(__dirname, 'config.json');

/* ---------- 配置 ---------- */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
function loadConfig() {
  let cfg = {
    port: Number(process.env.PORT || 8787),
    allowedOrigins: ['*'],
  };
  if (existsSync(CONFIG_PATH)) {
    try { cfg = { ...cfg, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
  } else {
    // 首次运行：生成随机口令写入 config.json，避免使用已知默认值
    cfg.adminPassword = randomBytes(6).toString('base64url');
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  }
  // 环境变量优先
  if (process.env.ADMIN_PASSWORD) cfg.adminPassword = process.env.ADMIN_PASSWORD;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  return cfg;
}
const config = loadConfig();

const SESSION_TTL_MS = 12 * 3600 * 1000; // 后台登录有效期 12 小时
const MAX_BODY = 64 * 1024;               // 请求体上限 64KB

/* ---------- 通用工具 ---------- */
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const cors = config.allowedOrigins.includes('*')
    ? '*'
    : (headers.origin && config.allowedOrigins.includes(headers.origin) ? headers.origin : '');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': cors,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function requireAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return validSession(token) ? token : null;
}
function pathFrom(trackPath) { return trackPath || ''; }
// 取客户端 IP：优先 X-Forwarded-For（反代/网关），其次 socket 地址；去掉 IPv4 映射前缀
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const first = (xff.split(',')[0] || '').trim();
  const ip = first || req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/* ---------- 静态文件（后台页面） ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
async function serveStatic(url, res) {
  let p = url.pathname;
  if (p === '/' || p === '/admin' || p === '/admin/') p = '/admin/index.html';
  if (p.startsWith('/admin/')) p = p.slice('/admin'.length);
  // 只允许访问 public/ 下的文件，防目录穿越
  const file = normalize(join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    // SPA：任何未知 /admin/* 都回首页，前端自行路由
    const html = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

/* ---------- 路由 ---------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin || '';

  // 预检
  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  // 后台页面
  if (url.pathname.startsWith('/admin') || url.pathname === '/') {
    return serveStatic(url, res);
  }

  try {
    if (url.pathname === '/api/track' && req.method === 'POST') {
      const body = await readBody(req);
      const vid = (body.vid || '').toString();
      if (!vid) return send(res, 400, { error: 'missing vid' });
      recordVisit({
        vid,
        path: (body.path || '').toString().slice(0, 500),
        title: (body.title || '').toString().slice(0, 300),
        ua: (req.headers['user-agent'] || '').slice(0, 300),
        ref: (req.headers.referer || '').slice(0, 500),
        ip: getClientIp(req),
      });
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      const body = await readBody(req);
      const content = (body.content || '').toString().trim();
      if (!content) return send(res, 400, { error: 'empty content' });
      const id = addFeedback({
        vid: (body.vid || '').toString(),
        kind: (body.kind || '').toString().slice(0, 20),
        content: content.slice(0, 2000),
        page: (body.page || '').toString().slice(0, 300),
        contact: (body.contact || '').toString().slice(0, 200),
        ua: (req.headers['user-agent'] || '').slice(0, 300),
      });
      return send(res, 200, { ok: true, id });
    }

    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await readBody(req);
      const pw = (body.password || '').toString();
      const a = Buffer.from(pw), b = Buffer.from(config.adminPassword);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return send(res, 401, { error: '口令错误' });
      }
      const token = randomBytes(32).toString('hex');
      createSession(token, new Date(Date.now() + SESSION_TTL_MS).toISOString());
      return send(res, 200, { ok: true, token, expires: SESSION_TTL_MS });
    }

    // 以下均为需要登录的后台接口
    const token = requireAuth(req);
    if (!token) return send(res, 401, { error: '未登录' });

    if (url.pathname === '/api/admin/me' && req.method === 'GET') {
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
      deleteSession(token);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
      return send(res, 200, getDashboard());
    }
    if (url.pathname === '/api/admin/lectures' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 25), 50);
      return send(res, 200, getLectureRanking(limit));
    }
    if (url.pathname === '/api/admin/visitors' && req.method === 'GET') {
      const vid = url.searchParams.get('vid');
      if (vid) return send(res, 200, { detail: getVisitorDetail(vid) });
      const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
      return send(res, 200, { list: getVisitorList(limit) });
    }
    if (url.pathname === '/api/admin/feedback' && req.method === 'GET') {
      const status = url.searchParams.get('status') || 'all';
      return send(res, 200, { list: listFeedback(status) });
    }
    if (url.pathname.startsWith('/api/admin/feedback/') && req.method === 'POST') {
      const id = Number(url.pathname.split('/').pop());
      const body = await readBody(req);
      if (!id) return send(res, 400, { error: 'bad id' });
      setFeedbackStatus(id, ['new', 'done', 'ignored'].includes(body.status) ? body.status : 'new');
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: 'server error', message: e.message });
  }
});

server.listen(config.port, () => {
  const pwHint = config.adminPassword;
  console.log(`\n运营后台已启动`);
  console.log(`  后台页面  http://localhost:${config.port}/admin`);
  console.log(`  统计接口  http://localhost:${config.port}/api/*`);
  console.log(`  当前口令  ${pwHint}  （改 admin/config.json 的 adminPassword，或设环境变量 ADMIN_PASSWORD）`);
  console.log(`  访问数据  ${__dirname}/data/app.db\n`);
});
