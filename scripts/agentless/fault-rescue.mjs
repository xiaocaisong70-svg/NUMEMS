import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {readJson,atomicJson} from './journal.mjs';

const codes=new Set(['browser_unavailable','login_expired','unknown']);
const finalOutcomes=new Set(['recovered','unresolved','needs_human']);
const outcomes=new Set([...finalOutcomes,'uncertain']);
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,240}$/.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const planOf=value=>value?.plan??value;
export const faultRescueFile=directory=>path.join(directory,'fault-rescue.json');
const ackFile=directory=>path.join(directory,'fault-rescue-ack.json');
const fresh=(value,now,max=60_000)=>stamp(value)&&Date.parse(value)<=now+5000&&now-Date.parse(value)<=max;
const validRecord=r=>r?.version===1&&safeId(r.failureId)&&safeId(r.clientId)&&safeId(r.threadId)&&stamp(r.createdAt);
const validTicket=(t,failureId)=>t&&safeId(t.id)&&typeof t.token==='string'&&t.token.length>=16&&t.token.length<=200&&
  t.failureId===failureId&&t.scope==='read_only_reconcile';
const summary=r=>({state:r?.phase??'idle',rescueId:r?.ticket?.id??null,failureId:r?.failureId??null,
  ...(r?.outcome?{outcome:r.outcome}:{}),...(r?.reason?{reason:r.reason}:{}),
  wakeAttempts:r?.dispatchStartedAt?1:0,modelUsage:r?.dispatchStartedAt?'reported_by_codex':'not_requested'});

export function faultRescueGate(record) {
  if(record===null||record===undefined)return {allowWorker:true,reason:'no_fault_rescue'};
  if(!validRecord(record))
    return {allowWorker:false,reason:'fault_rescue_evidence_invalid'};
  if(record.phase==='finished'&&finalOutcomes.has(record.outcome)&&record.agentStopped===true)
    return {allowWorker:true,reason:'fault_rescue_finished'};
  return {allowWorker:false,reason:'fault_rescue_owns_recovery'};
}

function settings(config) {
  const c=config?.faultRescue;
  if(c?.enabled!==true||config?.liveActions!==true)return null;
  if(!safeId(c.threadId)||c.scope!=='read_only_reconcile'||typeof config.adminEmail!=='string'||typeof config.workspaceId!=='string')
    throw new Error('Fault rescue configuration is invalid.');
  return c;
}
function assertPlan(p,config) {
  if(!p||p.enabled!==true||p.testOnly!==false||p.workspaceId!==config.workspaceId||p.administrator!==config.adminEmail)
    throw new Error('Fault rescue requires the matching formal workspace and administrator.');
}
function matchesJournal(j,p) {
  if(!j)return !p.lease;
  if(j.phase==='settled'&&j.lease==null&&j.receipt==null)return !p.lease;
  return !!j.lease&&!!p.lease&&p.lease.status==='uncertain'&&
    ['id','token','kind','targetId','email'].every(k=>j.lease[k]===p.lease[k]);
}

/** Called inside a short, exclusive administrator metadata session AFTER the
 * routine worker has stopped. Persist before the claim; do not enqueue here. */
