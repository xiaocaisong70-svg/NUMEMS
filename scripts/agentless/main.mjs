import path from 'node:path';
import { loadConfig,configPath,runtimeDir,TASK_NAME } from './config.mjs';
import { AgentlessBrowser } from './browser.mjs';
import { PortalClient } from '../seat-executor/portal-client.mjs';
import { runBatch } from './core.mjs';
import { Journal,atomicJson,acquireLock,readJson } from './journal.mjs';
import { assertExclusive } from './guard.mjs';
import { notifyFailure } from './alert.mjs';
import { recoverBrowser } from './recovery.mjs';
import { GracefulStopControl,runGracefulBatch } from './graceful-stop.mjs';
import {recoverPortal,recoverablePortalError} from './portal-recovery.mjs';

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
    await browser.open();
    const portal=new PortalClient(browser.context,config,['review_seat_failure']);
    const journal=new Journal(path.join(runtimeDir,'operation.json'));
    let registered=false;
    do {
      if(await shouldStop())break;
      await assertExclusive(config);
      const batch=await runGracefulBatch(async()=>{
        try {
          const result=await runBatch({portal,browser,config,journal});
          if(config.liveActions && !registered && ['idle','processed'].includes(result.mode) && !await shouldStop()) {
            const p=(await portal.call('seat_portal_status')).plan;
            if(p.enabled && !p.testOnly) {
              await browser.observe();
              await portal.call('record_codex_schedule',{scheduleId:`local:seat-executor:${TASK_NAME}`});
              registered=true;
            }
          }
          return result;
        }
        catch(error) {
          if(recoverablePortalError(error))return recoverPortal({error,portal,browser,config,
            journalFile:path.join(runtimeDir,'operation.json'),shouldStop,
            saveStatus:value=>atomicJson(path.join(runtimeDir,'status.json'),value)});
          if(error.failureCode!=='browser_unavailable' || !await recoverBrowser({portal,browser,
            journalFile:path.join(runtimeDir,'operation.json')})) throw error;
          return {mode:'browser_recovered',modelCalls:0};
        }
      },shouldStop);
      if(!batch.ran)break;
      const result=batch.result;lastResult=result;
      await atomicJson(path.join(runtimeDir,'status.json'),{checkedAt:new Date().toISOString(),...result,
        liveActions:config.liveActions,ignoredStaleStopRequest:control.ignoredStaleRequest});
      if(result.mailChannelError || result.actions?.some(a=>a.outcome==='isolated'))
        await notifyFailure(path.join(runtimeDir,'alert.json'),{code:'isolated',detail:'存在隔离任务或邮件通道故障，其他有效席位任务继续办理。'});
      if(batch.stopped || args.includes('--once') || !config.liveActions || result.mode==='disabled') break;
      // Short sleeps allow graceful shutdown without interrupting an in-flight receipt.
      for(let n=0;n<config.pollSeconds && !await shouldStop();n++) await new Promise(r=>setTimeout(r,1000));
    } while(!stop);
  } catch(error) {
    failed=true;
    await atomicJson(path.join(runtimeDir,'status.json'),{checkedAt:new Date().toISOString(),state:'blocked',
      modelCalls:0,liveActions:config.liveActions,error:error.message,failureCode:error.failureCode || 'unknown',
      ...(recoverablePortalError(error)?{readFailure:error.metadata}:{})});
    if(config.liveActions) await notifyFailure(path.join(runtimeDir,'alert.json'),{code:error.failureCode || 'unknown'});
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
      ...(recoverablePortalError(e)?{readFailure:e.metadata}:{})}).catch(()=>{});
    // Also record setup/lock/conflict failures that happened before the browser opened.
    try {if((await loadConfig()).liveActions) await notifyFailure(path.join(runtimeDir,'alert.json'),{code:e.failureCode||'unknown'});} catch {}
    console.error(e.message);process.exitCode=1;
  });
