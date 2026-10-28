// Navigation and DOM reads only. Never click a challenge or retry a member action.
export class OfficialPageError extends Error {
  constructor(message, failureCode, diagnostic) {
    super(message); this.failureCode = failureCode;
    if (diagnostic) this.officialDiagnostic = diagnostic;
  }
}

// A local stop during a pre-claim read is neither a provider failure nor a
// completed member operation. Callers must not use it to resume the workspace.
export class OfficialReadCancelled extends Error {
  constructor() { super('已停止尚未开始成员操作的官方只读核查。'); this.code='OFFICIAL_READ_CANCELLED'; }
}

const stages = new Set(['page','members_navigation','invites_navigation','members_rows','invites_rows','capacity','snapshot']);
const states = new Set(['loading','challenge','interaction_required','login','workspace_mismatch','network','capacity_unavailable']);
// Never retain body text, actual redirect URLs, query strings or authentication
// material. The expected route is already fixed by the adapter configuration.
export function officialDiagnostic({stage='page',state,expectedUrl,at=Date.now()}) {
  if (!stages.has(stage) || !states.has(state) || !Number.isFinite(at)) return undefined;
  let url; try {url=new URL(expectedUrl);} catch {return undefined;}
  if (!((url.protocol==='https:' && url.hostname==='admin.openai.com') ||
      (url.protocol==='http:' && url.hostname==='127.0.0.1'))) return undefined;
  const pathname=/^\/workspace\/[a-zA-Z0-9_-]+\/members$/.test(url.pathname) ? url.pathname : '/';
  return {version:1,stage,state,expectedUrl:url.origin+pathname,observedAt:new Date(at).toISOString()};
}
export function safeOfficialDiagnostic(error) {
  if (!(error instanceof OfficialPageError)) return undefined;
  const d=error.officialDiagnostic;
  if (!d || d.version!==1 || typeof d.observedAt!=='string') return undefined;
  return officialDiagnostic({...d,at:Date.parse(d.observedAt)});
}

export function officialPageState({ url, expectedUrl, body, ready }) {
  const actual = new URL(url), expected = new URL(expectedUrl);
  if (/^(auth|auth0)\.openai\.com$/.test(actual.hostname) || /\/(log-in|login|sign-in)(\/|$)/.test(actual.pathname))
    return "login_expired";
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return "workspace_mismatch";
  if (/verify you are human|captcha|安全验证|验证您不是自动程序|完成验证|验证您是真人|just a moment|checking your browser/i.test(body))
    return "browser_unavailable";
  if (/sign in to continue|登录以继续/i.test(body)) return "login_expired";
  return ready ? "ready" : "loading";
}

export async function waitForOfficialPage({ inspect, pause, now = Date.now, timeoutMs = 45_000,
  challengeTimeoutMs=timeoutMs,deadlineAt,interactionGraceMs=15000,
  stage='page',shouldStop=async()=>false,onProgress=async()=>{} }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>300_000 ||
      !Number.isInteger(challengeTimeoutMs) || challengeTimeoutMs<1 || challengeTimeoutMs>300_000 ||
      (deadlineAt!==undefined && !Number.isFinite(deadlineAt)) ||
      !Number.isInteger(interactionGraceMs) || interactionGraceMs<1000 || interactionGraceMs>30000 || !stages.has(stage))
    throw new Error('Invalid read-only readiness budget.');
  const started=now(),hardDeadline=Math.min(deadlineAt??Infinity,started+Math.min(300_000,timeoutMs+challengeTimeoutMs));
  let loadingDeadline=started+timeoutMs,challengeSeen=false,postChallengeLoading=false,interactionSeenAt=null;
  while (true) {
    if (await shouldStop()) throw new OfficialReadCancelled();
    const inspected=await inspect(), state = officialPageState(inspected),instant=now();
    // Text such as "Checking your browser" says nothing about a manual action.
    // Only a separately observed, visible verification control which remains
    // present after the passive grace period can establish interaction_required.
    if(state==='browser_unavailable' && inspected.interactionRequired===true)interactionSeenAt??=instant;
    else interactionSeenAt=null;
    const interactionRequired=interactionSeenAt!==null && instant-interactionSeenAt>=interactionGraceMs;
    const diagnostic=officialDiagnostic({stage,state:state==='browser_unavailable'?(interactionRequired?'interaction_required':'challenge'):
      state==='login_expired'?'login':state,expectedUrl:inspected.expectedUrl,at:instant});
    if (await shouldStop()) throw new OfficialReadCancelled();
    if (diagnostic) await onProgress(diagnostic);
    if (state === "ready" && instant<=hardDeadline) return;
    if (state === "login_expired") throw new OfficialPageError("官方后台登录已失效，需管理员重新登录。", state,diagnostic);
    if (state === "workspace_mismatch") throw new OfficialPageError("官方后台跳转到非目标工作空间，已停止。", state,diagnostic);
    if(interactionRequired)throw new OfficialPageError('官方安全检查页持续显示需要本人操作的验证控件；程序未点击任何验证。','browser_unavailable',diagnostic);
    if (state==='browser_unavailable') challengeSeen=true;
    else if (state==='loading' && challengeSeen && !postChallengeLoading) {
      // Once the same-page challenge naturally ends, allow the normal loading
      // budget exactly once. Never navigate, click or solve a verification.
      loadingDeadline=Math.min(hardDeadline,instant+timeoutMs);postChallengeLoading=true;
    }
    const deadline=Math.min(hardDeadline,state==='browser_unavailable'?started+challengeTimeoutMs:loadingDeadline);
    if (instant >= deadline)
      throw new OfficialPageError("官方后台暂未完成加载或安全验证；未开始成员操作，稍后只读复核。", "browser_unavailable",diagnostic);
    await pause(Math.min(1000, deadline - instant));
  }
}