export async function prepareFaultRescue({directory,config,portal,hostSafe,journalState=null,
  clock=()=>new Date(),newId=randomUUID}) {
  const c=settings(config);if(!c)return {state:'disabled',modelCalls:0};
  if(hostSafe!==true)throw new Error('The routine executor has not been proven stopped.');
  const p=planOf(await portal.call('seat_portal_status'));assertPlan(p,config);
  if(!p.globalFailureCode||!safeId(p.globalFailureId))return {state:'idle',modelCalls:0};
  if(!codes.has(p.globalFailureCode)||!matchesJournal(journalState,p))
    throw new Error('Fault scope or original journal cannot be verified.');
  const file=faultRescueFile(directory),previous=await readJson(file);
  if(previous) {
    if(!validRecord(previous))throw new Error('Existing fault rescue evidence is invalid; preserve it for review.');
    if(previous.failureId===p.globalFailureId) {
      if(previous.dispatchStartedAt||!['preparing','uncertain'].includes(previous.phase)||
         previous.phase==='uncertain'&&previous.reason!=='cloud_ticket_result_unknown')return summary(previous);
      // begin is idempotent for the same server failure; no message dispatch
      // ever existed in these exact local phases, so retrieve its original receipt.
      const response=await portal.call('begin_fault_rescue',{expectedFailureId:previous.failureId});
      const ticket=response.ticket;
      if(!validTicket(ticket,previous.failureId)||ticket.phase!=='pending')
        return summary(previous);
      const restored={...previous,phase:'prepared',ticket,updatedAt:clock().toISOString()};delete restored.reason;
      await atomicJson(file,restored);return summary(restored);
    }
    if(!faultRescueGate(previous).allowWorker)throw new Error('A previous rescue still owns recovery.');
    // Only a verified health epoch may authorize a new incident. A changed
    // failure ID or process restart alone cannot produce a wake storm.
    const health=await readJson(path.join(directory,'browser-retry.json'));
    const provenRecovery=previous.outcome==='recovered'&&previous.agentStopped===true||
      health?.version===2&&health.state==='healthy'&&health.workspaceId===config.workspaceId&&health.administrator===config.adminEmail&&
      stamp(health.healthyAt)&&stamp(health.officialObservedAt)&&Date.parse(health.officialObservedAt)<=Date.parse(health.healthyAt)&&
      Date.parse(health.healthyAt)-Date.parse(health.officialObservedAt)<=60_000&&Date.parse(health.healthyAt)<=clock().getTime()&&
      Date.parse(health.officialObservedAt)>Date.parse(previous.createdAt);
    if(!provenRecovery)
      return {state:'suppressed',reason:'same_continuous_failure',modelCalls:0};
  }
  const at=clock().toISOString();
  let record={version:1,phase:'preparing',failureId:p.globalFailureId,failureCode:p.globalFailureCode,
    clientId:'numems-fault:'+newId(),threadId:c.threadId,createdAt:at,updatedAt:at,
    timeoutSeconds:Number.isInteger(c.timeoutSeconds)&&c.timeoutSeconds>=30&&c.timeoutSeconds<=600?c.timeoutSeconds:300,
    targetIds:[...(p.removals??[]),...(p.invites??[]),...(p.awaitingAcceptance??[])]
      .map(item=>item.id).filter(safeId).slice(0,20),
    ...(p.lease?{originalOperationId:p.lease.id}:{}),
    history:[...(previous?.history??[]),...(previous?[{failureId:previous.failureId,outcome:previous.outcome,createdAt:previous.createdAt}]:[])].slice(-32)};
  await atomicJson(file,record);
  try {
    const response=await portal.call('begin_fault_rescue',{expectedFailureId:record.failureId});
    const ticket=response.ticket;
    if(!validTicket(ticket,record.failureId))
      throw new Error('Rescue ownership receipt is incomplete.');
    if(ticket.phase!=='pending')throw new Error('The failure has already owned a rescue; no new wake.');
    record={...record,phase:'prepared',ticket,updatedAt:clock().toISOString()};
  } catch {
    record={...record,phase:'uncertain',reason:'cloud_ticket_result_unknown',updatedAt:clock().toISOString()};
  }
  await atomicJson(file,record);return summary(record);
}

