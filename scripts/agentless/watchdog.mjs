// Scheduled local supervisor. It never calls an Agent, model, shell or member API.
// Only narrowly classified pre-action failures may start the existing guarded worker.
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadConfig,runtimeDir} from './config.mjs';
import {readJson,atomicJson} from './journal.mjs';
import {restartDecision} from './watchdog-policy.mjs';
const execute=promisify(execFile);
const file=path.join(runtimeDir,'watchdog.json');

export async function readStopSnapshot(directory=runtimeDir) {
  try {
    const data=await readFile(path.join(directory,'stop-request.json'));
    return {value:JSON.parse(data.toString('utf8')),digest:createHash('sha256').update(data).digest('hex')};
  } catch(error) {if(error.code==='ENOENT')return {value:null,digest:'absent'};throw error;}
}

export function processGate({host,lock},signal=pid=>process.kill(pid,0)) {
  if(lock && (!Number.isSafeInteger(lock.pid) || lock.pid<=0 || typeof lock.at!=='string' ||
      !Number.isFinite(Date.parse(lock.at))))return {clear:false,reason:'invalid_worker_lock'};
  const pids=new Set([host?.processId,lock?.pid].filter(pid=>pid!==undefined&&pid!==null));
  for(const pid of pids) {
    if(!Number.isSafeInteger(pid)||pid<=0)return {clear:false,reason:'invalid_worker_pid'};
    try {signal(pid);return {clear:false,reason:'existing_or_reused_worker_pid'};}
    catch(error) {if(error.code!=='ESRCH')return {clear:false,reason:'worker_death_unverified'};}
  }
  return {clear:true};
}

export async function supervise({config,host,status,journal,stopRequest,run,save,now=()=>new Date()}) {
  const decision=restartDecision({host,status,journal,stopRequest,now:now().getTime()});
  const base={checkedAt:now().toISOString(),modelCalls:0,...decision};
  if(!config.liveActions || config.browserMode!=='isolated_desktop' || config.headless!==false ||
      config.legacyCheckerDisabled!==true) {
    const result={...base,state:'disabled',allowed:false,reason:'live_isolated_cutover_required'};
    await save(result);return result;
  }
  if(!decision.allowed) {const result={...base,state:'held'};await save(result);return result;}
  // Check only desktop availability before starting a browser. No elevation,
  // secure-desktop access, or interactive-desktop fallback is attempted.
  let desktop;
  try {desktop=await run('desktop');}
  catch {const result={...base,state:'waiting_desktop'};await save(result);return result;}
  if(!desktop || desktop.windowStation?.toLowerCase()!=='winsta0' || !desktop.inputDesktop || desktop.error) {
    const result={...base,state:'waiting_desktop'};await save(result);return result;
  }
  await save({...base,state:'starting'});
  try {
    // Native host mutex is acquired BEFORE any verified dead-lock archival.
    // main.mjs then checks the current cloud lease/identity before every action.
    await run('worker');
    const result={...base,checkedAt:now().toISOString(),state:'worker_exited'};
    await save(result);return result;
  } catch {
    // Never interpret a nonzero exit as permission to retry here. Next scheduled
    // check must reclassify fresh host, journal and status evidence from scratch.
    const result={...base,checkedAt:now().toISOString(),state:'worker_failed'};
    await save(result);return result;
  }
}

export async function main() {
  if(process.platform!=='win32')throw new Error('Watchdog requires the Windows user session.');
  const config=await loadConfig();
  const [host,status,journal,lock,stopSnapshot]=await Promise.all([
    ...['host-desktop.json','status.json','operation.json','worker.lock'].map(name=>readJson(path.join(runtimeDir,name))),
    readStopSnapshot()]);
  const stopRequest=stopSnapshot.value;
  const gate=processGate({host,lock});
  if(!gate.clear) {
    const result={checkedAt:new Date().toISOString(),state:'held',...gate,modelCalls:0};
    await atomicJson(file,result);return result;
  }
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return supervise({config,host,status,journal,stopRequest,
    save:report=>atomicJson(file,report),
    run:async kind=>{
      if(kind==='worker')await atomicJson(path.join(runtimeDir,'watchdog-start.json'),{
        version:1,pid:process.pid,at:new Date().toISOString(),stopDigest:stopSnapshot.digest,
        expectedHostPid:host?.processId??null});
      const args=['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
        path.join(import.meta.dirname,kind==='desktop'?'desktop-probe.ps1':'isolated-desktop.ps1'),
        ...(kind==='worker'?['-NodeExe',process.execPath,'-Mode','run','-RecoverSettledLock']:[])];
      const result=await execute(powershell,args,{windowsHide:true,maxBuffer:1_048_576,
        ...(kind==='desktop'?{timeout:20_000}:{})});
      return kind==='desktop'?JSON.parse(result.stdout.trim().replace(/^\uFEFF/,'')):null;
    }});
}
if(process.argv[1] && path.resolve(process.argv[1])===import.meta.filename)
  main().catch(async()=>{
    await atomicJson(file,{checkedAt:new Date().toISOString(),state:'held',reason:'watchdog_setup_or_evidence_invalid',modelCalls:0}).catch(()=>{});
    process.exitCode=1;
  });
