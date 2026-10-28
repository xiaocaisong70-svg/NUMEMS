// Calls only this project's existing administrator-gated /api/codex route.
// The Sites front door supplies the signed-in ChatGPT identity; this client
// neither copies cookies nor accepts caller-supplied identity headers.
export class PortalReadUnavailable extends Error {
  constructor(metadata) {
    const valid=metadata && typeof metadata==='object' && !Array.isArray(metadata) &&
      typeof metadata.requestedOperation==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(metadata.requestedOperation) &&
      metadata.readOnly===true && ['timeout','network'].includes(metadata.reason) &&
      ((metadata.stage==='identity' && metadata.requestNotSent===true) ||
       (metadata.stage==='status' && metadata.requestedOperation==='seat_portal_status' && metadata.requestNotSent===false));
    if(!valid)throw new Error('Invalid portal read failure metadata.');
    super('门户只读请求暂时不可用；未确认云端状态前不得开始成员操作。');
    this.name='PortalReadUnavailable';
    this.failureCode='portal_read_unavailable';
    this.metadata=Object.freeze({stage:metadata.stage,requestedOperation:metadata.requestedOperation,
      requestNotSent:metadata.requestNotSent,readOnly:true,reason:metadata.reason});
  }
}

export class PortalQueueUnavailable extends Error {
  constructor(metadata) {
    const valid=metadata && typeof metadata==='object' && !Array.isArray(metadata) &&
      metadata.stage==='queue_refresh' && metadata.requestedOperation==='refresh_seat_queue' &&
      metadata.idempotent===true && metadata.noExternalActions===true &&
      ['timeout','network'].includes(metadata.reason);
    if(!valid)throw new Error('Invalid pure queue failure metadata.');
    super('门户纯队列刷新暂时不可用；未重新核实计划前不得开始成员操作。');
    this.name='PortalQueueUnavailable';
    this.failureCode='portal_queue_unavailable';
    this.metadata=Object.freeze({stage:'queue_refresh',requestedOperation:'refresh_seat_queue',
      idempotent:true,noExternalActions:true,reason:metadata.reason});
  }
}

// Only a matched HTTP-200 tool error is a definite, atomic business rejection.
// Never attach provider bodies, tokens or this flag to transport ambiguity.
export class PortalOperationRejected extends Error {
  constructor(operation) {
    if(operation!=='begin_fault_rescue')throw new Error('Unsupported explicit operation rejection.');
    super('The rescue capability request was explicitly rejected; fresh state must be checked.');
    this.name='PortalOperationRejected';this.operation=operation;this.definitelyRejected=true;
  }
}

// Optional deadlines are for recovery reads only. Mutation transport and
// ambiguous-result handling retain their original single-attempt semantics.
function normalizeReadControls(controls,operation) {
  if(!controls || !Object.keys(controls).length)return undefined;
  if(!['seat_portal_status','portal_identity'].includes(operation) ||
      (controls.deadlineAt!==undefined&&!Number.isFinite(controls.deadlineAt)) ||
      (controls.budgetMs!==undefined&&(!Number.isInteger(controls.budgetMs)||controls.budgetMs<1||controls.budgetMs>120000)) ||
      (controls.now!==undefined&&typeof controls.now!=='function') ||
      (controls.deadlineAt===undefined&&controls.budgetMs===undefined))throw new Error('Invalid portal read deadline.');
  const now=controls.now??Date.now;
  return {now,deadlineAt:Math.min(controls.deadlineAt??Infinity,now()+(controls.budgetMs??120000))};
}
function readTimeout(controls,cap,requestedOperation,stage='identity') {
  if(!controls)return cap;
  const remaining=controls.deadlineAt-controls.now();
  if(remaining<=0)throw new PortalReadUnavailable({stage,requestedOperation,requestNotSent:stage==='identity',readOnly:true,reason:'timeout'});
  return Math.max(1,Math.min(cap,Math.floor(remaining)));
}

export class PortalClient {
  constructor(context, config, setupOperations = []) {
    this.context = context;
    this.config = config;
    this.sequence = 0;
    this.setupOperations = setupOperations;
  }

