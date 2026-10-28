import path from 'node:path';
import { loadConfig,configPath,runtimeDir,TASK_NAME } from './config.mjs';
import { AgentlessBrowser } from './browser.mjs';
import { PortalClient } from '../seat-executor/portal-client.mjs';
import { runBatch } from './core.mjs';
import { Journal,atomicJson,acquireLock,readJson } from './journal.mjs';
import { assertExclusive } from './guard.mjs';
import { notifyFailure,flushFailureAlerts,runtimeIncidentKey } from './alert.mjs';
import { recoverBrowser } from './recovery.mjs';
import { GracefulStopControl,runGracefulBatch } from './graceful-stop.mjs';
import {recoverPortal,recoverablePortalError} from './portal-recovery.mjs';
import {safeOfficialDiagnostic} from '../seat-executor/official-readiness.mjs';
import {safeRuntimeDiagnostics} from './operation-diagnostic.mjs';
import {reconcileIdle} from './idle-reconcile.mjs';
import {markRuntimeHealthy} from './health-cycle.mjs';
import {restartReadonlyContext,publishRecoveryIncident} from './recovery-context.mjs';
import {cloudRecoveryOwned,localRecoveryOwned} from './recovery-fence.mjs';

export function localContextRecoveryEligible(error,journal) {
  return error?.message==='page.evaluate: Target page, context or browser has been closed' &&
    journal?.phase==='settled' && journal.lease==null && journal.receipt==null;
}

// The production error policy is independently testable without starting a
// browser, scheduler, or live member operation.
export async function recoverBatchError({error,portal,browser,config,journalFile,shouldStop,saveStatus,saveBrowserProgress,
  recoverPortalFn=recoverPortal,recoverBrowserFn=recoverBrowser,onIncident,restartBrowser,clock=()=>new Date()}) {
  if(recoverablePortalError(error))return recoverPortalFn({error,portal,browser,config,
    journalFile,shouldStop,saveStatus});
  if(error.failureCode!=='browser_unavailable') {
    if(['login_expired','unknown'].includes(error.failureCode))error.faultRescueEligible=true;
    throw error;
  }
  // Persist the actual pre-claim failure before waiting, including on the first
  // transition from idle. Progress then goes to its own file in production so
  // an interrupted read cannot replace restart evidence with an in-flight state.
  const diagnostic=safeOfficialDiagnostic(error);
  if(typeof saveStatus==='function')await saveStatus({checkedAt:clock().toISOString(),state:'blocked',
    modelCalls:0,error:error.message,failureCode:'browser_unavailable',
    ...(typeof config?.liveActions==='boolean'?{liveActions:config.liveActions}:{}),
    ...(diagnostic?{officialDiagnostic:diagnostic}:{})});
  const recovered=await recoverBrowserFn({portal,browser,config,journalFile,shouldStop,
    initialDiagnostic:diagnostic,onIncident,restartBrowser,saveStatus:saveBrowserProgress??saveStatus});
  if(recovered?.stopped===true)return {mode:'idle',actions:[],stopped:true,modelCalls:0};
  if(recovered!==true){error.faultRescueEligible=true;throw error;}
  return {mode:'browser_recovered',modelCalls:0};
}

// This records an installed local scheduler, not official membership health.
// Actual member actions keep their independent fresh inventory/claim gates.
export async function registerRunningSchedule({portal,config}) {
  const p=(await portal.call('seat_portal_status')).plan;
  if(!config.liveActions || !p || p.workspaceId!==config.workspaceId || p.administrator!==config.adminEmail ||
      !p.enabled || p.testOnly || p.busy || p.lease || p.lastError || p.globalFailureCode || cloudRecoveryOwned(p))return false;
  await portal.call('record_codex_schedule',{scheduleId:`local:seat-executor:${TASK_NAME}`});
  return true;
}

