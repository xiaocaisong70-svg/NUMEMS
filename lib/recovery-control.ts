import { PROTECTED_OWNER_EMAIL, transition } from './seat-engine.ts';
import { validateObservation, TARGET_WORKSPACE_ID, type BridgeState } from './codex-bridge.ts';

export type RecoveryDiagnostic = { version: 1; stage: string; state: string; expectedUrl: string; observedAt: string };
export type RecoveryPhase = 'auto_recovery' | 'security_check' | 'interaction_required' | 'login_required' | 'waiting_codex' | 'review_required' | 'fallback_exhausted' | 'fallback_timeout';
export type RecoveryProgress = { failureId: string; phase: RecoveryPhase; at: string; diagnostic?: RecoveryDiagnostic };
export type RescueTarget = {kind:'invite'|'remove';targetId:string;email:string;requestUpdatedAt:string;operationId?:string;claimedAt?:string};
export type FaultRescueTicket = { id: string; token: string; failureId: string; phase: 'pending' | 'uncertain' | 'finished';
  scope: 'read_only_reconcile'|'approved_member_ops'; createdAt: string; updatedAt: string; operationId?: string;
  clientId?:string;expiresAt?:string;targets?:RescueTarget[];browserUnavailableAt?:string;inheritedHoldIds?:string[];
  outcome?: 'recovered' | 'needs_human' | 'unresolved' | 'handled'; diagnostic?: RecoveryDiagnostic };
export type RescueExecutionIncident={blockedAt:string;tickets:number;claimedTargets:{kind:'invite'|'remove';targetId:string}[]};
export type RescueExecutionHistory={id:string;clientId:string;createdAt:string};
const phases: RecoveryPhase[] = ['auto_recovery','security_check','interaction_required','login_required','waiting_codex','review_required','fallback_exhausted','fallback_timeout'];
const stages = ['page','members_navigation','invites_navigation','members_rows','invites_rows','capacity','snapshot'];
const diagnosticStates = ['loading','challenge','interaction_required','login','network','capacity_unavailable','workspace_mismatch'];
const time = (value: string) => { const n=Date.parse(value); if(!Number.isFinite(n))throw new Error('恢复时间无效。'); return n; };
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,240}$/.test(value);
const ownHolds=(input:BridgeState,ticket:FaultRescueTicket)=>(input.codex?.holds??[]).every(h=>
  ['member_action','approval_required'].includes(h.code)&&
    (h.operation.rescueId===ticket.id&&h.operation.rescueFailureId===ticket.failureId&&ticket.targets?.some(t=>
      t.operationId===h.operation.id&&t.kind===h.operation.kind&&t.targetId===h.operation.targetId&&t.email===h.operation.email)||
      ticket.inheritedHoldIds?.includes(h.operation.id)));