export function faultRescuePrompt(record,projectRoot) {
  if(!validRecord(record)||!validTicket(record.ticket,record.failureId)||!codes.has(record.failureCode)||
      !Array.isArray(record.targetIds)||record.targetIds.length>20||!record.targetIds.every(safeId)||
      record.originalOperationId!==undefined&&!safeId(record.originalOperationId)||!path.isAbsolute(projectRoot))
    throw new Error('Fault rescue prompt identity is invalid.');
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const budget=Number.isInteger(record.timeoutSeconds)&&record.timeoutSeconds>=30&&record.timeoutSeconds<=600?record.timeoutSeconds:300;
  const ack=quote(path.join(projectRoot,'scripts/agentless/fault-rescue-ack.mjs'));
  const meta={rescueId:record.ticket.id,failureId:record.failureId,failureCode:record.failureCode,
    targetIds:record.targetIds??[],...(record.originalOperationId?{originalOperationId:record.originalOperationId}:{})};
  return `NUMEMS 一次性故障诊断 [${record.ticket.id}]
这是用户授权的异常后备，普通邀请和回收继续由脚本执行。本次仅诊断及核对原回执，不进行新的成员写入。
定位数据：${JSON.stringify(meta)}
项目：${projectRoot}
先读取 AUTOMATION.md 和 .sites-runtime/agentless/fault-rescue.json，确认同一故障、救援凭证、本机执行器已停止；令牌仅本机使用，不得输出到聊天、日志或其它站点。仅可读取本项目的 .sites-runtime/agentless/{status,host-desktop,admin-result,operation}.json 诊断记录，禁止读取无关文件或其它账号数据。
Cloudflare challenge 仅代表安全检查，不证明必须人工验证。允许正常等待；禁止点击/解决验证码、伪装浏览器、复制 Cookie、自动填密码或接受新的权限同意。
禁止新的邀请、撤邀或移除，禁止创建测试、改截止时间/白名单/席位数量、修改源码或重启日常执行器。只可在互斥与原租约核验通过后调用现有 host.mjs admin status、recover-browser 或 reconcile；原操作结果不明必须保留原租约，不重发或重做。无法获得必要审批时停下，不绕过审批。
只处理这一事件，不创建其它任务、不向其它聊天发送消息、不运行模型轮询。处置预算 ${budget} 秒；准备结束时使用下列命令登记请求（不是证明模型已停止，也不会自行恢复脚本）：
node ${ack} --rescue-id ${quote(record.ticket.id)} --outcome unresolved
如已通过原脚本通道的新鲜官方核对，可将 outcome 改为 recovered；仅在官方明确显示需本人操作的控件/登录时可用 needs_human；原结果仍不明可用 uncertain。泛化 challenge 保持 unresolved。执行后立即结束本轮，简短报告事实和不确定性。普通程序会独立检查本轮实际结束及官方证据后再交回脚本。`;
}

/** Called only AFTER the metadata browser and worker lock are closed. */
export async function dispatchPreparedFaultRescue({directory,client,hostSafe,projectRoot,
  clock=()=>new Date()}) {
  if(hostSafe!==true)throw new Error('Metadata session or routine worker still owns the browser.');
  const file=faultRescueFile(directory);let r=await readJson(file);
  if(!r)return {state:'idle',modelCalls:0};
  if(r.phase!=='prepared')return summary(r);
  const prompt=faultRescuePrompt(r,projectRoot);
  // This immutable per-client witness closes the simultaneous-watchdog race.
  // A crash after creating it but before enqueue remains held, never resent.
  const witness=path.join(directory,'fault-rescue-dispatch-'+createHash('sha256').update(r.clientId).digest('hex')+'.json');
  let handle;
  try {handle=await open(witness,'wx',0o600);}
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const latest=await readJson(file);
    if(latest?.clientId!==r.clientId)throw new Error('Fault rescue identity changed before dispatch.');
    // The witness may belong to a still-running supervisor. Never overwrite
    // its eventual sending/queued receipt with a stale local read.
    return {...summary(latest),reason:'dispatch_intent_already_exists'};
  }
  try {await handle.writeFile(JSON.stringify({version:1,clientId:r.clientId,rescueId:r.ticket.id,createdAt:clock().toISOString()}));}
  finally {await handle.close();}
  r={...r,phase:'sending',dispatchStartedAt:clock().toISOString(),updatedAt:clock().toISOString()};
  await atomicJson(file,r); // BEFORE the only inference-starting protocol call.
  try {
    const response=await client.enqueue(r.threadId,r.clientId,prompt),id=response?.queuedSubmission?.id;
    if(!safeId(id))throw new Error('Queue receipt missing');
    r={...r,phase:'queued',queuedId:id,queuedAt:clock().toISOString(),updatedAt:clock().toISOString()};
  } catch {r={...r,phase:'uncertain',reason:'queue_result_unknown',updatedAt:clock().toISOString()};}
  await atomicJson(file,r);return summary(r);
}

