import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {readJson,atomicJson} from './journal.mjs';
import {acceptanceDue} from '../seat-executor/core.mjs';

const codes=new Set(['browser_unavailable','login_expired','unknown']);
const scopes=new Set(['read_only_reconcile','approved_member_ops']);
const finalOutcomes=new Set(['recovered','unresolved','needs_human','handled']);
const outcomes=new Set([...finalOutcomes,'uncertain']);
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,240}$/.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const planOf=value=>value?.plan??value;
export const faultRescueFile=directory=>path.join(directory,'fault-rescue.json');
const ackFile=directory=>path.join(directory,'fault-rescue-ack.json');
const witnessFile=(directory,r)=>path.join(directory,'fault-rescue-dispatch-'+createHash('sha256').update(r.clientId).digest('hex')+'.json');
const fresh=(value,now,max=60_000)=>stamp(value)&&Date.parse(value)<=now+5000&&now-Date.parse(value)<=max;
const validRecord=r=>r?.version===1&&safeId(r.failureId)&&safeId(r.clientId)&&safeId(r.threadId)&&stamp(r.createdAt);
const validTicket=(t,failureId)=>t&&safeId(t.id)&&typeof t.token==='string'&&t.token.length>=16&&t.token.length<=200&&
  t.failureId===failureId&&scopes.has(t.scope)&&(t.scope!=='approved_member_ops'||
    stamp(t.createdAt)&&stamp(t.expiresAt)&&Date.parse(t.expiresAt)>Date.parse(t.createdAt)&&
    Date.parse(t.expiresAt)-Date.parse(t.createdAt)<=300_000&&Array.isArray(t.targets)&&t.targets.length>=1&&t.targets.length<=3&&
    t.targets.every(x=>['invite','remove'].includes(x.kind)&&safeId(x.targetId)&&typeof x.email==='string'&&
      x.email===x.email.trim().toLowerCase()&&x.email.includes('@')&&stamp(x.requestUpdatedAt)));
const summary=r=>({state:r?.phase??'idle',rescueId:r?.ticket?.id??null,failureId:r?.failureId??null,
  ...(r?.outcome?{outcome:r.outcome}:{}),...(r?.reason?{reason:r.reason}:{}),
  ...(r?.ticket?.scope?{scope:r.ticket.scope}:{}),...(r?.ticket?.expiresAt?{expiresAt:r.ticket.expiresAt}:{}),
  wakeAttempts:r?.dispatchStartedAt?1:0,modelUsage:r?.dispatchStartedAt?'reported_by_codex':'not_requested'});

export function faultRescueDeadline(r) {
  if(r?.ticket?.scope==='approved_member_ops'&&stamp(r.ticket.expiresAt))return Date.parse(r.ticket.expiresAt);
  const created=r?.ticket?.createdAt??r?.createdAt;
  return stamp(created)?Date.parse(created)+(r.timeoutSeconds??300)*1000:null;
}

/** No model ever started in this branch. The permanent witness cancels any
 * concurrent dispatcher before metadata-only ticket cancellation can finish. */
