// 运营后台服务：零 npm 依赖（只用 Node 内置 http + node:sqlite）。
// 运行：node server.js
// 默认监听 8787，后台页在 /admin，统计/反馈接口在 /api/*。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, recordVisit, addDwell, getDashboard, getLectureRanking, getLivePresence,
  getVisitorList, getVisitorDetail,
  addFeedback, listFeedback, setFeedbackStatus, setFeedbackReply, listPublicBoard,
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

/* ---------- 实时多人连接 & 学习脉搏广播 (SSE) ---------- */
const sseClients = new Map();
const COLOR_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#f43f5e', '#6366f1'];

function broadcastSSE(event, data, excludeId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of sseClients.entries()) {
    if (excludeId && id === excludeId) continue;
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(id);
    }
  }
}

// 定时心跳保活
setInterval(() => {
  for (const [id, client] of sseClients.entries()) {
    try { client.res.write(': ping\n\n'); } catch { sseClients.delete(id); }
  }
}, 15000);

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
  return 'no-auth'; // 免密访问
}
function pathFrom(trackPath) { return trackPath || ''; }
// 取客户端 IP：优先 X-Forwarded-For（反代/网关），其次 socket 地址；去掉 IPv4 映射前缀
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const first = (xff.split(',')[0] || '').trim();
  const ip = first || req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
// 从网关/CDN 注入的请求头解析地理位置（Cloudflare、Vercel、nginx GeoIP 等）。
// CDN 通常只给国家码，城市/经纬度视服务而定；取不到就留空，宁可少显示也不造假。
function getGeo(req) {
  const h = req.headers;
  const pick = (...keys) => { for (const k of keys) { const v = h[k]; if (v) return Array.isArray(v) ? v[0] : v; } return ''; };
  const country = String(pick('cf-ipcountry', 'x-vercel-ip-country', 'x-country-code', 'cf-ipcountry') || '').toUpperCase();
  const city = String(pick('cf-ipcity', 'x-vercel-ip-city', 'x-city') || '');
  const lat = Number(pick('x-vercel-ip-latitude', 'cf-iplatitude'));
  const lng = Number(pick('x-vercel-ip-longitude', 'cf-iplongitude'));
  return {
    country: country === 'XX' || country === 'T1' ? '' : country,
    city,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
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
    // 实时 SSE 连接流
    if (url.pathname === '/api/live/stream' && req.method === 'GET') {
      const qId = url.searchParams.get('id');
      const clientId = qId || `usr_${randomBytes(3).toString('hex')}`;
      const color = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
      const name = `工程师 #${clientId.slice(-4)}`;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      });

      const client = { id: clientId, color, name, res };
      sseClients.set(clientId, client);

      // 发送当前连接自身信息以及在线人数
      res.write(`event: init\ndata: ${JSON.stringify({
        myId: clientId,
        myColor: color,
        myName: name,
        onlineCount: Math.max(sseClients.size, 1),
      })}\n\n`);

      // 广播给其他人有新工程师加入
      broadcastSSE('user_join', { id: clientId, color, name, onlineCount: Math.max(sseClients.size, 1) }, clientId);

      req.on('close', () => {
        sseClients.delete(clientId);
        broadcastSSE('user_leave', { id: clientId, onlineCount: Math.max(sseClients.size, 1) });
      });
      return;
    }

    // 实时鼠标坐标广播
    if (url.pathname === '/api/live/cursor' && req.method === 'POST') {
      const body = await readBody(req);
      const { id, x, y, name, color } = body;
      if (id && x !== undefined && y !== undefined) {
        broadcastSSE('cursor', { id, x, y, name, color }, id);
      }
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/track' && req.method === 'POST') {
      const body = await readBody(req);
      const vid = (body.vid || '').toString();
      if (!vid) return send(res, 400, { error: 'missing vid' });
      const clientIp = getClientIp(req);
      const geo = getGeo(req);
      const id = recordVisit({
        vid,
        path: (body.path || '').toString().slice(0, 500),
        title: (body.title || '').toString().slice(0, 300),
        ua: (req.headers['user-agent'] || '').slice(0, 300),
        ref: (req.headers.referer || '').slice(0, 500),
        ip: clientIp,
        ...geo,
      });

      return send(res, 200, { ok: true, id });
    }

    if (url.pathname === '/api/dwell' && req.method === 'POST') {
      const body = await readBody(req);
      const id = Number(body.id);
      const dt = Math.round(Number(body.dt) || 0);
      const vid = (body.vid || '').toString();
      if (!id || !(dt > 0)) return send(res, 400, { error: 'bad payload' });
      addDwell({ vid, id, dt });
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

    // 公开留言板：任何人可读，仅返回可公开字段（不含联系方式 / IP / UA / vid）
    if (url.pathname === '/api/board' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 100);
      return send(res, 200, { list: listPublicBoard(limit) });
    }

    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      const token = 'no-auth';
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
      // getDashboard 内已包含真实的在线人数、定位数与按城市聚合的地图节点（见 db.js getLivePresence）
      return send(res, 200, getDashboard());
    }
    if (url.pathname === '/api/admin/presence' && req.method === 'GET') {
      // 轻量：只查在线人数与城市分布，供前端每 3 分钟轮询，避免反复触发重聚合
      return send(res, 200, getLivePresence());
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
    // 管理员回复（先于状态变更匹配，路径更具体）；需管理密码
    const replyM = url.pathname.match(/^\/api\/admin\/feedback\/(\d+)\/reply$/);
    if (replyM && req.method === 'POST') {
      const expected = config.adminPassword || '';
      if (!expected) return send(res, 500, { error: 'no_admin_password', message: '服务端未配置管理密码' });
      const body = await readBody(req);
      if (String(body.password || '') !== expected) {
        return send(res, 401, { error: 'bad_password', message: '管理密码错误' });
      }
      setFeedbackReply(Number(replyM[1]), body.reply);
      return send(res, 200, { ok: true });
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
  console.log(`\n运营后台已启动`);
  console.log(`  后台页面  http://localhost:${config.port}/admin（已开启免密访问）`);
  console.log(`  统计接口  http://localhost:${config.port}/api/*`);
  console.log(`  访问数据  ${__dirname}/data/app.db\n`);
});
