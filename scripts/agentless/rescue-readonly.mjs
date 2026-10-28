import {bridgeObservation,presence,assertOrdinary} from '../seat-executor/inventory.mjs';
import {Journal,readJson} from './journal.mjs';
import {cloudRecoveryOwned} from './recovery-fence.mjs';
import path from 'node:path';
const planOf=v=>v.plan??v;
const settled=j=>!j || j.phase==='settled' && !j.lease && !j.receipt && !j.submission;
function identity(p,c) {
  if(p?.workspaceId!==c.workspaceId || p.administrator!==c.adminEmail || !p.enabled || p.testOnly)
    throw new Error('故障核对的管理员或正式工作空间不匹配。');
}
/** This helper never claims or clicks an invitation/removal. Only an existing
 * original lease can be completed, using new full official evidence. */
export async function reconcileRescueReadOnly({portal,browser,config,journalFile,ticket=null}) {
  let p=planOf(await portal.call('seat_portal_status'));identity(p,config);
  const guard=latest=>{
    identity(latest,config);
    if(cloudRecoveryOwned(latest) && (!ticket?.ticket || latest.faultRescue?.id!==ticket.ticket.id ||
        latest.faultRescue?.failureId!==ticket.failureId))throw new Error('另一故障处置仍持有执行权。');
    if(ticket && latest.globalFailureCode && latest.globalFailureId!==ticket.failureId)
      throw new Error('已出现更新的故障，不能用旧事件恢复。');
  };
  guard(p);
  const execution=ticket?.scope==='approved_member_ops'||ticket?.ticket?.scope==='approved_member_ops';
  const grantMatches=(grant,lease)=>grant?.kind===lease.kind&&grant.targetId===lease.targetId&&grant.email===lease.email&&
    grant.requestUpdatedAt===lease.rescueRequestUpdatedAt;
  const ownExecutionLease=lease=>execution&&lease&&lease.rescueId===ticket?.ticket?.id&&lease.rescueFailureId===ticket.failureId&&
    p.faultRescue?.id===ticket.ticket.id&&p.faultRescue.failureId===ticket.failureId&&p.faultRescue.scope==='approved_member_ops'&&
    ticket.ticket.targets?.filter(grant=>grantMatches(grant,lease)).length===1&&
    p.faultRescue.targets?.filter(grant=>grantMatches(grant,lease)).length===1;
  const sameLease=(a,b)=>['id','token','kind','targetId','email','status','rescueId','rescueFailureId','rescueRequestUpdatedAt','actionAuthorizedAt']
    .every(key=>a?.[key]===b?.[key]);
  const journal=new Journal(journalFile);
  const reconcileLease=async(lease,j)=>{
    const snapshot=await browser.observe();
    assertOrdinary(snapshot,lease.email,{config:{protectedEmails:[config.adminEmail]}});
    p=planOf(await portal.call('seat_portal_status'));guard(p);
    const current=p.lease??p.blockedOperations?.find(h=>h.operation.id===lease.id)?.operation;
    if(!current||!sameLease(current,lease)||execution&&!ownExecutionLease(current))
      throw new Error('官方核对期间原租约发生变化。');
    const state=presence(snapshot,lease.email),notStarted=execution&&!lease.actionAuthorizedAt&&lease.status==='claimed';
    const joined=lease.kind==='remove'&&lease.originalPresence==='invite'&&state==='member';
    if(!notStarted&&!(lease.kind==='invite'&&state!=='absent')&&!(lease.kind==='remove'&&state==='absent')&&!joined)
      throw new Error('官方状态不能证明原动作完成；保留原租约。');
    let source=j?.receipt?.invitationSentAt?j.receipt:j?.submission;
    if(execution&&lease.kind==='invite'&&!notStarted&&!source?.invitationSentAt) {
      const saved=await readJson(path.join(path.dirname(journalFile),'rescue-submissions.json'));
      if(saved?.version!==1||!Array.isArray(saved.entries)||saved.entries.length>100||typeof ticket.clientId!=='string')
        throw new Error('缺少原邀请提交时间；保留原租约，不猜测时间或重发。');
      const matches=saved.entries.filter(entry=>entry.rescueId===ticket.ticket.id&&entry.clientId===ticket.clientId&&
        entry.operationId===lease.id&&entry.targetId===lease.targetId&&entry.email===lease.email&&entry.kind==='invite'&&
        (entry.queuedId==null||ticket.queuedId==null||entry.queuedId===ticket.queuedId));
      if(matches.length!==1)throw new Error('原邀请提交标记不唯一或无法匹配；保留原租约，不重发。');
      source=matches[0];
      if(typeof source.recordedAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(source.recordedAt)||
          !Number.isFinite(Date.parse(source.recordedAt))||Date.parse(source.recordedAt)>Date.now())
        throw new Error('原邀请提交标记时间无效；保留原租约，不重发。');
    }
    const sentAt=source?.invitationSentAt;
    if(sentAt) {
      const linked=source.operationId===lease.id&&(source===j?.receipt?source.token===lease.token:source.kind==='invite'&&source.email===lease.email);
      if(lease.kind!=='invite'||!linked||!Number.isFinite(Date.parse(sentAt))||!Number.isFinite(Date.parse(lease.claimedAt))||
          typeof sentAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(sentAt)||
          Date.parse(sentAt)<Date.parse(lease.claimedAt)||Date.parse(sentAt)>Date.parse(snapshot.observedAt)||Date.parse(sentAt)>Date.now())
        throw new Error('邀请提交时间不能匹配原租约，保留记录并禁止改写加入时限。');
    }
    const args={operationId:lease.id,token:lease.token,outcome:notStarted?'not_started':joined?'joined':'verified',
      observation:bridgeObservation(snapshot),...(sentAt?{invitationSentAt:sentAt}:{})};
    await journal.evidence(args);
    await portal.call('complete_seat_operation',args);
    await journal.settled();
    p=planOf(await portal.call('seat_portal_status'));guard(p);
  };
  let j=await readJson(journalFile);
  if(!settled(j)) {
    if(p.receipts?.some(r=>r.id===j?.lease?.id)){await journal.settled();p=planOf(await portal.call('seat_portal_status'));guard(p);}
    else {
      const lease=p.lease??p.blockedOperations?.find(h=>h.operation.id===j?.lease?.id)?.operation;
      if(!j?.lease||!lease||!sameLease(j.lease,lease)||
          (execution?!ownExecutionLease(lease):ticket&&ticket.originalOperationId!==lease.id))
        throw new Error('不能匹配原租约，禁止重做外部动作。');
      await reconcileLease(lease,j);
    }
  }else if(p.lease) {
    if(!ownExecutionLease(p.lease))throw new Error('原租约尚未结案，不能开始恢复。');
    // A rescue may have written only the cloud lease. Record that exact lease
    // locally before one evidence completion; this never claims or repeats UI.
    await journal.update({phase:'claimed',lease:p.lease,target:{kind:p.lease.kind,targetId:p.lease.targetId,email:p.lease.email},
      source:'rescue_cloud_reconciliation'});
    j=await readJson(journalFile);await reconcileLease(j.lease,j);
  }
  if(p.busy || p.lease)throw new Error('原租约尚未结案，不能开始恢复。');
  if(p.globalFailureCode && !['browser_unavailable','login_expired'].includes(p.globalFailureCode))
    throw new Error('当前故障需要保留原记录，不可降级为浏览器暂时不可用。');
  const failureId=p.globalFailureId;
  const snapshot=await browser.observe();
  p=planOf(await portal.call('seat_portal_status'));guard(p);
  if(p.busy || p.lease || p.globalFailureId!==failureId)
    throw new Error('官方核对期间故障或租约已变化。');
  if(p.globalFailureCode==='browser_unavailable')
    await portal.call('review_seat_failure',{decision:'recover_browser',observation:bridgeObservation(snapshot)});
  else if(p.globalFailureCode==='login_expired')
    await portal.call('review_seat_failure',{decision:'recover_login',expectedFailureId:failureId,observation:bridgeObservation(snapshot)});
  else await portal.call('observe_workspace',{observation:bridgeObservation(snapshot)});
  p=planOf(await portal.call('seat_portal_status'));guard(p);
  const healthy=!p.lastError && !p.globalFailureCode && !p.busy && !p.lease &&
    !p.blockedOperations?.length && !p.mailChannelError && p.officialObservedAt===snapshot.observedAt;
  return {healthy,plan:p,snapshot};
}
