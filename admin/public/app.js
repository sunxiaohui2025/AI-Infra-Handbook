// AI Infra 学习脉搏 (Live Pulse) —— 前端逻辑
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const app = $('#app');
const cursorLayer = $('#cursorLayer');
let currentTab = 'overview';
let fbFilter = 'all';

// 本地客户端用户标识
const myStorageKey = 'ai_pulse_client_id';
let myId = localStorage.getItem(myStorageKey);
if (!myId) {
  myId = 'usr_' + Math.random().toString(36).slice(2, 8);
  localStorage.setItem(myStorageKey, myId);
}
let myColor = '#3b82f6';
let myName = '你 (当前工程师)';

/* ---------- 通用 API 请求 ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) throw new Error('unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------- 切换 Tab ---------- */
function setActiveTab(tab) {
  currentTab = tab;
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['overview', 'lectures', 'visitors', 'feedback'].forEach((t) => {
    const el = $('#tab-' + t);
    if (el) el.hidden = t !== tab;
  });
  if (tab === 'overview') loadOverview();
  if (tab === 'lectures') loadLectures();
  if (tab === 'visitors') loadVisitors();
  if (tab === 'feedback') loadFeedback();
}

/* ---------- 1. 实时脉搏总览 (地图 + 走势 + 硬核榜 + 动态流) ---------- */
let cachedMapNodes = [];

async function loadOverview() {
  const d = await api('/api/admin/stats');
  if (d.onlineCount) updateOnlineCount(d.onlineCount);
  renderKpis(d.kpi);
  renderMap(d.mapNodes || []);
  renderHardcore(d.hardcore || []);
  renderStreamInitial(d.recent || []);
  renderChart(d.series);
}

function updateOnlineCount(cnt) {
  const el = $('#onlineCount');
  if (el) el.textContent = Math.max(Number(cnt) || 1, 1);
}

/* 核心 KPI 卡片（恢复最初清晰统计维度） */
function renderKpis(k) {
  if (!k) return;
  const cards = [
    { k: '总访问量 (PV)', v: k.totalPv, h: `独立访客 ${k.totalUv}` },
    { k: '独立访客 (UV)', v: k.totalUv, h: `累计回访访客占比 ${k.returnRate}%` },
    { k: '今日访问', v: k.today, h: `今日独立访客 ${k.todayUv}` },
    { k: '近 7 天訪問', v: k.weekPv, h: `新增访客 ${k.newVisitors}` },
    { k: '平均停留', v: fmtDur(k.avgDwell), h: `累计停留 ${fmtDur(k.totalDwell)}` },
    { k: '待处理反馈', v: k.newFeedback, h: '需要你查看', cls: k.newFeedback > 0 ? '' : 'small' },
  ];
  $('#kpis').innerHTML = cards.map((c) =>
    `<div class="kpi"><div class="k">${c.k}</div><div class="v ${c.cls || ''}">${c.v}</div><div class="hint">${c.h}</div></div>`
  ).join('');
}

/* 全球学习地图渲染 */
function renderMap(nodes) {
  cachedMapNodes = nodes;
  const container = $('#mapBeacons');
  const tooltip = $('#mapTooltip');
  if (!container) return;

  $('#mapActiveCount').textContent = `${nodes.length} 个全球活跃节点`;

  container.innerHTML = nodes.map((n, i) => `
    <div class="beacon" style="left: ${n.x}%; top: ${n.y}%;" data-idx="${i}">
      <div class="beacon-ripple"></div>
      <div class="beacon-dot"></div>
      <div class="beacon-label">${n.name}</div>
    </div>
  `).join('');

  $$('.beacon', container).forEach((el) => {
    el.addEventListener('mouseenter', (e) => {
      const idx = Number(el.dataset.idx);
      const n = cachedMapNodes[idx];
      if (!n) return;
      tooltip.innerHTML = `
        <div class="tt-city">📍 ${n.name} (${n.country})</div>
        <div class="tt-info"><b>${n.learners}</b> 位工程师正在研读</div>
        <div class="tt-lec">最新动向：《${n.latestLecture}》</div>
      `;
      tooltip.style.left = `${n.x}%`;
      tooltip.style.top = `${n.y}%`;
      tooltip.style.display = 'block';
    });
    el.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  });
}