export async function settleUndispatchedFaultRescue({directory,portal,hostSafe,clock=()=>new Date()}) {
  if(hostSafe!==true)throw new Error('Undispatched rescue requires the stopped host.');
  const file=faultRescueFile(directory);let r=await readJson(file);
  if(!validRecord(r)||!validTicket(r.ticket,r.failureId)||r.dispatchStartedAt)return null;
  const due=faultRescueDeadline(r);
  if(r.pendingCount!==0&&!(due!==null&&clock().getTime()>=due))return null;
  let handle;
  try {handle=await open(witnessFile(directory,r),'wx',0o600);}
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const witness=await readJson(witnessFile(directory,r));
    if(witness?.cancelled!==true||witness.clientId!==r.clientId||witness.rescueId!==r.ticket.id)return null;
  }
  if(handle)try {await handle.writeFile(JSON.stringify({version:1,clientId:r.clientId,rescueId:r.ticket.id,cancelled:true,createdAt:clock().toISOString()}));}
  finally {await handle.close();}
  r={...r,phase:'finishing',notDispatched:true,finishIntent:{outcome:'unresolved'},
    agentProof:{kind:'not_dispatched',stopped:true,clientUserMessageId:r.clientId,source:'local_dispatch_cancelled',observedAt:clock().toISOString()},
    updatedAt:clock().toISOString()};await atomicJson(file,r);
  try {
    const response=await portal.call('finish_fault_rescue',{rescueId:r.ticket.id,token:r.ticket.token,
      expectedFailureId:r.failureId,outcome:'unresolved',agentStopped:true});
    if(response.ticket?.id!==r.ticket.id||response.ticket.phase!=='finished'||response.ticket.outcome!=='unresolved')throw new Error('Cancellation receipt mismatch');
    r={...r,phase:'finished',outcome:'unresolved',agentStopped:true,reason:'cancelled_before_dispatch',updatedAt:clock().toISOString()};
  }catch {r={...r,phase:'uncertain',reason:'finish_result_unknown',updatedAt:clock().toISOString()};}
  await atomicJson(file,r);return summary(r);
}

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
  if(!safeId(c.threadId)||!scopes.has(c.scope)||typeof config.adminEmail!=='string'||typeof config.workspaceId!=='string')
    throw new Error('Fault rescue configuration is invalid.');
  return c;
}
function assertPlan(p,config) {
  if(!p||p.enabled!==true||p.testOnly!==false||p.workspaceId!==config.workspaceId||p.administrator!==config.adminEmail)
    throw new Error('Fault rescue requires the matching formal workspace and administrator.');
}
function matchesJournal(j,p) {
  if(!j)return !p.lease;
  if(j.phase==='settled'&&j.lease==null&&j.receipt==null&&j.submission==null)return !p.lease;
  return !!j.lease&&!!p.lease&&p.lease.status==='uncertain'&&
    ['id','token','kind','targetId','email'].every(k=>j.lease[k]===p.lease[k]);
}

/** Fresh queue output is authoritative; this local projection only filters
 * held/protected targets and never grants a claim or reorders server targets. */
export function faultRescueWork(p,config,now=Date.now()) {
  const allowed=(kind,item)=>safeId(item?.id)&&typeof item.email==='string'&&item.email.trim().toLowerCase()!==config.adminEmail&&
    !(p.blockedOperations??[]).some(h=>h.operation?.kind!=='mail'&&
      (h.operation?.email===item.email||h.operation?.targetId===item.id));
  const actions=['remove','invite'].flatMap(kind=>(p[kind==='remove'?'removals':'invites']??[])
    .filter(item=>allowed(kind,item)).map(item=>({kind,targetId:item.id})));
  const acceptance=(p.awaitingAcceptance??[]).filter(item=>allowed('acceptance',item)&&acceptanceDue(item,now));
  const original=!!p.lease&&['invite','remove'].includes(p.lease.kind)&&p.lease.status==='uncertain'&&
    p.lease.email!==config.adminEmail;
  return {actions,acceptanceIds:acceptance.map(x=>x.id),pendingCount:actions.length+acceptance.length+(original?1:0),original};
}

const beginArguments=r=>({expectedFailureId:r.failureId,scope:r.scope??r.ticket?.scope??'read_only_reconcile',
  ...((r.scope??r.ticket?.scope)==='approved_member_ops'?{clientId:r.clientId}:{})});
const remember=r=>({failureId:r.failureId,outcome:r.outcome,createdAt:r.createdAt,clientId:r.clientId,
  scope:r.ticket?.scope??r.scope??'read_only_reconcile',ticketId:r.ticket?.id});

async function reconcileRejectedBegin(record,error,portal,config,clock) {
  if(error?.definitelyRejected!==true||error.operation!=='begin_fault_rescue'||record.dispatchStartedAt)return null;
  const response=await portal.call('fault_rescue_status'),p=planOf(response);assertPlan(p,config);
  const t=response.ticket;
  if(p.busy||p.lease)return null;
  const absent=!t||(t.clientId!==record.clientId&&
    (record.scope==='approved_member_ops'||t.id===record.priorTicketId));
  if(!absent)return null;
  return {...record,phase:'finished',outcome:'unresolved',agentStopped:true,notDispatched:true,
    reason:'server_refused_begin',updatedAt:clock().toISOString()};
}

/** Called inside a short, exclusive administrator metadata session AFTER the
 * routine worker has stopped. Persist before the claim; do not enqueue here. */
