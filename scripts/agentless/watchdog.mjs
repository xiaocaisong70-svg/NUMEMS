// Scheduled local supervisor. It never calls an Agent, model, shell or member API.
// Only narrowly classified pre-action failures may start the existing guarded worker.
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadConfig,runtimeDir} from './config.mjs';
import {readJson,atomicJson} from './journal.mjs';
import {restartDecision,reviewRetryDecision} from './watchdog-policy.mjs';
import {browserRetryDecision} from './browser-retry-policy.mjs';
const execute=promisify(execFile);
const file=path.join(runtimeDir,'watchdog.json');

export async function readStopSnapshot(directory=runtimeDir) {
  return await readEvidenceSnapshot(directory,'stop-request.json');
}

export async function readEvidenceSnapshot(directory,name) {
  if(!['stop-request.json','status.json','operation.json','admin-result.json','review-retry.json','verified-review-intent.json','browser-retry.json'].includes(name))
    throw new Error('Invalid evidence name');
  try {
    const data=await readFile(path.join(directory,name));
    return {value:JSON.parse(data.toString('utf8')),digest:createHash('sha256').update(data).digest('hex')};
  } catch(error) {if(error.code==='ENOENT')return {value:null,digest:'absent'};throw error;}
}

export function verifiedReusedIdentity(identity,pid,evidenceAt,now=Date.now()) {
  const stamp=value=>typeof value==='string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  return !!identity && identity.pid===pid && typeof identity.imageName==='string' &&
    /^[a-zA-Z0-9_.-]+\.exe$/.test(identity.imageName) && identity.imageName.toLowerCase()!=='node.exe' &&
    stamp(identity.createdAt) && stamp(evidenceAt) && Number.isFinite(now) &&
    Date.parse(identity.createdAt)>Date.parse(evidenceAt)+2000 && Date.parse(identity.createdAt)<=now;
}

export async function processGate({host,lock},signal=pid=>process.kill(pid,0),inspect=async()=>null) {
  if(lock && (!Number.isSafeInteger(lock.pid) || lock.pid<=0 || typeof lock.at!=='string' ||
      !Number.isFinite(Date.parse(lock.at))))return {clear:false,reason:'invalid_worker_lock'};
  const checks=[{pid:host?.processId,at:host?.checkedAt},{pid:lock?.pid,at:lock?.at}]
    .filter(({pid})=>pid!==undefined&&pid!==null);
  for(const {pid,at} of checks) {
    if(!Number.isSafeInteger(pid)||pid<=0)return {clear:false,reason:'invalid_worker_pid'};
    let unavailable=false;
    try {signal(pid);}
    catch(error) {if(error.code==='ESRCH')continue;unavailable=true;}
    let identity;
    try {identity=await inspect(pid);} catch {identity=null;}
    if(!verifiedReusedIdentity(identity,pid,at))
      return {clear:false,reason:unavailable?'worker_death_unverified':'existing_or_reused_worker_pid'};
  }
  return {clear:true};
}