function flashBeaconByCoords(x, y) {
  const container = $('#mapBeacons');
  if (!container) return;
  const dot = document.createElement('div');
  dot.className = 'beacon';
  dot.style.left = `${x}%`;
  dot.style.top = `${y}%`;
  dot.innerHTML = `<div class="beacon-ripple" style="animation-duration: 1.2s; border-color: #38bdf8;"></div><div class="beacon-dot" style="background:#38bdf8; box-shadow:0 0 12px #38bdf8;"></div>`;
  container.appendChild(dot);
  setTimeout(() => dot.remove(), 2500);
}

/* 最硬核讲次榜（简洁大方，无花哨标星） */
function renderHardcore(list) {
  const el = $('#hardcoreList');
  if (!el) return;
  if (!list || !list.length) {
    el.innerHTML = '<div class="loading-hint">暂无研读时长积累</div>';
    return;
  }
  const rankClasses = ['rank-1', 'rank-2', 'rank-3', 'rank-other', 'rank-other', 'rank-other'];

  el.innerHTML = list.slice(0, 6).map((item, i) => {
    const lecNum = item.path.replace('/l/', '');
    const title = item.title || `第 ${lecNum} 讲`;
    return `
      <div class="hardcore-item">
        <div class="rank-badge ${rankClasses[i]}">${i + 1}</div>
        <div class="hc-title">
          <a href="${item.path}" target="_blank">${title}</a>
          <small>${item.views} 次浏览 · ${item.uv} 位读者推敲</small>
        </div>
        <div class="hc-dwell-time">平均 ${fmtDur(item.avgDwell || item.dwell)}</div>
      </div>
    `;
  }).join('');
}

/* 正在发生：实时动态流 */
function renderStreamInitial(recent) {
  const box = $('#liveStream');
  if (!box) return;
  if (!recent || !recent.length) {
    box.innerHTML = `
      <div class="stream-item">
        <i class="stream-dot"></i>
        <span class="stream-time">刚刚</span>
        <span class="stream-city">北京</span>
        <span class="stream-act">读者正在研读 <b>《第 67 讲 PagedAttention》</b></span>
      </div>
      <div class="stream-item">
        <i class="stream-dot"></i>
        <span class="stream-time">2 分钟前</span>
        <span class="stream-city">杭州</span>
        <span class="stream-act">读者在 <b>《第 40 讲 MLA 多头潜在注意力》</b> 深度推敲 18 分钟</span>
      </div>
      <div class="stream-item">
        <i class="stream-dot"></i>
        <span class="stream-time">5 分钟前</span>
        <span class="stream-city">硅谷</span>
        <span class="stream-act">工程师开始学习 <b>《第 93 讲 张量并行》</b></span>
      </div>
    `;
    return;
  }

  box.innerHTML = recent.slice(0, 10).map((r) => {
    const id = r.path?.replace('/l/', '') || '';
    const title = r.title || `第 ${id} 讲`;
    return `
      <div class="stream-item">
        <i class="stream-dot"></i>
        <span class="stream-time">${fmtTimeAgo(r.ts)}</span>
        <span class="stream-city">${r.ip ? '网络节点' : '全球读者'}</span>
        <span class="stream-act">研读了 <b>《${title}》</b></span>
      </div>
    `;
  }).join('');
}

function pushStreamEvent(evt) {
  const box = $('#liveStream');
  if (!box) return;
  const item = document.createElement('div');
  item.className = 'stream-item';
  const timeStr = '刚刚';
  const actText = evt.type === 'dwell'
    ? `在研读中停留推敲了 <b>${evt.dt} 秒</b>`
    : `正在研读 <b>《${evt.title || evt.path}》</b>`;

  item.innerHTML = `
    <i class="stream-dot"></i>
    <span class="stream-time">${timeStr}</span>
    <span class="stream-city">${evt.city || '全球节点'}</span>
    <span class="stream-act">${actText}</span>
  `;
  box.insertBefore(item, box.firstChild);
  if (box.children.length > 25) box.removeChild(box.lastChild);

  if (evt.x && evt.y) flashBeaconByCoords(evt.x, evt.y);
}

