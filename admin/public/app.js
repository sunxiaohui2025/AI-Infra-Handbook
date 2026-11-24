// AI Infra 学习脉搏 (Live Pulse) —— 前端逻辑
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const app = $('#app');
let currentTab = 'overview';
let fbFilter = 'all';

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
  if (tab === 'overview') loadPresence();
  if (tab === 'lectures') loadLectures();
  if (tab === 'visitors') loadVisitors();
  if (tab === 'feedback') loadFeedback();
}

/* ---------- 1. 实时脉搏总览 (真实在线人数 + 真实城市分布 + 走势) ---------- */
let cachedMapNodes = [];

// 完整统计：只在首屏加载一次。含大量全表聚合，不能高频调用（会烧光 D1 的 rows_read 配额）。
async function loadOverview() {
  const d = await api('/api/admin/stats');
  updateOnlineCount(d.onlineCount || 0);
  updateLocatedCount(d.locatedCount || 0, (d.mapNodes || []).length);
  renderKpis(d.kpi);
  renderMap(d.mapNodes || []);
  renderChart(d.series);
}

// 轻量在线状态：只查最近 30 分钟的 active 访客（走索引）， polls 只调这个，读数极低。
async function loadPresence() {
  const p = await api('/api/admin/presence');
  updateOnlineCount(p.onlineCount || 0);
  updateLocatedCount(p.locatedCount || 0, (p.mapNodes || []).length);
  renderMap(p.mapNodes || []);
}

function updateOnlineCount(cnt) {
  const el = $('#onlineCount');
  if (el) el.textContent = Math.max(Number(cnt) || 0, 0);
}

// 地图副标题：显示「在线 N 人 · 其中 M 人已定位到 K 座城市」
function updateLocatedCount(located, cities) {
  const el = $('#mapActiveCount');
  if (!el) return;
  if (!cities) {
    el.textContent = '暂无可定位的在线访客';
  } else {
    el.textContent = `${cities} 座城市 · ${located} 位访客已定位`;
  }
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

/* 全球学习地图渲染：节点来自真实访客 IP 地理位置（最近 30 分钟活跃） */
function renderMap(nodes) {
  cachedMapNodes = nodes;
  const container = $('#mapBeacons');
  const tooltip = $('#mapTooltip');
  if (!container) return;

  if (!nodes.length) {
    container.innerHTML = '<div class="map-empty">当前没有已定位的在线访客</div>';
    return;
  }

  container.innerHTML = nodes.map((n, i) => `
    <div class="beacon" style="left: ${n.x}%; top: ${n.y}%;" data-idx="${i}">
      <div class="beacon-ripple"></div>
      <div class="beacon-dot"></div>
      <div class="beacon-label">${esc(n.name)}</div>
    </div>
  `).join('');

  $$('.beacon', container).forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const idx = Number(el.dataset.idx);
      const n = cachedMapNodes[idx];
      if (!n) return;
      tooltip.innerHTML = `
        <div class="tt-city">${esc(n.name)}${n.country ? ' · ' + esc(n.country) : ''}</div>
        <div class="tt-info"><b>${n.learners}</b> 位访客正在学习</div>
        ${n.latestLecture ? `<div class="tt-lec">最近研读：${esc(n.latestLecture)}</div>` : ''}
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

// 刷新策略（为控制 Cloudflare D1 的 rows_read 用量）：
//  - 完整 stats（含大量全表聚合）只在首屏加载一次，绝不轮询；
//  - 定时只拉轻量的 presence（在线人数 + 城市分布，走索引，读数极低），每 60 秒一次；
//  - 页面从后台切回时也只拉 presence。
const REFRESH_MS = 60000;
let overviewTimer = null;
function startPolling() {
  if (overviewTimer) return;
  overviewTimer = setInterval(() => {
    if (currentTab === 'overview' && !document.hidden) {
      loadPresence().catch(() => {});
    }
  }, REFRESH_MS);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentTab === 'overview') loadPresence().catch(() => {});
});

(async function init() {
  await loadOverview().catch(() => {}); // 首屏完整加载一次
  startPolling();
})();
