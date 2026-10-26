// Local health recovery only: safe portal reads, official reads and local status.
// Never claim, complete, invite, remove, clear a cloud fault or repeat a write RPC.
import {PortalReadUnavailable,PortalQueueUnavailable} from '../seat-executor/portal-client.mjs';
import {validateObservation} from '../seat-executor/inventory.mjs';
import {readJson} from './journal.mjs';

export function validPortalFailure(code,meta) {
  if(!meta || typeof meta!=='object' || Array.isArray(meta) || !['timeout','network'].includes(meta.reason))return false;
  if(code==='portal_queue_unavailable')return meta.stage==='queue_refresh' &&
    meta.requestedOperation==='refresh_seat_queue' && meta.idempotent===true && meta.noExternalActions===true;
  return code==='portal_read_unavailable' && meta.readOnly===true &&
    typeof meta.requestedOperation==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(meta.requestedOperation) &&
    ((meta.stage==='identity' && meta.requestNotSent===true) ||
     (meta.stage==='status' && meta.requestedOperation==='seat_portal_status' && meta.requestNotSent===false));
}
export function journalClear(journal) {
  return !journal || (journal.phase==='settled' && journal.lease==null && journal.receipt==null);
}
export function recoverablePortalError(error) {
  return (error instanceof PortalReadUnavailable || error instanceof PortalQueueUnavailable) &&
    validPortalFailure(error.failureCode,error.metadata);
}
function verifyPlan(plan,config) {
  if(!plan || plan.workspaceId!==config.workspaceId || plan.administrator!==config.adminEmail)
    throw new Error('门户恢复时身份或工作空间不匹配，保持停止。');
  if(plan.busy || plan.lease || plan.lastError || plan.globalFailureCode)
    throw new Error('门户恢复时存在未完成租约或全局故障，禁止自动继续。');
}
export async function recoverPortal({error,portal,browser,config,journalFile,
  readJournal=()=>readJson(journalFile),saveStatus=async()=>{},shouldStop=async()=>false,
  pause=ms=>new Promise(r=>setTimeout(r,ms)),clock=()=>new Date(),delays=[5000,15000,30000,60000,120000,300000]}) {
  if(!recoverablePortalError(error) || !journalClear(await readJournal()))throw error;
  if(!Array.isArray(delays)||!delays.length||delays.some(n=>!Number.isInteger(n)||n<0||n>300000))
    throw new Error('Invalid recovery backoff.');
  let last=error;
  for(let attempt=0;;attempt++) {
    if(!journalClear(await readJournal()))throw last;
    if(await shouldStop())return {mode:'idle',actions:[],stopped:true,modelCalls:0};
    const delay=delays[Math.min(attempt,delays.length-1)];
    await saveStatus({checkedAt:clock().toISOString(),state:'recovering',mode:'portal_recovery',
      failureCode:last.failureCode,readFailure:last.metadata,attempt:attempt+1,
      nextCheckAt:new Date(clock().getTime()+delay).toISOString(),modelCalls:0,liveActions:config.liveActions});
    for(let remaining=delay;remaining>0;) {
      if(await shouldStop())return {mode:'idle',actions:[],stopped:true,modelCalls:0};
      const step=Math.min(1000,remaining);await pause(step);remaining-=step;
    }
    if(await shouldStop())return {mode:'idle',actions:[],stopped:true,modelCalls:0};
    if(!journalClear(await readJournal()))throw last;
    try {
      let plan=(await portal.call('seat_portal_status')).plan;
      verifyPlan(plan,config);
      if(plan.enabled!==true)return {mode:'disabled',actions:[],modelCalls:0};
      // Do not declare recovery solely on an HTTP response: verify the full
      // official workspace, Owner, roles, seat count and evidence freshness too.
      validateObservation(await browser.observe(),config,clock().getTime());
      plan=(await portal.call('seat_portal_status')).plan;
      verifyPlan(plan,config);
      if(plan.enabled!==true)return {mode:'disabled',actions:[],modelCalls:0};
      if(!journalClear(await readJournal()))throw new Error('恢复期间出现未结案日志，停止继续。');
      if(await shouldStop())return {mode:'idle',actions:[],stopped:true,modelCalls:0};
      return {mode:'idle',actions:[],portalRecovered:true,modelCalls:0};
    } catch(next) {
      if(!recoverablePortalError(next) || !journalClear(await readJournal()))throw next;
      last=next; // Only these safe requests may be repeated after a bounded backoff.
    }
  }
}