/* 近 30 天走势柱状图：柱顶显示当日 PV 数字 */
function renderChart(series) {
  const el = $('#chart');
  if (!series || !series.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const maxPv = Math.max(...series.map((s) => s.pv), 1);
  el.innerHTML = series.map((s) => {
    const h = Math.round((s.pv / maxPv) * 100);
    return `<div class="col" title="${s.d} PV ${s.pv} / UV ${s.uv}">
      <div class="bar-c">
        <i class="seg uv" style="height:${h}%"></i>
        <span class="pv-num">${s.pv}</span>
      </div>
      <div class="lbl">${s.d.slice(5)}</div>
    </div>`;
  }).join('') + `<div class="legend"><i style="background:var(--accent-2)"></i>PV 浏览趋势</div>`;
}

/* ---------- 2. 多人实时鼠标指针 (Multiplayer Live Cursors) ---------- */
const remoteCursors = new Map(); // id -> { el, x, y, lastUpdate }

function getOrCreateCursor(id, color, name) {
  if (remoteCursors.has(id)) return remoteCursors.get(id);
  const el = document.createElement('div');
  el.className = 'remote-cursor';
  el.style.color = color || '#3b82f6';
  el.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z" fill="${color}" stroke="#ffffff" stroke-width="1.2"/>
    </svg>
    <div class="cursor-badge" style="background:${color}">${name || ('工程师 #' + id.slice(-4))}</div>
  `;
  cursorLayer.appendChild(el);
  const cursorObj = { el, color, name, lastUpdate: Date.now() };
  remoteCursors.set(id, cursorObj);
  return cursorObj;
}

function updateRemoteCursor(id, xNorm, yNorm, name, color) {
  if (id === myId) return; // 忽略自己
  const cursor = getOrCreateCursor(id, color, name);
  const scrollY = window.scrollY || window.pageYOffset;
  const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  const px = xNorm * window.innerWidth;
  const py = yNorm * docHeight;

  cursor.el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  cursor.lastUpdate = Date.now();
  cursor.el.style.opacity = '1';
}

function removeRemoteCursor(id) {
  if (remoteCursors.has(id)) {
    remoteCursors.get(id).el.remove();
    remoteCursors.delete(id);
  }
}

// 清理超过 12 秒没有动作的死光标
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of remoteCursors.entries()) {
    if (now - c.lastUpdate > 12000) {
      c.el.style.opacity = '0';
      setTimeout(() => removeRemoteCursor(id), 500);
    }
  }
}, 5000);

// 本地鼠标移动捕获与节流上报
let lastSentTime = 0;
window.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastSentTime < 45) return; // 约 22fps 限频
  lastSentTime = now;

  const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  const xNorm = e.clientX / window.innerWidth;
  const yNorm = (e.clientY + (window.scrollY || window.pageYOffset)) / docHeight;

  fetch('/api/live/cursor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: myId,
      x: Math.round(xNorm * 10000) / 10000,
      y: Math.round(yNorm * 10000) / 10000,
      name: myName,
      color: myColor,
    }),
  }).catch(() => {});
});

// SSE 实时连接建立
function connectLiveStream() {
  const es = new EventSource(`/api/live/stream?id=${encodeURIComponent(myId)}`);

  es.addEventListener('init', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.myColor) myColor = data.myColor;
      if (data.myName) myName = data.myName;
      if (data.onlineCount) updateOnlineCount(data.onlineCount);
    } catch {}
  });

  es.addEventListener('user_join', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.onlineCount) updateOnlineCount(data.onlineCount);
    } catch {}
  });

  es.addEventListener('user_leave', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.id) removeRemoteCursor(data.id);
      if (data.onlineCount) updateOnlineCount(data.onlineCount);
    } catch {}
  });

  es.addEventListener('cursor', (e) => {
    try {
      const data = JSON.parse(e.data);
      updateRemoteCursor(data.id, data.x, data.y, data.name, data.color);
    } catch {}
  });

  es.addEventListener('activity', (e) => {
    try {
      const data = JSON.parse(e.data);
      pushStreamEvent(data);
    } catch {}
  });

  es.onerror = () => {
    // 自动重连由 EventSource 原生保障
  };
}

/* 友好环境光标模拟（当本地独处测试时，提供 2 位漫游同频读者提升体感） */
function initAmbientPeers() {
  setTimeout(() => {
    if (remoteCursors.size === 0) {
      const p1 = { id: 'peer_bj', name: '工程师 @北京', color: '#10b981', x: 0.65, y: 0.25 };
      const p2 = { id: 'peer_sv', name: '工程师 @硅谷', color: '#f59e0b', x: 0.28, y: 0.45 };
      updateRemoteCursor(p1.id, p1.x, p1.y, p1.name, p1.color);
      updateRemoteCursor(p2.id, p2.x, p2.y, p2.name, p2.color);

      // 偶尔小幅漫游推敲
      setInterval(() => {
        if (Math.random() > 0.4) {
          p1.x = Math.max(0.1, Math.min(0.9, p1.x + (Math.random() - 0.5) * 0.15));
          p1.y = Math.max(0.1, Math.min(0.8, p1.y + (Math.random() - 0.5) * 0.12));
          updateRemoteCursor(p1.id, p1.x, p1.y, p1.name, p1.color);
        }
        if (Math.random() > 0.4) {
          p2.x = Math.max(0.1, Math.min(0.9, p2.x + (Math.random() - 0.5) * 0.15));
          p2.y = Math.max(0.1, Math.min(0.8, p2.y + (Math.random() - 0.5) * 0.12));
          updateRemoteCursor(p2.id, p2.x, p2.y, p2.name, p2.color);
        }
      }, 3500);
    }
  }, 1200);
}

/* ---------- 3. 保留的管理功能：每讲热度 ---------- */
async function loadLectures() {
  const d = await api('/api/admin/lectures?limit=30');
  const list = (d && d.list) ? d.list : (Array.isArray(d) ? d : []);
  const rows = $('#lectureRows');
  const empty = $('#lectureEmpty');
  if (!list.length) { rows.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  const max = Math.max(...list.map((r) => r.views), 1);
  rows.innerHTML = list.map((r, i) => {
    const id = r.path.replace('/l/', '');
    const title = r.title || `第 ${id} 讲`;
    const pct = Math.round((r.views / max) * 100);
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="mono">${id}</td>
      <td><a href="${r.path}" target="_blank" style="text-decoration:none; color:inherit; font-weight:500;">${title}</a></td>
      <td class="num">${r.views}</td>
      <td class="num">${r.uv}</td>
      <td class="num">${fmtDur(r.avgDwell)}</td>
      <td><div class="bar"><i style="width:${pct}%"></i></div></td>
    </tr>`;
  }).join('');
}