function inheritedHolds(input:BridgeState):string[]|null {
  const b=input.codex,t=b?.faultRescue,holds=b?.holds??[];
  if(!holds.length)return [];
  if(t?.scope!=='approved_member_ops'||t.phase!=='finished'||t.outcome!=='handled'||!b?.browserUnavailableAt||
      t.browserUnavailableAt!==b.browserUnavailableAt||b.rescueExecutionIncident?.blockedAt!==b.browserUnavailableAt||!ownHolds(input,t))return null;
  return holds.map(h=>h.operation.id);
}
const strictKeys = (args: unknown, required: string[], optional: string[] = []) => {
  if(!args || typeof args!=='object' || Array.isArray(args) || required.some(k=>!Object.hasOwn(args,k)) ||
    Object.keys(args).some(k=>![...required,...optional].includes(k)))throw new Error('恢复参数无效。');
};
export function latestRecoveryFailureId(input: BridgeState) {
  return [...input.audit].reverse().find(a=>a.action==='codex_workspace_blocked')?.id??null;
}
function requireWorkspace(input: BridgeState) {
  if(!input.codex?.enabled || input.codex.testOnly || !input.config.inventoryVerified ||
      input.config.workspaceId!==TARGET_WORKSPACE_ID || !input.config.protectedEmails.includes(PROTECTED_OWNER_EMAIL))
    throw new Error('正式工作空间与管理员配置未通过核对。');
  return input.codex;
}
function requireFailure(input: BridgeState, failureId: string) {
  const b=requireWorkspace(input);
  if(typeof failureId!=='string' || !failureId || !b.globalFailureCode || !b.lastError || latestRecoveryFailureId(input)!==failureId)
    throw new Error('故障已变化，不能覆盖或接管旧故障。');
  return b;
}
function record(input: BridgeState, action: string, now: string) {
  input.revision++;input.audit.push({id:`recovery_${input.revision}_${time(now)}`,at:now,actor:PROTECTED_OWNER_EMAIL,action});
}
export function safeRecoveryDiagnostic(value: unknown, now: string): RecoveryDiagnostic {
  strictKeys(value,['version','stage','state','expectedUrl','observedAt']);
  const d=value as RecoveryDiagnostic;
  if(d.version!==1 || !stages.includes(d.stage) || !diagnosticStates.includes(d.state) ||
      time(d.observedAt)>time(now)+5000 || time(now)-time(d.observedAt)>60_000)
    throw new Error('恢复诊断已过期或格式无效。');
  let url: URL;try{url=new URL(d.expectedUrl);}catch{throw new Error('恢复诊断来源无效。');}
  if(url.origin!=='https://admin.openai.com' || url.pathname!==`/workspace/${TARGET_WORKSPACE_ID}/members` ||
      url.search || url.hash || url.username || url.password)throw new Error('恢复诊断必须来自指定官方工作空间。');
  return {...d};
}
export function rescueBlocksClaims(input: BridgeState) {
  return Boolean(input.codex?.faultRescue && ['pending','uncertain'].includes(input.codex.faultRescue.phase));
}
export function publicFaultRescue(input: BridgeState, options:{includeTargets?:boolean}={}) {
  const ticket=input.codex?.faultRescue;if(!ticket)return null;
  const {id,failureId,phase,scope,createdAt,updatedAt,outcome,diagnostic,expiresAt,targets}=ticket;
  return structuredClone({id,failureId,phase,scope,createdAt,updatedAt,...(outcome?{outcome}:{}),...(diagnostic?{diagnostic}:{}),
    ...(expiresAt?{expiresAt}:{}),...(options.includeTargets&&ticket.operationId?{operationId:ticket.operationId}:{}),
    ...(targets?{targetCount:targets.length,...(options.includeTargets?{targets}:{}),settlement:rescueSettlement(input,ticket)}:{})});
}
export function publicRecoveryProgress(input: BridgeState,now=new Date().toISOString()) {
  const t=input.codex?.faultRescue;
  if(input.codex?.globalFailureCode==='browser_unavailable') {
    const available=executionRescueAvailability(input,now),failureId=latestRecoveryFailureId(input);
    if(failureId&&['incident_quota','daily_quota','targets_exhausted'].includes(available.reason))
      return {failureId,phase:'fallback_exhausted' as const,at:t?.failureId===failureId?t.updatedAt:input.codex.browserUnavailableAt??now};
  }
  if(input.codex?.globalFailureCode==='browser_unavailable'&&t?.scope==='approved_member_ops'&&
      t.failureId===latestRecoveryFailureId(input)) {
    if(t.phase!=='finished'&&t.expiresAt&&time(now)>=time(t.expiresAt))
      return {failureId:t.failureId,phase:'fallback_timeout' as const,at:t.expiresAt};
  }
  const p=input.codex?.recoveryProgress;
  return p && input.codex?.globalFailureCode && p.failureId===latestRecoveryFailureId(input)?structuredClone(p):null;
}
export function recordRecoveryProgress(input: BridgeState, args: {expectedFailureId: string; phase: RecoveryPhase; diagnostic?: RecoveryDiagnostic}, now: string): BridgeState {
  strictKeys(args,['expectedFailureId','phase'],['diagnostic']);
  const next=structuredClone(input),b=requireFailure(next,args.expectedFailureId);
  if(!phases.includes(args.phase))throw new Error('恢复阶段无效。');
  const diagnostic=args.diagnostic?safeRecoveryDiagnostic(args.diagnostic,now):undefined;
  if(args.phase==='interaction_required' && (b.globalFailureCode!=='browser_unavailable' || diagnostic?.state!=='interaction_required'))
    throw new Error('只有新鲜的明确交互证据才能提示人工验证。');
  if(args.phase==='login_required' && (!['browser_unavailable','login_expired'].includes(b.globalFailureCode!) || b.lease || b.operationFailureOrigin || diagnostic?.state!=='login'))
    throw new Error('没有明确的登录失效证据。');
  if(['auto_recovery','security_check'].includes(args.phase) && b.globalFailureCode!=='browser_unavailable')
    throw new Error('不能把现有故障降级为普通安全检查。');
  if(args.phase==='security_check' && diagnostic && !['challenge','loading','network','capacity_unavailable'].includes(diagnostic.state))
    throw new Error('安全检查诊断不匹配。');
  if(args.phase==='fallback_timeout'&&(b.globalFailureCode!=='browser_unavailable'||b.faultRescue?.scope!=='approved_member_ops'||
      b.faultRescue.phase==='finished'||b.faultRescue.failureId!==args.expectedFailureId||
      !b.faultRescue.expiresAt||time(now)<time(b.faultRescue.expiresAt)))throw new Error('执行型后备尚未超时。');
  if(args.phase==='fallback_exhausted'&&(b.globalFailureCode!=='browser_unavailable'||
      !['incident_quota','daily_quota','targets_exhausted'].includes(executionRescueAvailability(next,now).reason)))throw new Error('执行型后备额度未耗尽。');
  const old=b.recoveryProgress;
  if(old?.failureId===args.expectedFailureId && old.phase===args.phase &&
      JSON.stringify(old.diagnostic)===JSON.stringify(diagnostic))return next;
  b.recoveryProgress={failureId:args.expectedFailureId,phase:args.phase,at:now,...(diagnostic?{diagnostic}:{})};
  record(next,'recovery_progress_'+args.phase,now);return next;
}
/** This fence grants no member-action permission. The local broker separately
 * proves the worker has stopped before it delivers the read-only rescue. */
