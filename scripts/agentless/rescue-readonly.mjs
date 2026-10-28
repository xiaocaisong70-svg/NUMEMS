import {bridgeObservation,presence,assertOrdinary} from '../seat-executor/inventory.mjs';
import {Journal,readJson} from './journal.mjs';
import {cloudRecoveryOwned} from './recovery-fence.mjs';
const planOf=v=>v.plan??v;
const settled=j=>!j || j.phase==='settled' && !j.lease && !j.receipt;
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
  const j=await readJson(journalFile);
  if(!settled(j)) {
    if(p.receipts?.some(r=>r.id===j?.lease?.id))await new Journal(journalFile).settled();
    else {
      const lease=p.lease??p.blockedOperations?.find(h=>h.operation.id===j?.lease?.id)?.operation;
      if(!j?.lease || !lease || !['id','token','kind','targetId','email'].every(k=>j.lease[k]===lease[k]) ||
          ticket && ticket.originalOperationId!==lease.id)
        throw new Error('不能匹配原租约，禁止重做外部动作。');
      const snapshot=await browser.observe();
      assertOrdinary(snapshot,lease.email,{config:{protectedEmails:[config.adminEmail]}});
      p=planOf(await portal.call('seat_portal_status'));guard(p);
      const current=p.lease??p.blockedOperations?.find(h=>h.operation.id===lease.id)?.operation;
      if(!current || !['id','token','kind','targetId','email'].every(k=>current[k]===lease[k]))
        throw new Error('官方核对期间原租约发生变化。');
      const state=presence(snapshot,lease.email);
      const joined=lease.kind==='remove' && lease.originalPresence==='invite' && state==='member';
      if(!(lease.kind==='invite' && state!=='absent') && !(lease.kind==='remove' && state==='absent') && !joined)
        throw new Error('官方状态不能证明原动作完成；保留原租约。');
      await portal.call('complete_seat_operation',{operationId:lease.id,token:lease.token,
        outcome:joined?'joined':'verified',observation:bridgeObservation(snapshot),
        ...(j.receipt?.invitationSentAt?{invitationSentAt:j.receipt.invitationSentAt}:{})});
      await new Journal(journalFile).settled();
    }
    p=planOf(await portal.call('seat_portal_status'));guard(p);
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