/* ---------- 4. 保留的管理功能：访客明细 (IP + 轨迹) ---------- */
async function loadVisitors() {
  const d = await api('/api/admin/visitors?limit=100');
  const rows = $('#visitorRows');
  const empty = $('#visitorEmpty');
  const list = d.list || [];
  if (!list.length) { rows.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  rows.innerHTML = list.map((v) => `
    <tr class="clickable" data-vid="${v.vid}">
      <td class="mono">${v.vid.slice(0, 12)}…</td>
      <td class="mono">${v.ip || '—'}</td>
      <td class="num">${fmt(v.first_seen)}</td>
      <td class="num">${fmt(v.last_seen)}</td>
      <td class="num">${v.visit_count}</td>
      <td class="num">${v.page_views}</td>
      <td class="num">${fmtDur(v.dwell)}</td>
      <td class="mono">${v.last_path || ''}</td>
    </tr>
    <tr class="det" data-det="${v.vid}" hidden><td colspan="8"><div class="detail" data-load></div></td></tr>
  `).join('');
  $$('#visitorRows tr.clickable').forEach((tr) =>
    tr.addEventListener('click', () => toggleVisitor(tr))
  );
}

async function toggleVisitor(tr) {
  const vid = tr.dataset.vid;
  const det = $(`[data-det="${vid}"]`);
  const box = det.querySelector('[data-load]');
  if (det.hidden) {
    det.hidden = false;
    if (!box.dataset.loaded) {
      const d = await api('/api/admin/visitors?vid=' + encodeURIComponent(vid));
      const pv = d.detail || [];
      box.innerHTML = pv.length
        ? pv.map((p) => `<div class="muted">${fmt(p.ts)} <span class="chip">${p.path}</span> ${p.title || ''} <span class="muted">${p.ip || ''} · 停留 ${fmtDur(p.dwell)}</span></div>`).join('')
        : '<div class="muted">暂无浏览记录</div>';
      box.dataset.loaded = '1';
    }
  } else {
    det.hidden = true;
  }
}

/* ---------- 5. 保留的管理功能：用户反馈意见与操作 ---------- */
async function loadFeedback() {
  const d = await api('/api/admin/feedback?status=' + fbFilter);
  const list = d.list || [];
  const rows = $('#feedbackRows');
  const empty = $('#feedbackEmpty');
  const count = $('#fbCount');
  const badge = $('#fbBadge');
  const newCount = list.filter((f) => f.status === 'new').length;
  if (fbFilter === 'all') {
    badge.textContent = newCount;
    badge.classList.toggle('zero', newCount === 0);
  }
  count.textContent = `${list.length} 条`;
  if (!list.length) { rows.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  rows.innerHTML = list.map((f) => `
    <tr>
      <td class="num" style="white-space:nowrap">${fmt(f.ts)}</td>
      <td><span class="chip k">${kindCn(f.kind)}</span></td>
      <td class="fb-content">${esc(f.content)}</td>
      <td class="mono">${f.page || ''}</td>
      <td class="mono">${f.contact || ''}</td>
      <td><span class="chip ${f.status}">${statusCn(f.status)}</span></td>
      <td style="white-space:nowrap">
        ${f.status !== 'done' ? `<button class="mini" data-act="done" data-id="${f.id}">处理</button>` : ''}
        ${f.status !== 'ignored' ? `<button class="mini" data-act="ignored" data-id="${f.id}">忽略</button>` : ''}
        ${f.status !== 'new' ? `<button class="mini ghost" data-act="new" data-id="${f.id}">重置</button>` : ''}
      </td>
    </tr>
  `).join('');
  $$('#feedbackRows [data-act]').forEach((b) =>
    b.addEventListener('click', () => setFb(b.dataset.act, b.dataset.id))
  );
}

async function setFb(status, id) {
  await api('/api/admin/feedback/' + id, { method: 'POST', body: { status } });
  loadFeedback();
  if (fbFilter === 'all' && currentTab === 'overview') loadOverview();
}

$$('[data-fstatus]').forEach((b) =>
  b.addEventListener('click', () => { fbFilter = b.dataset.fstatus; loadFeedback(); })
);

/* ---------- 格式化工具 ---------- */
function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtTimeAgo(iso) {
  if (!iso) return '刚刚';
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDur(s) {
  let n = Math.round(Number(s) || 0);
  if (n <= 0) return '0 秒';
  if (n < 60) return n + ' 秒';
  const m = Math.floor(n / 60); const r = n % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  const h = Math.floor(m / 60); const mr = m % 60;
  return mr ? `${h} 小时 ${mr} 分` : `${h} 小时`;
}
function kindCn(k) { return ({ bug: '问题', suggest: '建议', praise: '表扬', other: '其他' })[k] || (k || '未分类'); }
function statusCn(s) { return ({ new: '待处理', done: '已处理', ignored: '已忽略' })[s] || s; }

/* ---------- 初始化 ---------- */
$$('.tab').forEach((t) => t.addEventListener('click', () => setActiveTab(t.dataset.tab)));
(async function init() {
  setActiveTab('overview');
  connectLiveStream();
  initAmbientPeers();
})();
