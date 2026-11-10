// 匿名访客标识 + 访问埋点 + 反馈提交。
// 不需要注册：首次访问在浏览器 localStorage 生成一个随机 ID（ai_vid），之后每次访问都带上。
// 后端只收到匿名 ID，不含姓名/手机/邮箱等个人信息。
import { backendUrl } from './site';

const KEY = 'ai_vid';

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

/** 上报一次页面浏览。静默失败，不影响页面本身。 */
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
    }).catch(() => {});
  } catch {
    /* 忽略：埋点不能影响正常浏览 */
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
