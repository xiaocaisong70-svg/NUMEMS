import {bridgeObservation} from '../seat-executor/inventory.mjs';
import {officialDiagnostic} from '../seat-executor/official-readiness.mjs';
import {readJson} from './journal.mjs';

const journalClear = journal => !journal || (journal.phase==='settled' && journal.lease==null && journal.receipt==null);
const eligible = (plan,config) => plan?.globalFailureCode==='browser_unavailable' && plan.browserRecovery?.eligible===true &&
  !plan.busy && !plan.lease && (!config?.workspaceId || plan.workspaceId===config.workspaceId) &&
  (!config?.adminEmail || plan.administrator===config.adminEmail);
const classify = diagnostic => diagnostic?.state==='interaction_required'?'interaction_required':
  diagnostic?.state==='login'?'login_required':diagnostic?.state==='challenge'?'security_check':'temporary_unavailable';

// This path is entered only for an unstarted operation. It never claims or
// repeats a member action; even the recovery review needs fresh cloud/journal
// guards after the full official observation has returned.
export async function recoverBrowser({portal,browser,journalFile,config,
  pause=ms=>new Promise(r=>setTimeout(r,ms)),shouldStop=async()=>false,saveStatus=async()=>{},
  clock=()=>new Date(),totalBudgetMs=90000,observeBudgetMs=30000,restartBrowser,
  onIncident=async()=>{},initialDiagnostic}) {
  if(!Number.isInteger(totalBudgetMs)||totalBudgetMs<1000||totalBudgetMs>120000 ||
      !Number.isInteger(observeBudgetMs)||observeBudgetMs<1000||observeBudgetMs>60000)throw new Error('Invalid bounded browser recovery budget.');
  const deadlineAt=clock().getTime()+totalBudgetMs;
  // A prior control observation is useful context, not current proof of a
  // manual requirement. Re-establish that fact through this bounded read.
  const initial=initialDiagnostic&&officialDiagnostic({...initialDiagnostic,at:Date.parse(initialDiagnostic.observedAt)});
  let attempt=0,restarted=false,lastDiagnostic=initial?.state==='interaction_required'?{...initial,state:'challenge'}:initial,
    initialFailureId,hasInitialFailure=false;
  const announced=new Set();
  const remaining=()=>deadlineAt-clock().getTime();
  const announce=async(phase,failureId,diagnostic=lastDiagnostic)=>{
    const safe=diagnostic&&officialDiagnostic({...diagnostic,at:Date.parse(diagnostic.observedAt)});
    if(safe)lastDiagnostic=safe;
    const classification=classify(safe);
    const key=[phase,classification].join(':');if(announced.has(key))return;announced.add(key);
    await onIncident({phase,failureId,classification,attempt,...(safe?{diagnostic:safe}:{})});
  };
  const report = async (phase,patch={}) => saveStatus({checkedAt:clock().toISOString(),state:'recovering',
    mode:'browser_recovery',failureCode:'browser_unavailable',attempt,phase,modelCalls:0,
    classification:classify(lastDiagnostic),deadlineAt:new Date(deadlineAt).toISOString(),
    ...(typeof config?.liveActions==='boolean'?{liveActions:config.liveActions}:{}),...patch});
  const stopped = async () => {await report('stopped');return {stopped:true};};
  const exhausted=async failureId=>{
    if(failureId)await announce('exhausted',failureId);
    await report('exhausted');return null;
  };
  const check = async expectedFailureId => {
    if(remaining()<=0)return exhausted(expectedFailureId??initialFailureId);
    if(!journalClear(await readJson(journalFile)))return null;
    if(remaining()<=0)return exhausted(expectedFailureId??initialFailureId);
    const plan=(await portal.call('seat_portal_status',{}, {deadlineAt,budgetMs:remaining(),now:()=>clock().getTime()})).plan;
    if(remaining()<=0)return exhausted(expectedFailureId??initialFailureId??plan?.globalFailureId);
    if(!journalClear(await readJson(journalFile)))return null;
    if(!eligible(plan,config) || (expectedFailureId!==undefined && plan.globalFailureId!==expectedFailureId))return null;
    return plan;
  };
  for(const delay of [1000,2000,5000]) {
    attempt++;
    if(await shouldStop())return stopped();
    const plan=await check(hasInitialFailure?initialFailureId:undefined);
    if(!plan)return false;
    if(!hasInitialFailure){initialFailureId=plan.globalFailureId;hasInitialFailure=true;}
    if(remaining()<=0){await announce('exhausted',plan.globalFailureId);await report('exhausted');return false;}
    await announce('automatic',plan.globalFailureId);
    const nextCheckAt=new Date(clock().getTime()+delay).toISOString();
    for(let waiting=Math.min(delay,Math.max(0,remaining()));waiting>0;) {
      if(await shouldStop())return stopped();
      await report('backoff',{nextCheckAt});
      const step=Math.min(1000,waiting);await pause(step);waiting-=step;
    }
    if(await shouldStop())return stopped();
    if(!await check(plan.globalFailureId))return false;
    if(remaining()<=0){await announce('exhausted',plan.globalFailureId);await report('exhausted');return false;}
    if(attempt>1 && !restarted && typeof restartBrowser==='function') {
      if(!await check(plan.globalFailureId))return false;
      if(await shouldStop())return stopped();
      restarted=true;await report('reconnecting');
      if(await shouldStop())return stopped();
      const restartResult=await restartBrowser({failureId:plan.globalFailureId,shouldStop,deadlineAt,budgetMs:Math.max(1,remaining())});
      if(restartResult===false)return false;
      if(await shouldStop())return stopped();
      if(!await check(plan.globalFailureId))return false;
      if(remaining()<=0){await announce('exhausted',plan.globalFailureId);await report('exhausted');return false;}
    }
    await report('observing');
    if(await shouldStop())return stopped();
    let snapshot;
    try {
      snapshot=await browser.observe({shouldStop,deadlineAt,budgetMs:Math.max(1,Math.min(observeBudgetMs,remaining())),
        challengeTimeoutMs:20000,now:()=>clock().getTime(),onProgress:async diagnostic=>{
        const safe=diagnostic && officialDiagnostic({...diagnostic,at:Date.parse(diagnostic.observedAt)});
        if(safe){lastDiagnostic=safe;await report('observing',{officialDiagnostic:safe});
          await announce('observing',plan.globalFailureId,safe);}
      }});
    } catch(error) {
      if(error.code==='OFFICIAL_READ_CANCELLED')return stopped();
      const safe=error.officialDiagnostic&&officialDiagnostic({...error.officialDiagnostic,at:Date.parse(error.officialDiagnostic.observedAt)});
      if(safe)lastDiagnostic=safe;
      if(error.failureCode!=='browser_unavailable'){await announce('fatal',plan.globalFailureId);throw error;}
      if(safe?.state==='interaction_required') {await announce('interaction_required',plan.globalFailureId,safe);await report('interaction_required');return false;}
      await report('unavailable');
      if(await shouldStop())return stopped();
      continue;
    }
    if(await shouldStop())return stopped();
    if(!await check(plan.globalFailureId))return false;
    if(await shouldStop())return stopped();
    if(remaining()<=0){await announce('exhausted',plan.globalFailureId);await report('exhausted');return false;}
    const observation=bridgeObservation(snapshot);
    await report('reviewing');
    // Never retry an unconfirmed recovery write, including a transport error.
    const result=await portal.call('review_seat_failure',{decision:'recover_browser',observation});
    const latest=result.plan??result;
    const recovered=!latest.lastError && !latest.globalFailureCode && !latest.busy && !latest.lease;
    await report(recovered?'recovered':'unavailable');
    return recovered;
  }
  const plan=await check(initialFailureId);if(plan)await announce('exhausted',plan.globalFailureId);
  await report('exhausted');return false;
}