export function beginFaultRescue(input: BridgeState, args: {expectedFailureId: string;scope?:FaultRescueTicket['scope'];clientId?:string}, credential: {id:string;token:string}, now: string): BridgeState {
  strictKeys(args,['expectedFailureId'],['scope','clientId']);
  let next=structuredClone(input),b=requireFailure(next,args.expectedFailureId);const old=b.faultRescue,scope=args.scope??'read_only_reconcile';
  if(!['read_only_reconcile','approved_member_ops'].includes(scope))throw new Error('故障处置范围无效。');
  if(scope==='approved_member_ops'&&!safeId(args.clientId))throw new Error('执行型处置需要固定幂等 clientId。');
  if(scope==='approved_member_ops'&&old?.scope===scope&&old.failureId===args.expectedFailureId&&old.clientId===args.clientId)return next;
  if(scope==='read_only_reconcile'&&old?.failureId===args.expectedFailureId)return next;
  if(rescueBlocksClaims(next))throw new Error('已有故障处置未结束，禁止创建另一个执行者。');
  if(!['browser_unavailable','login_expired','unknown'].includes(b.globalFailureCode!))
    throw new Error('角色、容量或工作空间故障不能自动交接。');
  if(b.lease && (b.lease.status!=='uncertain' || b.globalFailureCode!=='unknown' ||
      b.operationFailureOrigin?.operationId!==b.lease.id || b.operationFailureOrigin?.failureId!==args.expectedFailureId))
    throw new Error('原操作仍在办理或缺少不明结果来源，禁止接管。');
  const {id,token}=credential;
  if(typeof token!=='string' || token.length<16 || token.length>200 || typeof id!=='string' || !/^rescue_[a-zA-Z0-9_-]{16,100}$/.test(id) || id.includes(token))throw new Error('处置凭证无效。');
  let execution:Pick<FaultRescueTicket,'clientId'|'expiresAt'|'targets'>={};
  if(scope==='approved_member_ops') {
    if(b.rescueExecutionHistory?.some(h=>h.clientId===args.clientId))throw new Error('该幂等处置请求已处理，不能新建票据。');
    next=transition(next,{userId:'system:codex',email:PROTECTED_OWNER_EMAIL,isAdmin:true},{type:'tick'},now) as BridgeState;
    b=requireFailure(next,args.expectedFailureId);
    const available=executionRescueAvailability(next,now);
    if(!available.canBegin)throw new Error('执行型后备不可领取：'+available.reason);
    const blockedAt=b.browserUnavailableAt!,previous=b.rescueExecutionIncident;
    b.rescueExecutionIncident={blockedAt,tickets:(previous?.blockedAt===blockedAt?previous.tickets:0)+1,
      claimedTargets:previous?.blockedAt===blockedAt?structuredClone(previous.claimedTargets):[]};
    b.rescueExecutionHistory=[...(b.rescueExecutionHistory??[]).filter(h=>time(now)-time(h.createdAt)<24*60*60_000),
      {id,clientId:args.clientId!,createdAt:now}].slice(-6);
    execution={clientId:args.clientId,expiresAt:new Date(time(now)+5*60_000).toISOString(),targets:available.eligibleTargets.slice(0,3)};
  }
  b.faultRescue={id,token,failureId:args.expectedFailureId,phase:'pending',scope,
    ...execution,
    ...(scope==='approved_member_ops'?{browserUnavailableAt:b.browserUnavailableAt,inheritedHoldIds:inheritedHolds(next)??[]}:{}),
    createdAt:now,updatedAt:now,...(b.lease?{operationId:b.lease.id}:{})};
  if(b.recoveryProgress?.phase!=='interaction_required' && b.recoveryProgress?.phase!=='login_required')
    b.recoveryProgress={failureId:args.expectedFailureId,phase:'waiting_codex',at:now};
  record(next,'fault_rescue_pending',now);return next;
}
export function finishFaultRescue(input: BridgeState, args: {rescueId: string; token: string; expectedFailureId: string;
  outcome:'recovered'|'needs_human'|'unresolved'|'uncertain'|'handled';agentStopped: boolean;diagnostic?: RecoveryDiagnostic}, now: string): BridgeState {
  strictKeys(args,['rescueId','token','expectedFailureId','outcome','agentStopped'],['diagnostic']);
  const next=structuredClone(input),b=requireWorkspace(next),t=b.faultRescue;
  if(!t || t.id!==args.rescueId || t.token!==args.token || t.failureId!==args.expectedFailureId)
    throw new Error('故障处置凭证或事件不匹配。');
  if(!['recovered','needs_human','unresolved','uncertain','handled'].includes(args.outcome))throw new Error('处置结果无效。');
  if(typeof args.agentStopped!=='boolean')throw new Error('故障会话结束证明无效。');
  if(t.phase==='finished') {
    if(t.outcome!==args.outcome)throw new Error('已结案的处置不能改写结果。');
    return next;
  }
  if(args.outcome==='uncertain') {
    t.phase='uncertain';t.updatedAt=now;record(next,'fault_rescue_uncertain',now);return next;
  }
  if(args.agentStopped!==true)throw new Error('必须先确认故障会话已经结束，才能交还执行权。');
  if(b.lease&&t.scope==='approved_member_ops')throw new Error('执行型处置尚有原租约，禁止结束或按超时释放。');
  const sameFailure=latestRecoveryFailureId(next)===t.failureId;
  if(args.outcome!=='unresolved' && !sameFailure)throw new Error('已出现更新的故障，不能用旧处置确认恢复或要求人工。');
  const diagnostic=args.diagnostic?safeRecoveryDiagnostic(args.diagnostic,now):undefined;
  if(args.outcome==='recovered') {
    if(b.lastError || b.globalFailureCode || b.lease || b.holds?.length || b.operationFailureOrigin || b.mailChannelError || !b.observation)
      throw new Error('云端故障、租约或隔离记录尚未结案。');
    const s=validateObservation(b.observation,now);
    if(time(s.observedAt)<time(t.createdAt) || s.totalSeats!==next.config.totalSeats ||
       new Set([...s.members,...s.invites].map(p=>p.email.trim().toLowerCase())).size!==s.members.length+s.invites.length ||
       s.members.length+s.invites.length>s.totalSeats ||
       s.members.some(p=>p.email.trim().toLowerCase()===PROTECTED_OWNER_EMAIL?p.role!=='owner':p.role!=='member') ||
       s.invites.some(p=>p.role!=='member'||p.email.trim().toLowerCase()===PROTECTED_OWNER_EMAIL))
      throw new Error('原脚本通道的新鲜官方证据未通过核对。');
  }
  if(args.outcome==='handled') {
    if(t.scope!=='approved_member_ops'||!ownHolds(next,t)||b.operationFailureOrigin||
        b.globalFailureCode!=='browser_unavailable'||!b.lastError||!rescueSettlement(next,t).canHandle)throw new Error('本轮执行型处置仍有未结案、缺少可核实终态或新的全局故障。');
    b.recoveryProgress={failureId:t.failureId,phase:'review_required',at:now};
  }
  if(args.outcome==='needs_human') {
    if(!diagnostic || !['interaction_required','login'].includes(diagnostic.state) ||
      (diagnostic.state==='interaction_required' && b.globalFailureCode!=='browser_unavailable') ||
      (diagnostic.state==='login' && (!['browser_unavailable','login_expired'].includes(b.globalFailureCode!) || b.lease || b.operationFailureOrigin)))
      throw new Error('普通 challenge 不足以证明需要本人验证。');
    b.recoveryProgress={failureId:t.failureId,phase:diagnostic.state==='login'?'login_required':'interaction_required',at:now,diagnostic};
  } else if(args.outcome==='unresolved' && sameFailure)b.recoveryProgress={failureId:t.failureId,phase:'review_required',at:now,...(diagnostic?{diagnostic}:{})};
  t.phase='finished';t.outcome=args.outcome;t.updatedAt=now;if(diagnostic)t.diagnostic=diagnostic;
  record(next,'fault_rescue_'+args.outcome,now);return next;
}

