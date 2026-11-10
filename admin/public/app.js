// 运营后台前端逻辑：登录 + 四个板块 + 数据接口调用。
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const login = $('#login');
const app = $('#app');
const pw = $('#pw');
const loginErr = $('#loginErr');
const tokenKey = 'ai_admin_token';
let token = localStorage.getItem(tokenKey) || '';
let currentTab = 'overview';
let fbFilter = 'all';

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------- 登录 ---------- */
function showLogin() { app.hidden = true; login.hidden = false; pw.value = ''; pw.focus(); }
async function showApp() {
  login.hidden = true; app.hidden = false;
  setActiveTab(currentTab);
}
function setActiveTab(tab) {
  currentTab = tab;
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['overview', 'lectures', 'visitors', 'feedback'].forEach((t) => {
    $('#tab-' + t).hidden = t !== tab;
  });
  if (tab === 'overview') loadOverview();
  if (tab === 'lectures') loadLectures();
  if (tab === 'visitors') loadVisitors();
  if (tab === 'feedback') loadFeedback();
}
async function doLogin() {
  loginErr.textContent = '';
  try {
    const d = await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
    token = d.token; localStorage.setItem(tokenKey, token);
    await showApp();
  } catch (e) { loginErr.textContent = e.message; }
}
$('#loginBtn').addEventListener('click', doLogin);
pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  token = ''; localStorage.removeItem(tokenKey); showLogin();
});

/* ---------- 总览 ---------- */
async function loadOverview() {
  const d = await api('/api/admin/stats');
  renderKpis(d.kpi);
  renderChart(d.series);
}
function renderKpis(k) {
  const cards = [
    { k: '总访问量 (PV)', v: k.totalPv, h: `独立访客 ${k.totalUv}` },
    { k: '独立访客 (UV)', v: k.totalUv, h: `累计回访访客占比 ${k.returnRate}%` },
    { k: '今日访问', v: k.today, h: `今日独立访客 ${k.todayUv}` },
    { k: '近 7 天訪問', v: k.weekPv, h: `新增访客 ${k.newVisitors}` },
    { k: '待处理反馈', v: k.newFeedback, h: '需要你查看', cls: k.newFeedback > 0 ? '' : 'small' },
  ];
  $('#kpis').innerHTML = cards.map((c) =>
    `<div class="kpi"><div class="k">${c.k}</div><div class="v ${c.cls || ''}">${c.v}</div><div class="hint">${c.h}</div></div>`
  ).join('');
}
function renderChart(series) {
  const el = $('#chart');
  if (!series || !series.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const maxPv = Math.max(...series.map((s) => s.pv), 1);
  el.innerHTML = series.map((s) => {
    const h = Math.round((s.pv / maxPv) * 100);
    return `<div class="col" title="${s.d} PV ${s.pv} / UV ${s.uv}">
      <div class="bar-c"><i class="seg uv" style="height:${h}%"></i></div>
      <div class="lbl">${s.d.slice(5)}</div>
    </div>`;
  }).join('') + `<div class="legend"><i style="background:var(--accent)"></i>PV<i style="background:var(--accent-2)"></i>UV</div>`;
}

/* ---------- 每讲热度 ---------- */
async function loadLectures() {
  const d = await api('/api/admin/lectures?limit=25');
  const rows = $('#lectureRows');
  const empty = $('#lectureEmpty');
  if (!d || !d.length) { rows.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  const max = Math.max(...d.map((r) => r.views), 1);
  rows.innerHTML = d.map((r, i) => {
    const id = r.path.replace('/l/', '');
    const title = r.title || `第 ${id} 讲`;
    const pct = Math.round((r.views / max) * 100);
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="mono">${id}</td>
      <td>${title}</td>
      <td class="num">${r.views}</td>
      <td class="num">${r.uv}</td>
      <td><div class="bar"><i style="width:${pct}%"></i></div></td>
    </tr>`;
  }).join('');
}

/* ---------- 访客 ---------- */
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
      <td class="mono">${v.ip || ''}</td>
      <td class="num">${fmt(v.first_seen)}</td>
      <td class="num">${fmt(v.last_seen)}</td>
      <td class="num">${v.visit_count}</td>
      <td class="num">${v.page_views}</td>
      <td class="mono">${v.last_path || ''}</td>
    </tr>
    <tr class="det" data-det="${v.vid}" hidden><td colspan="7"><div class="detail" data-load></div></td></tr>
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
        ? pv.map((p) => `<div class="muted">${fmt(p.ts)} <span class="chip">${p.path}</span> ${p.title || ''} <span class="muted">${p.ip || ''}</span></div>`).join('')
        : '<div class="muted">暂无浏览记录</div>';
      box.dataset.loaded = '1';
    }
  } else {
    det.hidden = true;
  }
}

/* ---------- 反馈 ---------- */
async function loadFeedback() {
  const d = await api('/api/admin/feedback?status=' + fbFilter);
  const list = d.list || [];
  const rows = $('#feedbackRows');
  const empty = $('#feedbackEmpty');
  const count = $('#fbCount');
  const badge = $('#fbBadge');
  const newCount = list.filter((f) => f.status === 'new').length;
  if (fbFilter === 'all') {
    badge.textContent = list.filter((f) => f.status === 'new').length;
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

/* ---------- 工具 ---------- */
function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function kindCn(k) { return ({ bug: '问题', suggest: '建议', praise: '表扬', other: '其他' })[k] || (k || '未分类'); }
function statusCn(s) { return ({ new: '待处理', done: '已处理', ignored: '已忽略' })[s] || s; }

/* ---------- 初始化 ---------- */
$$('.tab').forEach((t) => t.addEventListener('click', () => setActiveTab(t.dataset.tab)));
(async function init() {
  if (token) {
    try { await api('/api/admin/me'); await showApp(); return; } catch { /* 失效，走登录 */ }
  }
  showLogin();
})();
