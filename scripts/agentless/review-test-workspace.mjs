// Explicit test administrator review only. Never import from the scheduled worker.
import {isDeepStrictEqual} from 'node:util';
import {readJson} from './journal.mjs';
import {validateConfig} from './config.mjs';
import {validateObservation,bridgeObservation} from '../seat-executor/inventory.mjs';

const PRECLAIM_DIAGNOSTIC='官方完整名单核对失败；未开始成员写入。';
const planOf=value=>value.plan??value;
function withoutCheckTime(plan) {
  const copy=structuredClone(plan);
  delete copy.checkedAt; // A status read changes only its observation clock.
  return copy;
}

export function assertTestWorkspaceReview(plan,local,config,{recovered=false}={}) {
  validateConfig(config);
  if(config.liveActions!==false || config.legacyCheckerDisabled!==true ||
      plan?.administrator!==config.adminEmail || plan.workspaceId!==config.workspaceId ||
      plan.enabled!==true || plan.testOnly!==true || plan.busy!==false || plan.lease!=null ||
      !Array.isArray(plan.blockedOperations) || plan.blockedOperations.length || plan.mailChannelError ||
      (recovered ? Boolean(plan.globalFailureCode || plan.lastError)
        : plan.globalFailureCode!=='unknown' || plan.lastError!==PRECLAIM_DIAGNOSTIC))
    throw new Error('仅可人工核查测试环境中指定的未开始成员写入故障；其它暂停或隔离不得通过此入口恢复。');
  if(local && (local.phase!=='settled' || local.lease || local.receipt))
    throw new Error('本机存在未结案或相互矛盾的办理记录，不能恢复工作空间。');
}

function strictSnapshot(snapshot,config,now) {
  validateObservation(snapshot,config,now);
  if(snapshot.members.some(p=>p.email!==config.adminEmail && p.role!=='member'))
    throw new Error('完整官方名单中存在额外管理角色，不能恢复工作空间。');
  return snapshot;
}

export async function reviewTestWorkspace({portal,browser,config,journalFile,clock=Date.now}) {
  const initial=planOf(await portal.call('seat_portal_status'));
  const local=await readJson(journalFile);
  assertTestWorkspaceReview(initial,local,config);
  const initialPlan=withoutCheckTime(initial),initialLocal=structuredClone(local);
  const recheck=async()=>{
    const latest=planOf(await portal.call('seat_portal_status'));
    const currentLocal=await readJson(journalFile);
    assertTestWorkspaceReview(latest,currentLocal,config);
    if(!isDeepStrictEqual(withoutCheckTime(latest),initialPlan) ||
        !isDeepStrictEqual(currentLocal,initialLocal))
      throw new Error('核查期间云端计划或本机日志已变化，保留暂停；不得按旧状态恢复。');
  };
  const first=strictSnapshot(await browser.observe(),config,clock());
  await recheck();
  const second=strictSnapshot(await browser.observe(),config,clock());
  await recheck();
  // Both independent full reads must still be fresh at the one explicit review write.
  strictSnapshot(first,config,clock());strictSnapshot(second,config,clock());
  if(Date.parse(second.observedAt)<Date.parse(first.observedAt))
    throw new Error('第二次完整官方快照早于第一次，保留暂停。');
  const reviewed=planOf(await portal.call('review_seat_failure',{
    decision:'resume_workspace',observation:bridgeObservation(second)}));
  assertTestWorkspaceReview(reviewed,await readJson(journalFile),config,{recovered:true});
  return {outcome:'reviewed',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0};
}