  // Only the guarded pre-claim recovery controller may replace a closed
  // browser context. Identity is read again; no cookies or credentials move.
  rebindContext(context) {
    if(!context || typeof context.newPage!=='function')throw new Error('Invalid recovered browser context.');
    this.context=context;this.page=undefined;this.sessionRestoreAttempted=false;
  }

  async open(requestedOperation='portal_identity',readOptions) {
    const controls=normalizeReadControls(readOptions,requestedOperation);
    readTimeout(controls,30000,requestedOperation);
    if (!this.page) this.page = await this.context.newPage();
    if (new URL(this.page.url()).origin !== new URL(this.config.siteUrl).origin) {
      try {
        await this.page.goto(this.config.siteUrl, { waitUntil: "domcontentloaded", timeout: readTimeout(controls,30000,requestedOperation) });
      } catch(error) {
        // This navigation precedes any RPC. Only an explicit navigation timeout
        // or a narrow transport code qualifies; auth, certificate and closed-page
        // failures remain fatal. Do not reuse this classifier for writes or SSO.
        const networkCode=typeof error?.message==='string' && error.message.match(/\bnet::(ERR_(?:CONNECTION_TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_RESET|NAME_NOT_RESOLVED|CONNECTION_CLOSED|TIMED_OUT|FAILED))\b/)?.[1];
        if(error?.name==='TimeoutError' || networkCode)
          throw new PortalReadUnavailable({stage:'identity',requestedOperation,requestNotSent:true,readOnly:true,
            reason:error.name==='TimeoutError' || /TIMED_OUT$/.test(networkCode)?'timeout':'network'});
        throw error;
      }
    }
    const readIdentity = async () => {
      const timeoutMs=readTimeout(controls,20000,requestedOperation);
      const result=await this.page.evaluate(async ({timeoutMs=20000}={}) => {
        let response;
        try {
          response = await fetch("/api/portal", { cache: "no-store", credentials: "same-origin",
            signal:AbortSignal.timeout(timeoutMs) });
          return { status: response.status, body: await response.json() };
        } catch(error) {
          // JSON syntax/protocol errors and known HTTP auth errors remain fatal.
          // Only a browser-reported transport failure is eligible for read health checks.
          if(!response || response.status===200) {
            if(error?.name==='TimeoutError' || error?.name==='AbortError')
              return {transportFailure:{reason:'timeout'}};
            if(error?.name==='TypeError' && /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(error.message??''))
              return {transportFailure:{reason:'network'}};
          }
          throw error;
        }
      },controls?{timeoutMs}:undefined);
      readTimeout(controls,20000,requestedOperation);
      if(result?.transportFailure)throw new PortalReadUnavailable({stage:'identity',requestedOperation,
        requestNotSent:true,readOnly:true,reason:result.transportFailure.reason});
      return result;
    };
    let identity = await readIdentity();
    if (identity.status === 401 && identity.body.access === 'signin_required' &&
        this.config.browserMode === 'isolated_desktop' && !this.sessionRestoreAttempted) {
      // Normal Sites sign-in redirect may reuse the administrator's existing SSO session.
      // One attempt only; never fill credentials, click consent, handle CAPTCHA or copy cookies.
      this.sessionRestoreAttempted = true;
      const site = new URL(this.config.siteUrl);
      const isPortal = url=>url.origin===site.origin && url.pathname==='/';
      const isAccountChoice = url=>url.origin==='https://auth.openai.com' && url.pathname==='/choose-an-account';
      try {
        await this.page.goto(new URL('/signin-with-chatgpt?return_to=%2F',site).href,
          {waitUntil:'domcontentloaded',timeout:readTimeout(controls,30000,requestedOperation)});
        await this.page.waitForURL(url=>isPortal(url)||isAccountChoice(url),{timeout:readTimeout(controls,30000,requestedOperation)});
        if(isAccountChoice(new URL(this.page.url()))) {
          // A normal existing-account selector is not a new consent or credential form.
          // Select only the exact administrator address, never the first/default account.
          const label=this.page.getByText(this.config.adminEmail,{exact:true}).filter({visible:true});
          await label.waitFor({state:'visible',timeout:readTimeout(controls,10000,requestedOperation)});
          if(await label.count()!==1)throw new Error('管理员账号选项不唯一。');
          const choice=label.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button" or @role="link"][1]').filter({visible:true});
          if(await choice.count()!==1 || !isAccountChoice(new URL(this.page.url())))
            throw new Error('无法唯一识别已登录管理员账号选项。');
          await choice.click({timeout:readTimeout(controls,10000,requestedOperation)});
          await this.page.waitForURL(isPortal,{timeout:readTimeout(controls,30000,requestedOperation)});
        }
        identity = await readIdentity();
      } catch(error) {
        if(error instanceof PortalReadUnavailable)throw error;
        throw new Error('门户既有登录无法自动续接；需要登录或安全验证，执行器保持停止且不弹窗。');
      }
    }
    if (identity.status !== 200 || identity.body.access !== "allowed" ||
        identity.body.user?.email?.toLowerCase() !== this.config.adminEmail)
      throw new Error("门户管理员登录失效或身份不符，执行器已停止。");
    return this.page;
  }