export async function prepareFaultRescue({directory,config,portal,hostSafe,journalState=null,
  clock=()=>new Date(),newId=randomUUID}) {
  const c=settings(config);if(!c)return {state:'disabled',modelCalls:0};
  if(hostSafe!==true)throw new Error('The routine executor has not been proven stopped.');
  if(typeof portal.refreshQueue==='function')await portal.refreshQueue();else await portal.call('refresh_seat_queue');
  const p=planOf(await portal.call('seat_portal_status'));assertPlan(p,config);
  const work=faultRescueWork(p,config,clock().getTime());
  await atomicJson(path.join(directory,'fault-rescue-plan.json'),{version:1,checkedAt:clock().toISOString(),
    failureId:p.globalFailureId??null,failureCode:p.globalFailureCode??null,pendingCount:work.pendingCount,
    actionCount:work.actions.length,acceptanceCount:work.acceptanceIds.length,
    ...(p.memberRescue?{rescueCanBegin:p.memberRescue.canBegin,rescueReason:p.memberRescue.reason}:{}),
    nextCheckAt:new Date(clock().getTime()+60_000).toISOString()});
  if(!p.globalFailureCode||!safeId(p.globalFailureId))return {state:'idle',modelCalls:0};
  if(!codes.has(p.globalFailureCode)||!matchesJournal(journalState,p))
    throw new Error('Fault scope or original journal cannot be verified.');
  const file=faultRescueFile(directory),previous=await readJson(file);
  const restoring=previous&&previous.failureId===p.globalFailureId&&!previous.dispatchStartedAt&&
    ['preparing','uncertain'].includes(previous.phase)&&previous.reason!=='dispatch_intent_already_exists';
  if(!work.pendingCount&&!restoring) {
    if(previous?.phase==='prepared'&&!previous.dispatchStartedAt) {
      await atomicJson(file,{...previous,pendingCount:0,updatedAt:clock().toISOString()});
      return {...summary(previous),reason:'pending_work_cancelled'};
    }
    return {state:'idle',reason:'no_valid_pending_work',pendingCount:0,modelCalls:0};
  }
  const wantsMember=c.scope==='approved_member_ops'&&p.globalFailureCode==='browser_unavailable'&&!p.lease&&!p.busy&&work.actions.length>0;
  const memberScope=wantsMember&&(p.memberRescue?.canBegin===true||!(p.blockedOperations??[]).length);
  const desiredScope=memberScope?'approved_member_ops':'read_only_reconcile';
  const existingOwn=previous&&previous.failureId===p.globalFailureId&&!faultRescueGate(previous).allowWorker;
  if(wantsMember&&p.memberRescue?.canBegin===false&&!restoring&&!existingOwn)
    return {state:'suppressed',reason:'member_rescue_'+p.memberRescue.reason,pendingCount:work.pendingCount,modelCalls:0};
  if(previous) {
    if(!validRecord(previous))throw new Error('Existing fault rescue evidence is invalid; preserve it for review.');
    if(previous.phase==='prepared'&&!previous.dispatchStartedAt&&previous.ticket?.scope==='approved_member_ops') {
      const available=previous.ticket.targets.filter(target=>work.actions.some(x=>x.kind===target.kind&&x.targetId===target.targetId)&&
        (p[target.kind==='remove'?'removals':'invites']??[]).some(x=>x.id===target.targetId&&x.email===target.email&&x.updatedAt===target.requestUpdatedAt));
      const checked={...previous,pendingCount:available.length,updatedAt:clock().toISOString()};
      await atomicJson(file,checked);return {...summary(checked),...(available.length?{}:{reason:'pending_work_cancelled'})};
    }
    const repeatMember=previous.failureId===p.globalFailureId&&faultRescueGate(previous).allowWorker&&memberScope&&
      ['handled','unresolved','needs_human'].includes(previous.outcome)&&
      ((previous.history??[]).filter(x=>x.ticketId&&x.scope==='approved_member_ops'&&x.failureId===p.globalFailureId).length+
        (previous.ticket?.scope==='approved_member_ops'?1:0))<2;
    if(previous.failureId===p.globalFailureId&&!repeatMember) {
      if(previous.dispatchStartedAt||!['preparing','uncertain'].includes(previous.phase)||
         previous.phase==='uncertain'&&previous.reason!=='cloud_ticket_result_unknown')return summary(previous);
      // begin is idempotent for the same server failure; no message dispatch
      // ever existed in these exact local phases, so retrieve its original receipt.
      let response;
      try {response=await portal.call('begin_fault_rescue',beginArguments(previous));}
      catch(error) {
        let rejected;try {rejected=await reconcileRejectedBegin(previous,error,portal,config,clock);}catch{}
        if(rejected) {await atomicJson(file,rejected);return summary(rejected);}
        return summary(previous);
      }
      const ticket=response.ticket;
      if(!validTicket(ticket,previous.failureId)||ticket.phase!=='pending')
        return summary(previous);
      const restored={...previous,phase:'prepared',ticket,pendingCount:work.pendingCount,updatedAt:clock().toISOString()};delete restored.reason;
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
    if(!provenRecovery&&!repeatMember)
      return {state:'suppressed',reason:'same_continuous_failure',modelCalls:0};
  }
  const at=clock().toISOString();
  let record={version:1,phase:'preparing',scope:desiredScope,pendingCount:work.pendingCount,failureId:p.globalFailureId,failureCode:p.globalFailureCode,
    clientId:'numems-fault:'+newId(),threadId:c.threadId,createdAt:at,updatedAt:at,
    timeoutSeconds:desiredScope==='approved_member_ops'?300:
      Number.isInteger(c.timeoutSeconds)&&c.timeoutSeconds>=30&&c.timeoutSeconds<=600?c.timeoutSeconds:300,
    targetIds:[...work.actions.map(x=>x.targetId),...work.acceptanceIds,...(work.original?[p.lease.targetId]:[])].filter(safeId).slice(0,20),
    ...(p.lease?{originalOperationId:p.lease.id}:{}),
    priorTicketId:p.faultRescue?.id??previous?.ticket?.id??null,
    history:[...(previous?.history??[]),...(previous?[remember(previous)]:[])].slice(-32)};
  await atomicJson(file,record);
  try {
    const response=await portal.call('begin_fault_rescue',beginArguments(record));
    if(response.refused) {
      record={...record,phase:'finished',outcome:'unresolved',agentStopped:true,notDispatched:true,
        reason:'server_refused_'+String(response.refused).replace(/[^a-z_]/g,'').slice(0,50),updatedAt:clock().toISOString()};
      await atomicJson(file,record);return summary(record);
    }
    const ticket=response.ticket;
    if(!validTicket(ticket,record.failureId))
      throw new Error('Rescue ownership receipt is incomplete.');
    if(ticket.phase!=='pending')throw new Error('The failure has already owned a rescue; no new wake.');
    if(ticket.scope!==desiredScope)throw new Error('Rescue capability receipt scope changed.');
    record={...record,phase:'prepared',ticket,
      ...(ticket.scope==='approved_member_ops'?{targetIds:ticket.targets.map(x=>x.targetId)}:{}),updatedAt:clock().toISOString()};
  } catch(error) {
    let rejected;try {rejected=await reconcileRejectedBegin(record,error,portal,config,clock);}catch{}
    record=rejected??{...record,phase:'uncertain',reason:'cloud_ticket_result_unknown',updatedAt:clock().toISOString()};
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
  const context=quote(path.join(projectRoot,'scripts/agentless/fault-rescue-context.mjs'));
  const meta={rescueId:record.ticket.id,failureId:record.failureId,failureCode:record.failureCode,
    targetIds:record.targetIds??[],...(record.originalOperationId?{originalOperationId:record.originalOperationId}:{})};
  if(record.ticket.scope==='approved_member_ops') {
    return `NUMEMS V14 一次性成员办理后备 [${record.ticket.id}]
用户已授权：仅在普通执行器有限失败后，通过已有官方 IAB 正常管理员会话办理本票据冻结的有效普通员工申请。脚本仍为日常主执行者。本消息不是新的用户任务，不取消当前开发工作；不得创建或转发其它聊天。
定位数据：${JSON.stringify({...meta,scope:record.ticket.scope,expiresAt:record.ticket.expiresAt})}
项目：${projectRoot}
写入能力在服务端票据 ${record.ticket.expiresAt} 到期，排队也消耗这五分钟，不得从模型启动时重新计时。先读本项目 AUTOMATION.md；不得读取无关账号/文件或改变配置。普通 worker、原生宿主和锁必须已退出；任何证据不明即停止。
秘密只保存在受保护的本机记录和 functions.exec 会话内存。调用 functions.exec 包裹 tools.exec_command，运行 node ${context} --rescue-id ${quote(record.ticket.id)} --credential；将返回值的 output 用 JSON.parse 后 store('numemsRescue',...)，不要 text、notify、console.log、写日志或在聊天/代码文字里展开 token，也不要把秘密写入持久化函数文件。仅输出 credentialLoaded、票据ID和脱敏状态。默认不带 --credential 的入口只返回脱敏信息。
随后发现当前已连接 NUMEMS 应用：通过 ALL_TOOLS 查找 claim_rescue_operation、authorize_rescue_action、seat_portal_status 等，必须唯一定位同一工具命名空间。API 调用同样放在 functions.exec 内，解析 structuredContent 或 content.text 后仅存会话内存，不输出完整含 token 回执。立刻只读 status，必须与本机票据ID、failureId、scope、期限和目标一致；有其它 lease/票据或站点不明则 unresolved，不换旧站或绕过访问控制。已有本票据 lease 只能核对原结果，不能重新 claim 或点击。
若连接器目录尚未更新，可用原门户已登录管理员页面公布的 WebMCP portal_codex_action 工具执行同一合同：先 fetchTools 确认上述操作确实公布，读取 fault_rescue_status 确认本机同一 pending 票据且未过期；再以同一 expectedFailureId、scope=approved_member_ops、clientId 幂等调用 begin_fault_rescue，仅取回已存在的同一票据。不得创建新票据或替换目标。返回凭据只保留在 CUA 工具会话变量，不输出、不转抄到代码/聊天；若票据ID或期限不同则立即停止。此替代仍先要求本机 --credential 的真实进程/锁核验通过，所有 claim/authorize/complete 与停止证明要求不变，finish_fault_rescue 仅由普通 broker 完成。
官方 UI 仅使用已授权管理员的现有 IAB 正常会话，官方地址应为 https://admin.openai.com/workspace/${'cd01c344-8ff9-41fd-a750-f7b30af9a7c9'}/members。不得启动可见系统窗口、抢焦点、改 Cookie/指纹、复制会话、解验证码、自动填密码、点新的权限同意或调用隐藏/非公开 OpenAI API。普通 challenge 可正常等待短时就绪；明确登录/本人交互才 needs_human，泛化 challenge 不等于本人验证。没有可用正常会话就停止并说明事实。
最多3个冻结目标，回收优先，逐项重新执行以下规则：
1. 完整读取 My Workspace 的成员及待接受邀请清单（含分页）、当前管理员与已购4个高级席位，不能只搜索目标。生成新鲜 observation={workspaceId,accountEmail,pageUrl,observedAt,complete:true,totalSeats,members:[{email,role}],invites:[{email,role}]}；先 observe_workspace，再只读 status。当前有效目标、白名单、角色、容量、截止时间与租约必须仍一致；不加购、不改席位、不处理Owner/管理员。
2. 仅对票据 targets 中仍有效且未办过的目标调用 claim_rescue_operation({rescueId,token,expectedFailureId,kind,targetId})。本次 lease 的 rescueId/目标/邮箱必须匹配。claim 回执不明只查原 lease，禁止重试或点击。目标已取消/续期/已加入，或冻结的 requestUpdatedAt 已变时跳过；不能临时换一个目标。取得 lease 后必须再次完整读取官方名单并 observe_workspace，确保 observation.observedAt >= lease.claimedAt；只用 claim 前的快照无法授权，不能把时间戳伪造为新时间。
3. 准备官方表单至最终按钮但不点击。最终点击前调用一次 authorize_rescue_action({rescueId,token,expectedFailureId,operationId,operationToken})，只在明确成功且未超过返回 authorization.expiresAt 及票据 expiresAt 时允许点击一次；剩余时间不足以安全完成工具调用时不授权、不点击。授权结果不明、过期或审批被拦即不点击；禁止重发授权或绕过系统审批。未authorize且确定未操作（包括此时已发现员工加入）的原 lease 必须 observe 后用 not_started 加完整官方证据结案，不可直接报 joined；单目标额度不返还。
4. 官方邀请的邮件由 OpenAI 的发送邀请动作产生，无需 Gmail。发送按钮成功后立即记录实际 invitationSentAt（不要等弹窗消失才记时），并运行 node ${context} --rescue-id ${quote(record.ticket.id)} --submission --operation-id <原op_ID> --target-id <冻结req_ID> --invitation-sent-at <实际ISO时间>。该标记不含token、不可覆盖，不能用核对时间或新时间冒充发送时间；标记不明就保留原lease，不重发。移除/撤邀也只能点一次。邀请超时撤回时若官方当前已成为成员，保护已加入者，按授权阶段使用 joined 或 not_started，不移除成员。
5. 点击后完整刷新成员和邀请清单，再以原 operationId/token 调 complete_seat_operation；invite 需 invitationSentAt，remove 需新鲜 absent 证据；仅已经authorize的撤邀加入竞态可用 joined，未authorize用 not_started。结果不明保留原 lease，只读核对，绝不重做。审批拒绝登记 approval_required；明确单目标失败登记 member_action；未知点击结果用 uncertain/unknown，不伪造完成。
不要等待员工接受邀请，也不循环轮询。一次核对后结束此目标。禁止调用 review_seat_failure、recover-browser、resume_workspace 或清除专用执行器 global fault；IAB 成功不证明原专用浏览器恢复。票据到期后不再产生任何新成员写入，仅允许读取证据并以原租约 complete 核对回执。
准备结束时仅运行 node ${ack} --rescue-id ${quote(record.ticket.id)} --outcome handled（仍不明用 uncertain；明确本人操作用 needs_human；未办理用 unresolved），然后结束本轮。ACK 不是实际结束证明；共享聊天不能保证硬中断，服务端到期拒绝新写，普通执行器必须等真实终态及独立核对后才接回。只简短报告已核实事实。`;
  }
  return `NUMEMS 一次性故障诊断 [${record.ticket.id}]
这是用户授权的异常后备，普通邀请和回收继续由脚本执行。本次仅诊断及核对原回执，不进行新的成员写入。
定位数据：${JSON.stringify(meta)}
项目：${projectRoot}
先读取 AUTOMATION.md，运行 node ${context} --rescue-id ${quote(record.ticket.id)} 取得脱敏上下文，确认同一故障、本机执行器已停止。不要 cat 完整 fault-rescue.json 或带租约 token 的原始记录；若需读取原日志，必须在 functions.exec 中捕获 exec_command.stdout 后仅 store 到会话内存，不 text、notify 或日志输出秘密。令牌仅本机使用，不得输出到聊天或其它站点。仅可读取本项目的 .sites-runtime/agentless/{status,host-desktop,admin-result,operation}.json 诊断记录，禁止读取无关文件或其它账号数据。
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
  if(r.pendingCount===0)return {...summary(r),reason:'no_valid_pending_work'};
  const deadline=faultRescueDeadline(r);
  if(deadline!==null&&clock().getTime()>=deadline)return {...summary(r),reason:'ticket_expired_before_dispatch'};
  const prompt=faultRescuePrompt(r,projectRoot);
  // This immutable per-client witness closes the simultaneous-watchdog race.
  // A crash after creating it but before enqueue remains held, never resent.
  const witness=witnessFile(directory,r);
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
    if(!safeId(id)||response.queuedSubmission.clientUserMessageId!==undefined&&response.queuedSubmission.clientUserMessageId!==r.clientId)
      throw new Error('Queue receipt identity missing or mismatched');
    r={...r,phase:'queued',queuedId:id,queuedAt:clock().toISOString(),updatedAt:clock().toISOString()};
  } catch {r={...r,phase:'uncertain',reason:'queue_result_unknown',updatedAt:clock().toISOString()};}
  await atomicJson(file,r);return summary(r);
}

/** Queue absence never permits resending an interrupted/ambiguous dispatch. */
export async function reconcileFaultRescueDispatch({directory,client,clock=()=>new Date()}) {
  const file=faultRescueFile(directory);let r=await readJson(file);
  if(!r||!['sending','uncertain'].includes(r.phase)||!r.dispatchStartedAt||r.finishIntent||r.agentStopped===true)return summary(r);
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
     outcome==='handled'&&r.ticket.scope!=='approved_member_ops'||
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
export async function settleFaultRescue({directory,portal,client,hostSafe,verifiedRecovery,verifiedHandled,readDiagnostic=async()=>null,
  clock=()=>new Date()}) {
  if(hostSafe!==true)throw new Error('Cannot settle while a routine executor is alive.');
  const file=faultRescueFile(directory);let r=await readJson(file);
  if(!r||r.phase==='finished'||r.outcome==='uncertain'&&r.agentStopped===true&&verifiedRecovery!==true&&verifiedHandled!==true)return summary(r);
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
  const deadline=faultRescueDeadline(r),expired=deadline!==null&&now>=deadline;
  if(!stoppedProof(proof,r,now)) {
    if(expired&&r.ticket.scope==='approved_member_ops') {
      r={...r,budgetExceededAt:r.budgetExceededAt??clock().toISOString(),updatedAt:clock().toISOString()};
      await atomicJson(file,r);
      return {...summary(r),reason:'agent_deadline_expired_stop_unconfirmed'};
    }
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
  else if(verifiedHandled===true&&r.ticket.scope==='approved_member_ops')outcome='handled';
  else {
    if(outcome==='handled')outcome='unresolved';
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