export async function supervise({config,host,status,journal,adminResult,lock,retryRecord,reviewIntent,intentDigest,stopRequest,run,save,
  readBrowserRetry,saveBrowserRetry,now=()=>new Date()}) {
  const input={host,status,journal,adminResult,lock,retryRecord,reviewIntent,intentDigest,stopRequest,now:now().getTime()};
  const primary=restartDecision(input);
  const retry=!primary.allowed && host?.adminCommand==='review-verified-operation' ? reviewRetryDecision(input) : null;
  const decision=retry?.allowed ? retry : primary;
  const base={checkedAt:now().toISOString(),modelCalls:0,...decision};
  if(!config.liveActions || config.browserMode!=='isolated_desktop' || config.headless!==false ||
      config.legacyCheckerDisabled!==true) {
    const result={...base,state:'disabled',allowed:false,reason:'live_isolated_cutover_required'};
    await save(result);return result;
  }
  if(!decision.allowed) {const result={...base,state:'held',...(retry?{reviewRetryReason:retry.reason}: {})};await save(result);return result;}
  // This gate only adds a deny/cooldown to the existing, explicitly blocked
  // pre-action browser recovery path. In particular it does not affect the
  // separately guarded verified-operation review retry or running workers.
  let browserRetryRecord,browserRetry;
  if(decision.reason==='browser_unavailable_read_only_recovery_candidate') {
    try {
      if(typeof readBrowserRetry!=='function' || typeof saveBrowserRetry!=='function')
        throw new Error('Persistent browser retry store is required.');
      browserRetryRecord=await readBrowserRetry();
      browserRetry=browserRetryDecision({status,host,retryRecord:browserRetryRecord,now:now()});
    } catch {
      const result={...base,state:'held',allowed:false,reason:'browser_retry_store_unavailable'};
      await save(result);return result;
    }
    if(!browserRetry.allowed) {
      const {nextRecord,...detail}=browserRetry;
      const result={...base,...detail,state:'held'};await save(result);return result;
    }
    base.browserRetry={attempts:browserRetry.attempts,dueAt:browserRetry.dueAt,delayMs:browserRetry.delayMs};
  }
  // Check only desktop availability before starting a browser. No elevation,
  // secure-desktop access, or interactive-desktop fallback is attempted.
  let desktop;
  try {desktop=await run('desktop');}
  catch {const result={...base,state:'waiting_desktop'};await save(result);return result;}
  if(!desktop || desktop.windowStation?.toLowerCase()!=='winsta0' || !desktop.inputDesktop || desktop.error) {
    const result={...base,state:'waiting_desktop'};await save(result);return result;
  }
  if(browserRetry) {
    // Persist before launching. A failed or ambiguous write must not start a
    // browser; a crash after persistence consumes this attempt conservatively.
    browserRetry=browserRetryDecision({status,host,retryRecord:browserRetryRecord,now:now()});
    if(!browserRetry.allowed) {
      const {nextRecord,...detail}=browserRetry;
      const result={...base,...detail,state:'held'};await save(result);return result;
    }
    try {await saveBrowserRetry(browserRetry.nextRecord);}
    catch {
      const result={...base,state:'held',allowed:false,reason:'browser_retry_store_unavailable'};
      await save(result);return result;
    }
    base.browserRetry={attempts:browserRetry.nextRecord.attempts,issuedAt:browserRetry.nextRecord.issuedAt,
      dueAt:browserRetry.dueAt,delayMs:browserRetry.delayMs};
  }
  await save({...base,state:'starting'});
  try {
    // Native host mutex is acquired BEFORE any verified dead-lock archival.
    // main.mjs then checks the current cloud lease/identity before every action.
    const isReview=decision.reason==='review_pre_submit_retry_candidate';
    await run(isReview?'review':'worker',decision);
    const result={...base,checkedAt:now().toISOString(),state:isReview?'review_exited':'worker_exited'};
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
  const [host,lock,statusSnapshot,journalSnapshot,stopSnapshot]=await Promise.all([
    ...['host-desktop.json','worker.lock'].map(name=>readJson(path.join(runtimeDir,name))),
    ...['status.json','operation.json'].map(name=>readEvidenceSnapshot(runtimeDir,name)),
    readStopSnapshot()]);
  // Unrelated old administrator reports must not affect the existing recovery
  // paths; read this proof only for the exact reviewed-operation exit.
  const adminSnapshot=host?.mode==='admin' && host.adminCommand==='review-verified-operation'
    ? await readEvidenceSnapshot(runtimeDir,'admin-result.json') : {value:null,digest:'absent'};
  const retrySnapshot=host?.mode==='admin' && host.adminCommand==='review-verified-operation'
    ? await readEvidenceSnapshot(runtimeDir,'review-retry.json') : {value:null,digest:'absent'};
  const intentSnapshot=host?.mode==='admin' && host.adminCommand==='review-verified-operation'
    ? await readEvidenceSnapshot(runtimeDir,'verified-review-intent.json') : {value:null,digest:'absent'};
  const {value:status}=statusSnapshot,{value:journal}=journalSnapshot,{value:adminResult}=adminSnapshot;
  const stopRequest=stopSnapshot.value;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const gate=await processGate({host,lock},undefined,async pid=>{
    const result=await execute(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
      path.join(import.meta.dirname,'pid-identity.ps1'),'-ProcessId',String(pid)],
      {windowsHide:true,timeout:10_000,maxBuffer:16_384});
    return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
  });
  if(!gate.clear) {
    const result={checkedAt:new Date().toISOString(),state:'held',...gate,modelCalls:0};
    await atomicJson(file,result);return result;
  }
  let browserRetrySnapshot;
  return supervise({config,host,status,journal,adminResult,lock,retryRecord:retrySnapshot.value,
    reviewIntent:intentSnapshot.value,intentDigest:intentSnapshot.digest,stopRequest,
    save:report=>atomicJson(file,report),
    readBrowserRetry:async()=>{
      browserRetrySnapshot=await readEvidenceSnapshot(runtimeDir,'browser-retry.json');
      return browserRetrySnapshot.value;
    },
    saveBrowserRetry:async value=>{
      const fresh=await readEvidenceSnapshot(runtimeDir,'browser-retry.json');
      if(!browserRetrySnapshot || fresh.digest!==browserRetrySnapshot.digest)
        throw new Error('Browser retry record changed during the guarded check.');
      await atomicJson(path.join(runtimeDir,'browser-retry.json'),value);
    },
    run:async (kind,decision)=>{
      let retryProof=null;
      if(kind==='review') {
        await atomicJson(path.join(runtimeDir,'review-retry.json'),{version:1,failureId:decision.failureId,
          targetId:decision.targetId,operationId:decision.operationId,attempts:decision.attempts,issuedAt:new Date().toISOString()});
        retryProof=await readEvidenceSnapshot(runtimeDir,'review-retry.json');
      }
      if(kind==='worker' || kind==='review')await atomicJson(path.join(runtimeDir,'watchdog-start.json'),{
        version:1,pid:process.pid,at:new Date().toISOString(),stopDigest:stopSnapshot.digest,
        expectedHostPid:host?.processId??null,expectedHostCheckedAt:host?.checkedAt??null,
        ...(retryProof?{reviewExpected:{failureId:decision.failureId,targetId:decision.targetId,
          operationId:decision.operationId}}:{}),
        ...(['reviewed_verified_operation_start_candidate','review_pre_submit_retry_candidate'].includes(decision?.reason)
          ? {reviewProofDigests:{status:statusSnapshot.digest,journal:journalSnapshot.digest,
            admin:adminSnapshot.digest,intent:intentSnapshot.digest,...(retryProof?{retry:retryProof.digest}:{})}}:{})});
      const args=['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
        path.join(import.meta.dirname,kind==='desktop'?'desktop-probe.ps1':'isolated-desktop.ps1'),
        ...(kind==='worker'?['-NodeExe',process.execPath,'-Mode','run','-RecoverSettledLock']:
          kind==='review'?['-NodeExe',process.execPath,'-Mode','admin','-AdminCommand','review-verified-operation','-ReviewRetry']:[])];
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
