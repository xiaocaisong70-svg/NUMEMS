// Navigation and DOM reads only. Never click a challenge or retry a member action.
export class OfficialPageError extends Error {
  constructor(message, failureCode) { super(message); this.failureCode = failureCode; }
}

export function officialPageState({ url, expectedUrl, body, ready }) {
  const actual = new URL(url), expected = new URL(expectedUrl);
  if (/^(auth|auth0)\.openai\.com$/.test(actual.hostname) || /\/(log-in|login|sign-in)(\/|$)/.test(actual.pathname))
    return "login_expired";
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return "workspace_mismatch";
  if (/verify you are human|captcha|安全验证|验证您不是自动程序|just a moment|checking your browser/i.test(body))
    return "browser_unavailable";
  if (/sign in to continue|登录以继续/i.test(body)) return "login_expired";
  return ready ? "ready" : "loading";
}

export async function waitForOfficialPage({ inspect, pause, now = Date.now, timeoutMs = 45_000 }) {
  const deadline = now() + timeoutMs;
  while (true) {
    const state = officialPageState(await inspect());
    if (state === "ready") return;
    if (state === "login_expired") throw new OfficialPageError("官方后台登录已失效，需管理员重新登录。", state);
    if (state === "workspace_mismatch") throw new OfficialPageError("官方后台跳转到非目标工作空间，已停止。", state);
    if (now() >= deadline)
      throw new OfficialPageError("官方后台暂未完成加载或安全验证；未开始成员操作，稍后只读复核。", "browser_unavailable");
    await pause(Math.min(1000, deadline - now()));
  }
}
