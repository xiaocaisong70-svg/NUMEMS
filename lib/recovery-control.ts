import { PROTECTED_OWNER_EMAIL } from './seat-engine.ts';
import { validateObservation, TARGET_WORKSPACE_ID, type BridgeState } from './codex-bridge.ts';

export type RecoveryDiagnostic = { version: 1; stage: string; state: string; expectedUrl: string; observedAt: string };
export type RecoveryPhase = 'auto_recovery' | 'security_check' | 'interaction_required' | 'login_required' | 'waiting_codex' | 'review_required';
export type RecoveryProgress = { failureId: string; phase: RecoveryPhase; at: string; diagnostic?: RecoveryDiagnostic };
export type FaultRescueTicket = { id: string; token: string; failureId: string; phase: 'pending' | 'uncertain' | 'finished';
  scope: 'read_only_reconcile'; createdAt: string; updatedAt: string; operationId?: string;
  outcome?: 'recovered' | 'needs_human' | 'unresolved'; diagnostic?: RecoveryDiagnostic };
const phases: RecoveryPhase[] = ['auto_recovery','security_check','interaction_required','login_required','waiting_codex','review_required'];
const stages = ['page','members_navigation','invites_navigation','members_rows','invites_rows','capacity','snapshot'];
const diagnosticStates = ['loading','challenge','interaction_required','login','network','capacity_unavailable','workspace_mismatch'];
const time = (value: string) => { const n=Date.parse(value); if(!Number.isFinite(n))throw new Error('恢复时间无效。'); return n; };
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
export function publicFaultRescue(input: BridgeState) {
  const ticket=input.codex?.faultRescue;if(!ticket)return null;
  const {token: _secret,...view}=ticket;return structuredClone(view);
}
export function publicRecoveryProgress(input: BridgeState) {
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
  const old=b.recoveryProgress;
  if(old?.failureId===args.expectedFailureId && old.phase===args.phase &&
      JSON.stringify(old.diagnostic)===JSON.stringify(diagnostic))return next;
  b.recoveryProgress={failureId:args.expectedFailureId,phase:args.phase,at:now,...(diagnostic?{diagnostic}:{})};
  record(next,'recovery_progress_'+args.phase,now);return next;
}
/** This fence grants no member-action permission. The local broker separately
 * proves the worker has stopped before it delivers the read-only rescue. */
export function beginFaultRescue(input: BridgeState, args: {expectedFailureId: string}, credential: {id:string;token:string}, now: string): BridgeState {
  strictKeys(args,['expectedFailureId']);
  const next=structuredClone(input),b=requireFailure(next,args.expectedFailureId),old=b.faultRescue;
  if(old?.failureId===args.expectedFailureId)return next;
  if(rescueBlocksClaims(next))throw new Error('已有故障处置未结束，禁止创建另一个执行者。');
  if(!['browser_unavailable','login_expired','unknown'].includes(b.globalFailureCode!))
    throw new Error('角色、容量或工作空间故障不能自动交接。');
  if(b.lease && (b.lease.status!=='uncertain' || b.globalFailureCode!=='unknown' ||
      b.operationFailureOrigin?.operationId!==b.lease.id || b.operationFailureOrigin?.failureId!==args.expectedFailureId))
    throw new Error('原操作仍在办理或缺少不明结果来源，禁止接管。');
  const {id,token}=credential;
  if(typeof token!=='string' || token.length<16 || token.length>200 || typeof id!=='string' || !/^rescue_[a-zA-Z0-9_-]{16,100}$/.test(id) || id.includes(token))throw new Error('处置凭证无效。');
  b.faultRescue={id,token,failureId:args.expectedFailureId,phase:'pending',scope:'read_only_reconcile',
    createdAt:now,updatedAt:now,...(b.lease?{operationId:b.lease.id}:{})};
  if(b.recoveryProgress?.phase!=='interaction_required' && b.recoveryProgress?.phase!=='login_required')
    b.recoveryProgress={failureId:args.expectedFailureId,phase:'waiting_codex',at:now};
  record(next,'fault_rescue_pending',now);return next;
}
export function finishFaultRescue(input: BridgeState, args: {rescueId: string; token: string; expectedFailureId: string;
  outcome:'recovered'|'needs_human'|'unresolved'|'uncertain';agentStopped: boolean;diagnostic?: RecoveryDiagnostic}, now: string): BridgeState {
  strictKeys(args,['rescueId','token','expectedFailureId','outcome','agentStopped'],['diagnostic']);
  const next=structuredClone(input),b=requireWorkspace(next),t=b.faultRescue;
  if(!t || t.id!==args.rescueId || t.token!==args.token || t.failureId!==args.expectedFailureId)
    throw new Error('故障处置凭证或事件不匹配。');
  if(!['recovered','needs_human','unresolved','uncertain'].includes(args.outcome))throw new Error('处置结果无效。');
  if(typeof args.agentStopped!=='boolean')throw new Error('故障会话结束证明无效。');
  if(t.phase==='finished') {
    if(t.outcome!==args.outcome)throw new Error('已结案的处置不能改写结果。');
    return next;
  }
  if(args.outcome==='uncertain') {
    t.phase='uncertain';t.updatedAt=now;record(next,'fault_rescue_uncertain',now);return next;
  }
  if(args.agentStopped!==true)throw new Error('必须先确认故障会话已经结束，才能交还执行权。');
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
