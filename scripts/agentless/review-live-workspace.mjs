// Explicit production administrator reconciliation. Never imported by the scheduled worker.
// This entry reads two complete official inventories and writes only the existing
// workspace review RPC; it does not claim, invite, revoke, remove or call a model.
import {isDeepStrictEqual} from 'node:util';
import {readJson,atomicJson} from './journal.mjs';
import {validateConfig} from './config.mjs';
import {validateObservation,bridgeObservation} from '../seat-executor/inventory.mjs';

const PRECLAIM_DIAGNOSTIC='官方完整名单核对失败；未开始成员写入。';
const LOCAL_INVENTORY_DIAGNOSTIC='读取成员及邀请数与席位已分配数不一致，可能存在分页或加载变化。';
const planOf=value=>value.plan??value;
function stablePlan(plan) { const copy=structuredClone(plan); delete copy.checkedAt; return copy; }

export function assertLiveWorkspaceReview(plan,local,config,{recovered=false}={}) {
  validateConfig(config);
  if(config.liveActions!==true || config.legacyCheckerDisabled!==true ||
      plan?.administrator!==config.adminEmail || plan.workspaceId!==config.workspaceId ||
      plan.enabled!==true || plan.testOnly!==false || plan.busy!==false || plan.lease!=null ||
      !Array.isArray(plan.blockedOperations) || plan.blockedOperations.length || plan.mailChannelError ||
      (recovered ? Boolean(plan.globalFailureCode || plan.lastError)
        : plan.globalFailureCode!=='unknown' || plan.lastError!==PRECLAIM_DIAGNOSTIC ||
          typeof plan.globalFailureId!=='string' || !plan.globalFailureId))
    throw new Error('仅可恢复正式环境中指定的未开始成员写入故障；其它暂停或隔离不得通过此入口恢复。');
  if(!local || local.phase!=='settled' || local.lease || local.receipt)
    throw new Error('本机办理记录不存在或未结案，不能恢复工作空间。');
}
function strictSnapshot(snapshot,config,now) {
  validateObservation(snapshot,config,now);
  if(snapshot.members.some(p=>p.email!==config.adminEmail && p.role!=='member'))
    throw new Error('完整官方名单中存在额外管理角色，不能恢复工作空间。');
  return snapshot;
}
function inventory(snapshot) {
  const order=(a,b)=>a.email.localeCompare(b.email);
  return {workspaceId:snapshot.workspaceId,workspaceName:snapshot.workspaceName,
    accountEmail:snapshot.accountEmail,totalSeats:snapshot.totalSeats,seatLabel:snapshot.seatLabel,
    members:structuredClone(snapshot.members).sort(order),invites:structuredClone(snapshot.invites).sort(order)};
}
function assertBlockedStatus(status) {
  if(!status || status.state!=='blocked' || status.failureCode!=='unknown' ||
      status.error!==LOCAL_INVENTORY_DIAGNOSTIC || status.modelCalls!==0 ||
      typeof status.checkedAt!=='string' || !Number.isFinite(Date.parse(status.checkedAt)))
    throw new Error('本机执行器状态与该未开始名单故障不符，保留暂停。');
}
export async function reviewLiveWorkspace({portal,browser,config,journalFile,statusFile,clock=Date.now,
  writeStatus=atomicJson}) {
  const initial=planOf(await portal.call('seat_portal_status'));
  const local=await readJson(journalFile);
  const blockedStatus=await readJson(statusFile);
  assertLiveWorkspaceReview(initial,local,config);
  assertBlockedStatus(blockedStatus);
  const initialPlan=stablePlan(initial),initialLocal=structuredClone(local);
  const recheck=async()=>{
    const latest=planOf(await portal.call('seat_portal_status'));
    const currentLocal=await readJson(journalFile);
    const currentStatus=await readJson(statusFile);
    assertLiveWorkspaceReview(latest,currentLocal,config);
    assertBlockedStatus(currentStatus);
    if(!isDeepStrictEqual(stablePlan(latest),initialPlan) || !isDeepStrictEqual(currentLocal,initialLocal))
      throw new Error('核查期间云端计划或本机日志已变化，保留暂停。');
    if(!isDeepStrictEqual(currentStatus,blockedStatus))throw new Error('本机执行器状态已变化，保留暂停。');
  };
  const first=strictSnapshot(await browser.observe(),config,clock());
  await recheck();
  const second=strictSnapshot(await browser.observe(),config,clock());
  await recheck();
  strictSnapshot(first,config,clock());strictSnapshot(second,config,clock());
  if(Date.parse(second.observedAt)<Date.parse(first.observedAt) || !isDeepStrictEqual(inventory(first),inventory(second)))
    throw new Error('两次官方完整名单不同或顺序异常，保留暂停并重新核实。');
  const reviewed=planOf(await portal.call('review_seat_failure',{
    decision:'resume_preclaim_inventory',expectedFailureId:initial.globalFailureId,
    observation:bridgeObservation(second)}));
  assertLiveWorkspaceReview(reviewed,await readJson(journalFile),config,{recovered:true});
  const after=planOf(await portal.call('seat_portal_status'));
  const afterJournal=await readJson(journalFile),afterStatus=await readJson(statusFile);
  assertLiveWorkspaceReview(after,afterJournal,config,{recovered:true});
  if(typeof after.workspaceReviewedAt!=='string' || !Number.isFinite(Date.parse(after.workspaceReviewedAt)) ||
      Date.parse(after.workspaceReviewedAt)<Date.parse(second.observedAt))
    throw new Error('服务端未返回本次核查时间，未写入本机恢复证据。');
  if(!isDeepStrictEqual(stablePlan(after),stablePlan(reviewed)) || !isDeepStrictEqual(afterJournal,initialLocal) ||
      !isDeepStrictEqual(afterStatus,blockedStatus))
    throw new Error('恢复回执后状态已变化；未写入本机恢复证据，保持停机。');
  await writeStatus(statusFile,{checkedAt:new Date(clock()).toISOString(),mode:'idle',modelCalls:0,liveActions:true,
    reviewEvidence:{failureId:initial.globalFailureId,workspaceReviewedAt:after.workspaceReviewedAt,
      firstObservedAt:first.observedAt,secondObservedAt:second.observedAt,previousStatusAt:blockedStatus.checkedAt}});
  return {outcome:'reviewed',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0};
}