/** Queue absence never permits resending an interrupted/ambiguous dispatch. */
export async function reconcileFaultRescueDispatch({directory,client,clock=()=>new Date()}) {
  const file=faultRescueFile(directory);let r=await readJson(file);
  if(!r||!['sending','uncertain'].includes(r.phase)||!r.dispatchStartedAt)return summary(r);
  let entries;
  try {entries=await client.queued(r.threadId);}catch{return summary(r);}
  const matches=entries.filter(x=>x.clientUserMessageId===r.clientId||x.clientId===r.clientId);
  if(matches.length===1&&safeId(matches[0].id)) {
    r={...r,phase:'queued',queuedId:matches[0].id,updatedAt:clock().toISOString()};delete r.reason;
  } else {r={...r,phase:'uncertain',reason:matches.length?'queue_receipt_ambiguous':'queue_receipt_not_found',updatedAt:clock().toISOString()};}
  await atomicJson(file,r);return summary(r);
}

export async function requestFaultRescueAck({directory,rescueId,outcome,clock=()=>new Date()}) {
  const r=await readJson(faultRescueFile(directory));
  if(!r?.ticket||r.ticket.id!==rescueId||!outcomes.has(outcome)||
     !['queued','sending','uncertain'].includes(r.phase)||!r.dispatchStartedAt)
    throw new Error('ACK must match the dispatched rescue and a supported outcome.');
  const previous=await readJson(ackFile(directory));
  if(previous?.rescueId===rescueId) {
    if(previous.outcome!==outcome)throw new Error('Conflicting ACK request preserved.');
    return {requested:true,rescueId,outcome};
  }
  await atomicJson(ackFile(directory),{version:1,rescueId,clientId:r.clientId,outcome,
    requestedAt:clock().toISOString(),notStoppedProof:true});
  return {requested:true,rescueId,outcome};
}

function stoppedProof(proof,r,now) {
  return proof?.kind==='codex_turn_state'&&proof.confirmed===true&&proof.stopped===true&&
    proof.source==='app_server_thread_read'&&proof.threadId===r.threadId&&proof.clientUserMessageId===r.clientId&&
    safeId(proof.turnId)&&safeId(proof.linkedTurnId)&&['completed','failed','interrupted'].includes(proof.status)&&
    fresh(proof.observedAt,now)&&(!r.queuedId||proof.queuedId===r.queuedId);
}
function explicitHumanDiagnostic(d,now) {
  if(!d||Object.keys(d).sort().join(',')!=='expectedUrl,observedAt,stage,state,version'||d.version!==1||
    !['page','members_navigation','invites_navigation','members_rows','invites_rows','capacity','snapshot'].includes(d.stage)||
    !['interaction_required','login'].includes(d.state)||!fresh(d.observedAt,now))return false;
  let u;try{u=new URL(d.expectedUrl);}catch{return false;}
  return u.origin==='https://admin.openai.com'&&!u.search&&!u.hash&&!u.username&&!u.password&&
    /^\/workspace\/[a-zA-Z0-9_-]+\/members$/.test(u.pathname);
}

/** The model can request an outcome, but only an exact server turn-completion
 * proof and the backend's independent fresh-state gates can end ownership. */
