import {bridgeObservation} from '../seat-executor/inventory.mjs';
import {officialDiagnostic} from '../seat-executor/official-readiness.mjs';
import {readJson} from './journal.mjs';

const journalClear = journal => !journal || (journal.phase==='settled' && journal.lease==null && journal.receipt==null);
const eligible = plan => plan?.globalFailureCode==='browser_unavailable' && plan.browserRecovery?.eligible===true &&
  !plan.busy && !plan.lease;

// This path is entered only for an unstarted operation. It never claims or
// repeats a member action; even the recovery review needs fresh cloud/journal
// guards after the full official observation has returned.
export async function recoverBrowser({portal,browser,journalFile,config,
  pause=ms=>new Promise(r=>setTimeout(r,ms)),shouldStop=async()=>false,saveStatus=async()=>{},
  clock=()=>new Date()}) {
  let attempt=0;
  const report = async (phase,patch={}) => saveStatus({checkedAt:clock().toISOString(),state:'recovering',
    mode:'browser_recovery',failureCode:'browser_unavailable',attempt,phase,modelCalls:0,
    ...(typeof config?.liveActions==='boolean'?{liveActions:config.liveActions}:{}),...patch});
  const stopped = async () => {await report('stopped');return {stopped:true};};
  const check = async expectedFailureId => {
    if(!journalClear(await readJson(journalFile)))return null;
    const plan=(await portal.call('seat_portal_status')).plan;
    if(!eligible(plan) || (expectedFailureId!==undefined && plan.globalFailureId!==expectedFailureId))return null;
    return plan;
  };
  for(const delay of [15000,30000,60000]) {
    attempt++;
    if(await shouldStop())return stopped();
    const plan=await check();
    if(!plan)return false;
    const nextCheckAt=new Date(clock().getTime()+delay).toISOString();
    for(let remaining=delay;remaining>0;) {
      if(await shouldStop())return stopped();
      await report('backoff',{nextCheckAt});
      const step=Math.min(1000,remaining);await pause(step);remaining-=step;
    }
    if(await shouldStop())return stopped();
    if(!await check(plan.globalFailureId))return false;
    await report('observing');
    let snapshot;
    try {
      snapshot=await browser.observe({shouldStop,onProgress:async diagnostic=>{
        const safe=diagnostic && officialDiagnostic({...diagnostic,at:Date.parse(diagnostic.observedAt)});
        if(safe)await report('observing',{officialDiagnostic:safe});
      }});
    } catch(error) {
      if(error.code==='OFFICIAL_READ_CANCELLED')return stopped();
      if(error.failureCode!=='browser_unavailable')throw error;
      await report('unavailable');
      if(await shouldStop())return stopped();
      continue;
    }
    if(await shouldStop())return stopped();
    if(!await check(plan.globalFailureId))return false;
    if(await shouldStop())return stopped();
    const observation=bridgeObservation(snapshot);
    await report('reviewing');
    // Never retry an unconfirmed recovery write, including a transport error.
    const result=await portal.call('review_seat_failure',{decision:'recover_browser',observation});
    const latest=result.plan??result;
    const recovered=!latest.lastError && !latest.globalFailureCode && !latest.busy && !latest.lease;
    await report(recovered?'recovered':'unavailable');
    return recovered;
  }
  return false;
}
