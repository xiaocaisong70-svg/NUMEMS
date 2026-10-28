import {bridgeObservation,validateObservation} from '../seat-executor/inventory.mjs';
import {InventoryMismatchError} from '../seat-executor/browser.mjs';
import {cloudRecoveryOwned} from './recovery-fence.mjs';

const planOf = value => value.plan ?? value;
const settled = j => !j || j.phase === 'settled' && j.lease == null && j.receipt == null;
const safe = (p,c) => p?.workspaceId === c.workspaceId && p.administrator === c.adminEmail &&
  p.enabled === true && p.testOnly === false && !p.busy && !p.lease && !p.lastError && !p.globalFailureCode && !cloudRecoveryOwned(p);
const codeOf = e => e instanceof InventoryMismatchError ? 'browser_unavailable' :
  ['browser_unavailable','login_expired','workspace_mismatch','capacity_mismatch','role_mismatch'].includes(e.failureCode) ? e.failureCode : 'unknown';

/** Every browser observation is already two complete validated official snapshots.
 * This path does not claim, invite, remove, send mail, or start an Agent. */
export async function reconcileIdle({portal,browser,config,journalState=null,record=null,save=async()=>{},
  clock=()=>new Date(),shouldStop=async()=>false,onHealthy=async()=>{}}) {
  const now = clock().getTime(), interval = (config.officialReconcileSeconds ?? 120)*1000;
  if (!config.liveActions || !config.legacyCheckerDisabled || !settled(journalState) || await shouldStop())
    return {state:'skipped',reason:'local_guard'};
  let p=planOf(await portal.call('seat_portal_status'));
  if (!safe(p,config)) return {state:'skipped',reason:'cloud_guard'};
  const expectedObservedAt=p.officialObservedAt??null;
  const stamps=[record?.attemptedAt,p.officialObservedAt].filter(Boolean).map(Date.parse);
  if (stamps.some(t=>!Number.isFinite(t) || t>now)) throw new Error('定期核对时间证据无效。');
  const anchor=stamps.length?Math.max(...stamps):0;
  if(now-anchor<interval) return {state:'waiting',nextAt:new Date(anchor+interval).toISOString()};
  const attempt={version:1,attemptedAt:clock().toISOString(),state:'observing'};
  await save(attempt);
  let snapshot;
  try { snapshot=validateObservation(await browser.observe({shouldStop}),config,clock().getTime()); }
  catch(error) {
    if(error.code==='OFFICIAL_READ_CANCELLED' || await shouldStop())return {state:'stopped'};
    // The failure write is single-attempt. An ambiguous RPC remains unknown.
    const failureCode=codeOf(error);
    await portal.call('record_idle_observation_failure',{failureCode,expectedObservedAt:p.officialObservedAt??null});
    await save({...attempt,state:'blocked',failureCode});
    if(error instanceof InventoryMismatchError)error.failureCode='browser_unavailable';
    throw error;
  }
  if(await shouldStop())return {state:'stopped'};
  p=planOf(await portal.call('seat_portal_status'));
  if(!safe(p,config) || (p.officialObservedAt??null)!==expectedObservedAt)
    return {state:'skipped',reason:'state_changed'};
  await portal.call('observe_idle_workspace',{observation:bridgeObservation(snapshot),expectedObservedAt:p.officialObservedAt??null});
  const latest=planOf(await portal.call('seat_portal_status'));
  // A successful RPC is insufficient if a concurrent write changed health.
  const healthy=safe(latest,config) && latest.officialObservedAt===snapshot.observedAt;
  await save({...attempt,state:healthy?'verified':'blocked',observedAt:snapshot.observedAt});
  if(!healthy) {
    const error=new Error('定期官方核对后的云端状态未通过健康检查，保持暂停。');
    error.failureCode=latest.globalFailureCode || 'unknown';throw error;
  }
  if(healthy && !(latest.blockedOperations?.length) && !latest.mailChannelError)
    await onHealthy({plan:latest,snapshot,journalState});
  return {state:healthy?'verified':'blocked',observedAt:snapshot.observedAt};
}