export async function settleFaultRescue({directory,portal,client,hostSafe,verifiedRecovery,readDiagnostic=async()=>null,
  clock=()=>new Date()}) {
  if(hostSafe!==true)throw new Error('Cannot settle while a routine executor is alive.');
  const file=faultRescueFile(directory);let r=await readJson(file);
  if(!r||r.phase==='finished'||r.outcome==='uncertain'&&r.agentStopped===true)return summary(r);
  if(!validRecord(r))throw new Error('Fault rescue evidence is invalid; preserve it for review.');
  if(r.phase==='finishing'||r.reason==='finish_result_unknown') {
    const response=await portal.call('fault_rescue_status');
    const t=response.ticket;
    if(t?.id===r.ticket?.id&&(t.phase==='finished'&&t.outcome===r.finishIntent?.outcome||
        t.phase==='uncertain'&&r.finishIntent?.outcome==='uncertain')) {
      r={...r,phase:t.phase,outcome:r.finishIntent.outcome,agentStopped:true,updatedAt:clock().toISOString()};delete r.reason;
      await atomicJson(file,r);
    }
    return summary(r);
  }
  if(!r.ticket||!r.dispatchStartedAt)return summary(r);
  const identity={threadId:r.threadId,clientUserMessageId:r.clientId,queuedId:r.queuedId??null};
  const proof=await client.observeTurnState(identity);
  const now=clock().getTime();
  if(!stoppedProof(proof,r,now)) {
    const linked=proof?.confirmed===true&&proof.source==='app_server_thread_read'&&
      proof.threadId===r.threadId&&proof.clientUserMessageId===r.clientId;
    if(linked&&proof.stopped===false&&stamp(proof.startedAt)&&
       Date.parse(proof.startedAt)>=Date.parse(r.dispatchStartedAt)-5000&&now-Date.parse(proof.startedAt)>(r.timeoutSeconds??300)*1000) {
      r={...r,budgetExceededAt:r.budgetExceededAt??clock().toISOString(),updatedAt:clock().toISOString()};
      if(proof.exclusiveTurn===true&&!r.interruptRequestedAt&&typeof client.interruptTrackedTurn==='function') {
        r.interruptRequestedAt=clock().toISOString();await atomicJson(file,r);
        try {await client.interruptTrackedTurn(identity,proof);}catch{r.reason='interrupt_result_unknown';}
      }
      await atomicJson(file,r);
      return {...summary(r),reason:'agent_budget_exceeded_stop_unconfirmed'};
    }
    return {...summary(r),reason:'agent_stop_unconfirmed'};
  }
  const ack=await readJson(ackFile(directory));
  const matchingAck=ack?.rescueId===r.ticket.id&&ack.clientId===r.clientId&&outcomes.has(ack.outcome);
  let outcome=matchingAck?ack.outcome:'unresolved',diagnostic;
  // A fresh kernel check is authoritative in either direction. The model can
  // neither veto verified health nor invent it by choosing an optimistic ACK.
  if(verifiedRecovery===true)outcome='recovered';
  else {
    if(outcome==='recovered'&&verifiedRecovery===false)outcome='unresolved';
    diagnostic=await readDiagnostic();
    const explicit=explicitHumanDiagnostic(diagnostic,clock().getTime())&&
      (r.failureCode==='browser_unavailable'&&diagnostic.state==='interaction_required'||
       ['browser_unavailable','login_expired'].includes(r.failureCode)&&diagnostic.state==='login');
    if(explicit)outcome='needs_human';
    else if(outcome==='needs_human')outcome='unresolved';
  }
  const args={rescueId:r.ticket.id,token:r.ticket.token,expectedFailureId:r.failureId,
    outcome,agentStopped:true,...(outcome==='needs_human'?{diagnostic}: {})};
  // Store only lifecycle metadata. The original ticket token remains protected
  // in this local file and never appears in the return value or wake prompt.
  r={...r,phase:'finishing',finishIntent:{outcome},agentProof:proof,updatedAt:clock().toISOString()};
  await atomicJson(file,r);
  try {
    const response=await portal.call('finish_fault_rescue',args),t=response.ticket;
    if(t?.id!==r.ticket.id||t.phase!==(outcome==='uncertain'?'uncertain':'finished')||outcome!=='uncertain'&&t.outcome!==outcome)
      throw new Error('Finish receipt does not match the original rescue.');
    r={...r,phase:outcome==='uncertain'?'uncertain':'finished',outcome,agentStopped:true,updatedAt:clock().toISOString()};
    delete r.reason;
  } catch {r={...r,phase:'uncertain',reason:'finish_result_unknown',updatedAt:clock().toISOString()};}
  await atomicJson(file,r);return summary(r);
}