/** Administrator work-plan metadata only; never grants permission by itself. */
export function executionRescueAvailability(input:BridgeState,now:string) {
  const b=input.codex,at=time(now),incident=b?.rescueExecutionIncident;
  const same=!!b?.browserUnavailableAt&&incident?.blockedAt===b.browserUnavailableAt;
  const incidentTickets=same?incident!.tickets:0;
  const history=b?.rescueExecutionHistory??[];
  const recent=history.filter(h=>time(h.createdAt)>at-24*60*60_000);
  const base={canBegin:false,reason:'workspace_unavailable',eligibleTargets:[] as RescueTarget[],incidentTickets,rollingDayTickets:recent.length};
  if(!b?.enabled||b.testOnly||!input.config.inventoryVerified||input.config.workspaceId!==TARGET_WORKSPACE_ID)return base;
  if(b.globalFailureCode!=='browser_unavailable'||!b.lastError||!b.browserUnavailableAt||time(b.browserUnavailableAt)>at)return {...base,reason:'not_browser_failure'};
  if(rescueBlocksClaims(input))return {...base,reason:'rescue_owned'};
  if(b.lease||b.operationFailureOrigin||inheritedHolds(input)===null)return {...base,reason:'unsettled_operations'};
  if(!Number.isInteger(incidentTickets)||incidentTickets<0||incidentTickets>2||history.length>6||recent.some(h=>!safeId(h.clientId)||time(h.createdAt)>at))return {...base,reason:'invalid_budget_evidence'};
  if(incidentTickets>=2)return {...base,reason:'incident_quota'};
  if(recent.length>=6)return {...base,reason:'daily_quota',nextRetryAt:new Date(Math.min(...recent.map(h=>time(h.createdAt)))+24*60*60_000).toISOString()};
  const raw=input.requests.filter(r=>!input.config.protectedEmails.includes(r.email)&&r.email!==PROTECTED_OWNER_EMAIL&&
    !(b.holds??[]).some(h=>h.operation.kind!=='mail'&&h.operation.email===r.email)&&
    (r.status==='pending_removal'||r.status==='pending_invite'&&input.config.whitelist.includes(r.email)))
    .sort((a,b)=>(a.status==='pending_removal'?0:1)-(b.status==='pending_removal'?0:1)||a.createdAt.localeCompare(b.createdAt));
  const eligible=raw.map(r=>({kind:r.status==='pending_removal'?'remove' as const:'invite' as const,targetId:r.id,email:r.email,requestUpdatedAt:r.updatedAt}))
    .filter(t=>!same||!incident!.claimedTargets.some(x=>x.kind===t.kind&&x.targetId===t.targetId));
  if(!eligible.length)return {...base,reason:raw.length?'targets_exhausted':'no_targets'};
  return {...base,canBegin:true,reason:'eligible',eligibleTargets:eligible.slice(0,3)};
}

