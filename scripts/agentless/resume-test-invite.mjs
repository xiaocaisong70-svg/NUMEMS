// Explicit administrator repair only. The scheduled worker must never import this module.
import {readJson} from './journal.mjs';
import {validateObservation,bridgeObservation,presence,assertOrdinary} from '../seat-executor/inventory.mjs';

const TEST_EMAIL='hit_wangning@outlook.com';
const planOf=value=>value.plan??value;
const leaseKeys=['id','token','kind','targetId','requestId','email','claimedAt','expiresAt','originalPresence'];
const safeFailure=error=>['approval_required','member_action','login_expired','workspace_mismatch',
  'capacity_mismatch','role_mismatch'].includes(error.failureCode)?error.failureCode:'unknown';

export function assertTestInviteResume(plan,local,config) {
  const lease=plan?.lease;
  if(config.liveActions!==true || config.legacyCheckerDisabled!==true ||
      plan?.administrator!==config.adminEmail || plan.workspaceId!==config.workspaceId ||
      plan.enabled!==true || plan.testOnly!==true || plan.busy!==true ||
      plan.globalFailureCode!=='unknown' || !plan.lastError ||
      plan.blockedOperations?.length || plan.mailChannelError)
    throw new Error('仅可续办测试模式中明确未发送的原邀请；工作空间或隔离状态不符。');
  if(local?.phase!=='claimed' || local.receipt || local.lease?.status!=='claimed' ||
      !lease || lease.status!=='uncertain' || lease.kind!=='invite' || lease.email!==TEST_EMAIL ||
      lease.originalPresence!=='absent' || !lease.id || !lease.token ||
      lease.targetId!==lease.requestId || !/^req_[a-zA-Z0-9_]+$/.test(lease.requestId??'') ||
      !Number.isFinite(Date.parse(lease.claimedAt)) || !Number.isFinite(Date.parse(lease.expiresAt)) ||
      Date.parse(lease.expiresAt)<=Date.parse(lease.claimedAt) ||
      leaseKeys.some(key=>local.lease[key]!==lease[key]) ||
      local.target?.kind!=='invite' || local.target?.targetId!==lease.targetId || local.target?.email!==TEST_EMAIL)
    throw new Error('本机记录不是未开始发送的原始 claimed 租约；禁止重试或替换租约。');
  const requests=plan.invites?.filter(r=>r.id===lease.targetId)??[];
  if(requests.length!==1 || requests[0].isTest!==true || requests[0].email!==TEST_EMAIL ||
      requests[0].status!=='pending_invite' || plan.receipts?.some(r=>r.id===lease.id))
    throw new Error('原测试申请已变化或已结案；禁止重新发送。');
  return lease;
}

function checkSnapshot(snapshot,config,now,{mustBeAbsent=false}={}) {
  validateObservation(snapshot,config,now);
  assertOrdinary(snapshot,TEST_EMAIL,{config:{protectedEmails:[config.adminEmail]}});
  if(snapshot.members.some(p=>p.email!==config.adminEmail && p.role!=='member'))
    throw new Error('完整官方名单中存在额外管理角色，不能续办。');
  if(mustBeAbsent && (presence(snapshot,TEST_EMAIL)!=='absent' ||
      snapshot.members.length+snapshot.invites.length>=config.totalSeats))
    throw new Error('测试邮箱已存在或已购空位不足；只能核实原回执，不能再次邀请。');
  return snapshot;
}

function assertCompleted(plan,lease,config) {
  if(plan.administrator!==config.adminEmail || plan.workspaceId!==config.workspaceId ||
      plan.enabled!==true || plan.testOnly!==true || plan.busy || plan.lease ||
      plan.blockedOperations?.length || plan.mailChannelError ||
      !plan.receipts?.some(r=>r.id===lease.id && r.kind==='invite' && r.email===TEST_EMAIL) ||
      (plan.globalFailureCode && plan.globalFailureCode!=='unknown') ||
      (!plan.globalFailureCode && plan.lastError))
    throw new Error('原邀请回执或工作空间状态未确认；保留暂停，不能恢复普通办理。');
}

export async function resumeTestInvite({portal,browser,config,journal,clock=Date.now}) {
  const read=()=>readJson(journal.file);
  let plan=planOf(await portal.call('seat_portal_status'));
  const lease=structuredClone(assertTestInviteResume(plan,await read(),config));
  const before=checkSnapshot(await browser.observe(),config,clock(),{mustBeAbsent:true});
  plan=planOf(await portal.call('seat_portal_status'));
  assertTestInviteResume(plan,await read(),config);
  let attempting=false,completionStarted=false;
  browser.onExternalAction=async()=>{
    if(attempting)throw new Error('本命令仅允许一次实际邀请发送。');
    // This is the final callback before the unique Send button. Do not navigate the form away.
    checkSnapshot(before,config,clock(),{mustBeAbsent:true});
    assertTestInviteResume(planOf(await portal.call('seat_portal_status')),await read(),config);
    await journal.attempting();
    attempting=true;
  };
  try {
    const sentAt=await browser.invite(TEST_EMAIL,before);
    if(!attempting || !Number.isFinite(Date.parse(sentAt)))
      throw new Error('未取得本次唯一发送动作的时间证据，保留原办理记录。');
    const after=checkSnapshot(await browser.observe(),config,clock());
    if(presence(after,TEST_EMAIL)==='absent')
      throw new Error('发送后的完整官方名单未核实到测试邀请或成员，禁止重复发送。');
    const args={operationId:lease.id,token:lease.token,outcome:'verified',
      observation:bridgeObservation(after),invitationSentAt:sentAt};
    await journal.evidence(args);
    completionStarted=true;
    plan=planOf(await portal.call('complete_seat_operation',args));
    assertCompleted(plan,lease,config);
    await journal.settled();
  } catch(error) {
    // Never repeat an external action. An interrupted receipt remains in completing for reconcile.
    if(!completionStarted) {
      await portal.call('complete_seat_operation',{operationId:lease.id,token:lease.token,
        outcome:attempting?'uncertain':'blocked',failureCode:safeFailure(error),
        detail:'管理员测试续办未完成；保留原租约和本机发送阶段，禁止自动重复发送。'});
    }
    throw error;
  } finally {browser.onExternalAction=()=>{};}
  if(plan.globalFailureCode==='unknown') {
    // Administrator repair after a real receipt, never routine automatic unknown-error recovery.
    const reviewed=checkSnapshot(await browser.observe(),config,clock());
    if(presence(reviewed,TEST_EMAIL)==='absent')
      throw new Error('恢复核对时测试邀请已不在官方名单，保留暂停。');
    plan=planOf(await portal.call('seat_portal_status'));
    assertCompleted(plan,lease,config);
    if(plan.globalFailureCode==='unknown')
      plan=planOf(await portal.call('review_seat_failure',{
        decision:'resume_workspace',observation:bridgeObservation(reviewed)}));
    assertCompleted(plan,lease,config);
    if(plan.globalFailureCode || plan.lastError)throw new Error('原邀请已核实，但工作空间仍暂停。');
  }
  return {requestId:lease.requestId,outcome:'verified',workspaceResumed:true,modelCalls:0};
}
