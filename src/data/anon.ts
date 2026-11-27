// 匿名访客标识 + 访问埋点 + 反馈提交。
// 不需要注册：首次访问在浏览器 localStorage 生成一个随机 ID（ai_vid），之后每次访问都带上。
// 后端只收到匿名 ID，不含姓名/手机/邮箱等个人信息。
import { backendUrl } from './site';

const KEY = 'ai_vid';

// 心跳从 20 秒放宽到 60 秒：每次上报的是「距上次心跳的真实秒数」，累计停留时长不变，
// 但 D1 的 UPDATE 次数（rows_written / 请求量）降到原来的 1/3。
const DWELL_INTERVAL_MS = 60000;
const DWELL_MIN_S = 5;           // 大于 5 秒才计入，避免噪音

// 本次浏览对应的 pageview id + 上次心跳时间，用于累加停留时长
let pvId = 0;
let lastPing = 0;
let dwellTimer: number | undefined;

/** 取得（或首次生成）匿名访客 ID。存 localStorage，跨页面、跨访问保持。 */
export function getAnonId(): string {
  try {
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = (crypto.randomUUID?.() ?? 'anon-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    // localStorage 不可用（隐私模式等）时退回内存随机 ID，本次访问有效
    return 'anon-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/** 发送一次停留心跳：把自上次心跳以来经过的秒数累加到这一条 pageview 上。 */
function sendDwell(vid: string, id: number, seconds: number) {
  if (!id || !(seconds > 0)) return;
  const dt = Math.round(seconds);
  if (dt <= 0) return;
  try {
    fetch(backendUrl('/api/dwell'), {
      method: 'POST',
      keepalive: true, // 页面跳转/关闭时也尽力送达
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid, id, dt }),
    }).catch(() => {});
  } catch {
    /* 忽略：埋点不能影响正常浏览 */
  }
}

function stopDwell() {
  if (dwellTimer !== undefined) {
    clearInterval(dwellTimer);
    dwellTimer = undefined;
  }
}

/** 页面加载后启动停留统计：每 60 秒心跳一次；离开/切后台时补发剩余时长。只计“页面可见”的时间。 */
function startDwell(vid: string) {
  stopDwell();
  lastPing = Date.now();

  dwellTimer = window.setInterval(() => {
    const now = Date.now();
    const sec = (now - lastPing) / 1000;
    if (document.visibilityState === 'visible' && sec >= DWELL_MIN_S) {
      sendDwell(vid, pvId, sec);
      lastPing = now;
    }
  }, DWELL_INTERVAL_MS);

  const flush = () => {
    const sec = (Date.now() - lastPing) / 1000;
    if (sec >= 1) sendDwell(vid, pvId, sec);
    lastPing = Date.now();
  };

  window.addEventListener('pagehide', () => {
    flush();
    stopDwell();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush(); // 切后台：把已过时间补上，之后暂停
    } else {
      lastPing = Date.now(); // 回前台：从头计，不算后台停留
    }
  });
}

/** 上报一次页面浏览，并启动停留时长统计。静默失败，不影响页面本身。 */
export function track(path?: string, title?: string) {
  const vid = getAnonId();
  const payload = {
    vid,
    path: path || location.pathname,
    title: title || document.title,
  };
  try {
    fetch(backendUrl('/api/track'), {
      method: 'POST',
      keepalive: true, // 页面跳转/关闭时也尽力送达
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (d && d.id) {
          pvId = d.id;
          startDwell(vid);
        }
      })
      .catch(() => {});
  } catch {
    /* 忽略：埋点不能影响正常浏览 */
  }
}

/** 上报一次「全文PDF」下载。静默失败，不影响下载本身（点击外链会离开当前页）。 */
export function trackPdfDownload() {
  try {
    fetch(backendUrl('/api/pdfdl'), {
      method: 'POST',
      keepalive: true, // 跳转到外部下载地址时也尽力送达
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid: getAnonId() }),
    }).catch(() => {});
  } catch {
    /* 忽略：埋点不能影响正常下载 */
  }
}

/** 提交一条反馈意见。返回 Promise，可由调用方展示成功/失败。 */
export function sendFeedback(p: { kind: string; content: string; page?: string; contact?: string }) {
  return fetch(backendUrl('/api/feedback'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vid: getAnonId(), ...p }),
  }).then((r) => r.json());
}