export function requireRescueExecution(input:BridgeState,args:{rescueId:string;token:string;expectedFailureId:string},now:string) {
  const b=requireFailure(input,args.expectedFailureId),t=b.faultRescue;
  if(!t||t.id!==args.rescueId||t.token!==args.token||t.failureId!==args.expectedFailureId||t.scope!=='approved_member_ops'||t.phase!=='pending')throw new Error('执行型处置凭证或执行权不匹配。');
  if(!t.expiresAt||time(now)>=time(t.expiresAt))throw new Error('执行型处置已超时，禁止领取或授权新写入。');
  if(b.globalFailureCode!=='browser_unavailable'||b.operationFailureOrigin||!ownHolds(input,t))throw new Error('新的全局故障或其它隔离项禁止执行型接管。');
  return t;
}

export function rescueSettlement(input:BridgeState,ticket:FaultRescueTicket) {
  const claims=(ticket.targets??[]).filter(t=>t.operationId);let verifiedCount=0,notStartedCount=0,isolatedCount=0,pendingCount=0;
  for(const target of claims) {
    const receipts=(input.codex?.receipts??[]).filter(r=>r.id===target.operationId&&r.email===target.email&&time(r.at)>=time(target.claimedAt??ticket.createdAt));
    if(receipts.length===1&&(receipts[0].kind===target.kind||target.kind==='remove'&&receipts[0].kind==='joined_during_revocation'))verifiedCount++;
    else if(receipts.length===1&&receipts[0].kind==='not_started')notStartedCount++;
    else if((input.codex?.holds??[]).some(h=>h.operation.id===target.operationId&&h.operation.rescueId===ticket.id&&h.operation.targetId===target.targetId&&
      h.operation.email===target.email&&h.operation.kind===target.kind&&['member_action','approval_required'].includes(h.code)))isolatedCount++;
    else pendingCount++;
  }
  return {canHandle:claims.length>0&&pendingCount===0&&(verifiedCount>0||isolatedCount>0),claimedCount:claims.length,verifiedCount,notStartedCount,isolatedCount,pendingCount};
}

export function prepareV13RollbackState(input:BridgeState,now:string) {
  const next=structuredClone(input),b=next.codex,t=b?.faultRescue;
  if(next.config.workspaceId!==TARGET_WORKSPACE_ID||next.config.automationEnabled||b?.enabled||b?.lease||b?.holds?.length||b?.operationFailureOrigin||
      t&&(t.phase!=='finished'||!['handled','recovered','unresolved','needs_human'].includes(t.outcome??'')))throw new Error('须关闭云端调度和成员执行，并先结清所有租约、隔离与故障票据。');
  if(t?.outcome==='handled'){t.outcome='unresolved';t.updatedAt=now;record(next,'prepare_v13_rollback_handled_normalized',now);}
  return next;
}