export async function main(args=process.argv.slice(2)) {
  const config=await loadConfig();
  if(args.includes('--init')) {
    const {access}=await import('node:fs/promises');
    let exists=false;try{await access(configPath);exists=true;}catch{}
    if(exists) throw new Error('配置已存在，未覆盖。');
    await atomicJson(configPath,config);
    console.log('已建立禁用真实动作的配置：'+configPath);return;
  }
  if(args.includes('--config-check')) {
    console.log(JSON.stringify({valid:true,siteUrl:config.siteUrl,liveActions:config.liveActions,mailMode:config.mailMode,modelCalls:0}));return;
  }
  // Run the conflict gate BEFORE launching a browser or mutating the cloud.
  await assertExclusive(config);
  const release=await acquireLock(path.join(runtimeDir,'worker.lock'));
  const browser=new AgentlessBrowser(config);
  let stop=false,failed=false,control,lastResult;
  const halt=()=>{stop=true;};
  const shouldStop=async()=>{
    // A previous run's request is explicitly ignored, never deleted at startup.
    if(await control.requested())stop=true;
    return stop;
  };
  process.on('SIGINT',halt);process.on('SIGTERM',halt);
  try {
    control=new GracefulStopControl(runtimeDir,await readJson(path.join(runtimeDir,'worker.lock')),
      {watchdogStartedAt:process.env.NUMEMS_WATCHDOG_START_AT??null});
    if(await shouldStop())return;
    if(await localRecoveryOwned(path.join(runtimeDir,'fault-rescue.json'))) {
      await atomicJson(path.join(runtimeDir,'status.json'),{checkedAt:new Date().toISOString(),
        mode:'fault_rescue_pending',state:'waiting',modelCalls:0,liveActions:config.liveActions});
      return;
    }
    await browser.open();
    const portal=new PortalClient(browser.context,config,['review_seat_failure','record_recovery_progress']);
    const journal=new Journal(path.join(runtimeDir,'operation.json'));
    let registered=false;
    do {
      if(await shouldStop())break;
      await assertExclusive(config);
      const batch=await runGracefulBatch(async()=>{
        try {
          const result=await runBatch({portal,browser,config,journal});
          if(config.liveActions && result.mode==='idle' && !await shouldStop()) {
            result.officialReconciliation=await reconcileIdle({portal,browser,config,
              journalState:await readJson(journal.file),record:await readJson(path.join(runtimeDir,'idle-reconcile.json')),
              shouldStop,save:value=>atomicJson(path.join(runtimeDir,'idle-reconcile.json'),value),
              onHealthy:evidence=>markRuntimeHealthy({directory:runtimeDir,config,...evidence})});
          }
          if(config.liveActions && !registered && ['idle','processed'].includes(result.mode) && !await shouldStop()) {
            registered=await registerRunningSchedule({portal,config});
          }
          return result;
        }
        catch(error) {
          return recoverBatchError({error,portal,browser,config,
            journalFile:path.join(runtimeDir,'operation.json'),shouldStop,
            onIncident:async event=>{
              await atomicJson(path.join(runtimeDir,'recovery-incident.json'),{version:1,...event,
                checkedAt:new Date().toISOString(),modelCalls:0});
              await publishRecoveryIncident(portal,event);
            },
            restartBrowser:args=>restartReadonlyContext({portal,browser,config,
              journalFile:path.join(runtimeDir,'operation.json'),...args}),
            saveStatus:value=>atomicJson(path.join(runtimeDir,'status.json'),value),
            saveBrowserProgress:value=>atomicJson(path.join(runtimeDir,'browser-recovery-progress.json'),value)});
        }
      },shouldStop);
      if(!batch.ran)break;
      const result=batch.result;lastResult=result;
      await atomicJson(path.join(runtimeDir,'status.json'),{checkedAt:new Date().toISOString(),...result,
        liveActions:config.liveActions,ignoredStaleStopRequest:control.ignoredStaleRequest});
      if(result.mailChannelError || result.actions?.some(a=>a.outcome==='isolated'))
        await notifyFailure(path.join(runtimeDir,'alert.json'),{code:'isolated',
          incidentKey:result.actions?.filter(a=>a.outcome==='isolated').map(a=>a.targetId).sort().join(',') || 'mail_channel',
          detail:'存在隔离任务或邮件通道故障，其他有效席位任务继续办理。'});
      await flushFailureAlerts(path.join(runtimeDir,'alert.json'));
      if(batch.stopped || args.includes('--once') || !config.liveActions || ['disabled','fault_rescue_pending'].includes(result.mode)) break;
      // Short sleeps allow graceful shutdown without interrupting an in-flight receipt.
      for(let n=0;n<config.pollSeconds && !await shouldStop();n++) await new Promise(r=>setTimeout(r,1000));
    } while(!stop);
  } catch(error) {
    failed=true;
    await atomicJson(path.join(runtimeDir,'status.json'),{checkedAt:new Date().toISOString(),state:'blocked',
      modelCalls:0,liveActions:config.liveActions,error:error.message,failureCode:error.failureCode || 'unknown',
      faultRescueEligible:error.faultRescueEligible===true,
      localContextRecoveryEligible:localContextRecoveryEligible(error,await readJson(path.join(runtimeDir,'operation.json'))),
      ...safeRuntimeDiagnostics(error),
      ...(recoverablePortalError(error)?{readFailure:error.metadata}:{})});
    if(config.liveActions) await notifyFailure(path.join(runtimeDir,'alert.json'),{code:error.failureCode || 'unknown',incidentKey:runtimeIncidentKey(error)});
    throw error;
  } finally {
    try {
      await browser.close();
      if(stop && !failed)await atomicJson(path.join(runtimeDir,'status.json'),{checkedAt:new Date().toISOString(),
        ...lastResult,state:'stopped',stopReason:control?.requestId?'local_stop_request':'signal',
        modelCalls:0,liveActions:config.liveActions,ignoredStaleStopRequest:control?.ignoredStaleRequest??false});
    } finally {try {await release();}finally {process.off('SIGINT',halt);process.off('SIGTERM',halt);}}
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===import.meta.filename)
  main().catch(async e=>{
    await atomicJson(path.join(runtimeDir,'status.json'),{checkedAt:new Date().toISOString(),state:'blocked',
      modelCalls:0,error:e.message,failureCode:e.failureCode||'unknown',
      faultRescueEligible:e.faultRescueEligible===true,
      localContextRecoveryEligible:localContextRecoveryEligible(e,await readJson(path.join(runtimeDir,'operation.json'))),
      ...safeRuntimeDiagnostics(e),
      ...(recoverablePortalError(e)?{readFailure:e.metadata}:{})}).catch(()=>{});
    // Also record setup/lock/conflict failures that happened before the browser opened.
    try {if((await loadConfig()).liveActions) await notifyFailure(path.join(runtimeDir,'alert.json'),{code:e.failureCode||'unknown',incidentKey:runtimeIncidentKey(e)});} catch {}
    console.error(e.message);process.exitCode=1;
  });