  async call(name, args = {},readOptions) {
    const allowed = new Set(["process_seat_queue", "refresh_seat_queue", "seat_portal_status", "observe_workspace",
      "claim_seat_operation", "complete_seat_operation", "defer_seat_operation",
      "record_codex_schedule", "record_idle_observation_failure", "observe_idle_workspace"]);
    for (const operation of this.setupOperations) allowed.add(operation);
    if (!allowed.has(name)) throw new Error("执行器不允许调用该门户操作。");
    const controls=normalizeReadControls(readOptions,name);
    const page = await this.open(name,controls);
    const body = { jsonrpc: "2.0", id: ++this.sequence,
      method: "tools/call", params: { name, arguments: args } };
    const timeoutMs=readTimeout(controls,30000,name);
    const result = await page.evaluate(async requestBody => {
      const {_readTimeoutMs=30000,...rpcBody}=requestBody;
      let response;
      try {
        response = await fetch("/api/codex", {
          method: "POST", credentials: "same-origin", cache: "no-store",
          signal:AbortSignal.timeout(_readTimeoutMs),
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(rpcBody),
        });
        return { status: response.status, body: await response.json() };
      } catch(error) {
        if(!response || response.status===200) {
          if(error?.name==='TimeoutError' || error?.name==='AbortError')
            return {transportFailure:{reason:'timeout'}};
          if(error?.name==='TypeError' && /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(error.message??''))
            return {transportFailure:{reason:'network'}};
        }
        throw error;
      }
    }, controls?{...body,_readTimeoutMs:timeoutMs}:body);
    if(controls)readTimeout(controls,30000,name,'status');
    if(result?.transportFailure && name==='seat_portal_status')
      throw new PortalReadUnavailable({stage:'status',requestedOperation:name,
        requestNotSent:false,readOnly:true,reason:result.transportFailure.reason});
    if(result?.transportFailure && name==='refresh_seat_queue')
      throw new PortalQueueUnavailable({stage:'queue_refresh',requestedOperation:name,
        idempotent:true,noExternalActions:true,reason:result.transportFailure.reason});
    if(name==='begin_fault_rescue'&&result.status===200&&result.body?.id===body.id&&result.body?.result?.isError===true)
      throw new PortalOperationRejected(name);
    if (result.status !== 200 || result.body?.id !== body.id ||
        result.body?.result?.isError || result.body?.error)
      throw new Error(`门户 ${name} 未能确认执行结果；不得盲目重试。`);
    const content = result.body.result?.content?.find(item => item.type === "text")?.text;
    try { return JSON.parse(content); }
    catch { throw new Error(`门户 ${name} 返回非预期回执；不得盲目重试。`); }
  }

  // This endpoint performs only deterministic, idempotent queue transforms.
  // Never fall back to process_seat_queue, which may also send relay mail.
  async refreshQueue() { return this.call('refresh_seat_queue'); }
}

export class UnavailableOfficialMemberApi {
  constructor({ verified = false } = {}) { this.verified = verified; }
  async probe() { return { available: false, reason: "当前 Business 工作空间未验证官方成员管理 API、权限和 Admin 凭据。" }; }
  async observe() { throw new Error("官方成员管理 API 尚不可用。"); }
  async invite() { throw new Error("官方成员管理 API 尚不可用。"); }
  async revokeInvite() { throw new Error("官方成员管理 API 尚不可用。"); }
  async remove() { throw new Error("官方成员管理 API 尚不可用。"); }
}
