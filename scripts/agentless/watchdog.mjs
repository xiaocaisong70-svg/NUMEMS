// Routine supervision is deterministic. A separately fenced, fault-only broker
// may enqueue one read-only diagnostic after finite script recovery is exhausted.
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadConfig,runtimeDir} from './config.mjs';
import {readJson,atomicJson} from './journal.mjs';
import {restartDecision,reviewRetryDecision} from './watchdog-policy.mjs';
import {browserRetryDecision} from './browser-retry-policy.mjs';
import {isStoppedFaultRescueProof} from './fault-rescue-proof.mjs';
import {stoppedFaultRescueEvidence,faultRescueIdentity} from './fault-rescue-ownership.mjs';
import {faultRescueGate,faultRescueFile,faultRescueDeadline,dispatchPreparedFaultRescue,reconcileFaultRescueDispatch,
  settleFaultRescue} from './fault-rescue.mjs';
const execute=promisify(execFile);
const file=path.join(runtimeDir,'watchdog.json');

export async function readStopSnapshot(directory=runtimeDir) {
  return await readEvidenceSnapshot(directory,'stop-request.json');
}

export async function readEvidenceSnapshot(directory,name) {
  if(!['stop-request.json','status.json','operation.json','admin-result.json','review-retry.json','verified-review-intent.json','browser-retry.json','fault-rescue.json'].includes(name))
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

const stamp=value=>typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const rescueCodes=new Set(['browser_unavailable','login_expired','unknown']);
function stopVeto(stop,host,now) {
  if(!stop)return false;
  return stop.version!==1||typeof stop.id!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(stop.id)||
    !Number.isSafeInteger(stop.target?.pid)||stop.target.pid<=0||
    !stamp(stop.requestedAt)||!stamp(stop.target.at)||Date.parse(stop.target.at)>Date.parse(stop.requestedAt)||
    Date.parse(stop.requestedAt)>now||!host||stop.target.pid===host.processId||Date.parse(stop.requestedAt)>=Date.parse(host.checkedAt);
}
/** Caller must separately prove PID death. A process report alone never proves
 * that a browser or worker has exited; the native host rechecks under its mutex. */
export function faultRescueHostSafe({host,lock,stopRequest,processClear,now=Date.now()}) {
  const a=host?.windowAudit;
  return processClear===true&&lock==null&&['probe','once','run','admin'].includes(host?.mode)&&['exited','blocked'].includes(host?.state)&&
    Number.isInteger(host.exitCode)&&host.exitCode>=0&&!host.error&&host.modelCalls===0&&
    stamp(host.checkedAt)&&Date.parse(host.checkedAt)<=now&&Number.isSafeInteger(host.processId)&&host.processId>0&&
    Number.isSafeInteger(host.audits)&&host.audits>0&&host.maxOwnedWindowsOnInputDesktop===0&&
    typeof host.desktop==='string'&&/^NUMEMS-Agentless-[a-zA-Z0-9-]+$/.test(host.desktop)&&
    a?.isolated===true&&a.desktop===host.desktop&&typeof a.inputDesktop==='string'&&!!a.inputDesktop&&
    a.inputDesktop.toLowerCase()!==host.desktop.toLowerCase()&&a.ownedWindowsOnInputDesktop===0&&
    !stopVeto(stopRequest,host,now);
}

/** A successful finish can seed only the existing guarded worker, using exact
 * terminal-turn, cloud-finish, settled-journal and fresh isolated host evidence. */
export function faultRescueRestartDecision({host,status,journal,adminResult,rescue,stopRequest,now=Date.now()}) {
  const deny={allowed:false,reason:'fault_rescue_restart_unverified'};
  if(!rescue||!faultRescueGate(rescue).allowWorker||rescue.outcome!=='recovered'||rescue.phase!=='finished'||
    !faultRescueHostSafe({host,lock:null,stopRequest,processClear:true,now})||host.mode!=='admin'||
    host.adminCommand!=='finish-fault-rescue'||host.state!=='exited'||host.exitCode!==0||
    journal?.phase!=='settled'||journal.lease!=null||journal.receipt!=null||journal.submission!=null||
    status?.mode!=='idle'||status.state!=null||status.failureCode||status.error||status.liveActions!==true||status.modelCalls!==0||
    status.faultRescueEvidence?.rescueId!==rescue.ticket?.id||status.faultRescueEvidence?.failureId!==rescue.failureId||
    adminResult?.command!=='finish-fault-rescue'||adminResult.requestId!==rescue.ticket?.id||adminResult.success!==true||adminResult.modelCalls!==0||
    adminResult.result?.rescueId!==rescue.ticket.id||adminResult.result.state!=='finished'||adminResult.result.outcome!=='recovered'||
    adminResult.result.failureId!==rescue.failureId)return deny;
  const p=stoppedFaultRescueEvidence(rescue,{now});
  if(!p||
    ![rescue.createdAt,rescue.updatedAt,p.observedAt,status.checkedAt,adminResult.startedAt,adminResult.finishedAt].every(stamp))return deny;
  if(Date.parse(rescue.createdAt)>Date.parse(p.observedAt)||Date.parse(p.observedAt)>Date.parse(rescue.updatedAt)||
    Date.parse(rescue.updatedAt)>Date.parse(status.checkedAt)||Date.parse(adminResult.startedAt)>Date.parse(p.observedAt)||
    Date.parse(status.checkedAt)>Date.parse(adminResult.finishedAt)||Date.parse(adminResult.finishedAt)>Date.parse(host.checkedAt)||
    now-Date.parse(host.checkedAt)>15*60_000)return deny;
  return {allowed:true,reason:'fault_rescue_verified_start_candidate',rescueId:rescue.ticket.id,failureId:rescue.failureId};
}

/** Only the exact, locally proven pre-claim closed-page failure is retried.
 * This grants no unknown-action recovery: the administrator helper must still
 * prove fresh healthy official/cloud state, and refuses any new global unknown. */
export async function superviseLocalContextRecovery({directory,config,host,status,journal,lock,stopRequest,processClear,
  runAdmin,runProbe,refreshSafety,save,now=()=>new Date()}) {
  if(status?.localContextRecoveryEligible!==true)return {handled:false};
  const report=async(reason,extra={})=>{
    const result={checkedAt:now().toISOString(),state:'local_context_recovery',allowed:false,reason,modelCalls:0,...extra};
    await save(result);return {handled:true,result};
  };
  if(status.state!=='blocked'||status.failureCode!=='unknown'||
    status.error!=='page.evaluate: Target page, context or browser has been closed'||!stamp(status.checkedAt)||
    Date.parse(status.checkedAt)>now().getTime())return report('local_context_marker_unverified');
  if(config.liveActions!==true||config.browserMode!=='isolated_desktop'||config.headless!==false||config.legacyCheckerDisabled!==true)
    return report('local_context_cutover_disabled');
  const rescue=await readJson(faultRescueFile(directory));
  if(!faultRescueGate(rescue).allowWorker)return report('fault_rescue_owns_recovery');
  if(journal?.phase!=='settled'||journal.lease!=null||journal.receipt!=null||journal.submission!=null)
    return report('local_context_original_operation_unsettled');
  if(!faultRescueHostSafe({host,lock,stopRequest,processClear,now:now().getTime()}))return report('local_context_host_not_closed');
  const retryFile=path.join(directory,'local-context-retry.json'),previous=await readJson(retryFile);
  if(previous&&(previous.version!==1||!Number.isSafeInteger(previous.attempts)||previous.attempts<1||previous.attempts>=Number.MAX_SAFE_INTEGER||
    !stamp(previous.requestedAt)||!stamp(previous.sourceStatusAt)||Date.parse(previous.requestedAt)>now().getTime()||
    Date.parse(previous.sourceStatusAt)>Date.parse(status.checkedAt)||!['attempted','official_healthy'].includes(previous.state)))
    return report('local_context_retry_evidence_invalid');
  // A later verified official-health epoch permits a new first attempt. Merely
  // changing a local status timestamp or restarting the supervisor does not.
  const reset=previous?.state==='official_healthy'&&stamp(previous.verifiedAt)&&Date.parse(previous.verifiedAt)<Date.parse(status.checkedAt);
  const attempts=previous&&!reset?previous.attempts:0;
  const anchor=Math.max(Date.parse(status.checkedAt),previous&&!reset?Date.parse(previous.requestedAt):0);
  const delays=[60_000,120_000,300_000,600_000,900_000,1_800_000];
  const dueAt=new Date(anchor+delays[Math.min(attempts,delays.length-1)]).toISOString();
  if(now().getTime()<Date.parse(dueAt))return report('local_context_read_only_backoff',{attempts,dueAt});
  const next={version:1,state:'attempted',attempts:attempts+1,requestedAt:now().toISOString(),sourceStatusAt:status.checkedAt,
    statusDigest:createHash('sha256').update(JSON.stringify(status)).digest('hex')};
  await atomicJson(retryFile,next); // intent precedes even a read-only recovery launch.
  try {await runAdmin('recover-browser');}catch{return report('local_context_fresh_health_not_verified',{attempts:next.attempts});}
  const proof=await refreshSafety();
  if(!faultRescueHostSafe({...proof,now:now().getTime()})||proof.host?.mode!=='admin'||
    proof.host.adminCommand!=='recover-browser'||proof.host.state!=='exited'||proof.host.exitCode!==0||
    proof.adminResult?.command!=='recover-browser'||proof.adminResult.success!==true||proof.adminResult.result?.state!=='verified'||
    proof.adminResult.result.modelCalls!==0||!stamp(proof.adminResult.result.officialObservedAt)||
    Date.parse(proof.adminResult.result.officialObservedAt)<Date.parse(next.requestedAt)-5000||
    Date.parse(proof.adminResult.result.officialObservedAt)>now().getTime()+5000||
    now().getTime()-Date.parse(proof.adminResult.result.officialObservedAt)>60_000)
    return report('local_context_fresh_health_not_verified',{attempts:next.attempts});
  // recover-browser success means a NEW complete official snapshot and a
  // healthy matching cloud plan; it never suppresses a genuine global unknown.
  await atomicJson(retryFile,{...next,state:'official_healthy',verifiedAt:now().toISOString()});
  try {await runProbe();}catch{return report('local_context_isolated_probe_unavailable',{attempts:next.attempts});}
  return report('local_context_isolated_probe_exited',{attempts:next.attempts,cause:'closed_page_context_pre_claim'});
}

/** Two-phase exceptional supervisor. No host or browser is held during queue
 * dispatch/poll. runAdmin opens a fresh isolated metadata host and MUST close it
 * before refreshSafety resolves. Normal no-fault ticks never create a client. */
export async function superviseFaultRescue({directory,config,host,status,journal,lock,stopRequest,processClear,
  runAdmin,runProbe,refreshSafety,withClient,save,projectRoot,now=()=>new Date()}) {
  let r=await readJson(faultRescueFile(directory));
  const report=async(reason,extra={})=>{
    const result={checkedAt:now().toISOString(),state:'fault_rescue',allowed:false,reason,
      rescueId:r?.ticket?.id??null,failureId:r?.failureId??null,
      ...(r?.dispatchStartedAt?{modelUsage:'reported_by_codex'}:{modelCalls:0}),...extra};
    await save(result);return {handled:true,result};
  };
  const active=r&&!faultRescueGate(r).allowWorker;
  const candidate=config.faultRescue?.enabled===true&&['read_only_reconcile','approved_member_ops'].includes(config.faultRescue.scope)&&
    config.liveActions===true&&status?.state==='blocked'&&status.faultRescueEligible===true&&rescueCodes.has(status.failureCode);
  const health=r?.phase==='finished'?await readJson(path.join(directory,'browser-retry.json')):null;
  const newerHealth=health?.version===2&&health.state==='healthy'&&stamp(health.officialObservedAt)&&stamp(r?.createdAt)&&
    Date.parse(health.officialObservedAt)>Date.parse(r.createdAt);
  const postRetry=!active&&r?.phase==='finished'&&['unresolved','handled'].includes(r.outcome)&&r.failureCode==='browser_unavailable'&&
    !newerHealth&&status?.state==='blocked'&&status.failureCode==='browser_unavailable'&&journal?.phase==='settled'&&journal.lease==null&&journal.receipt==null&&journal.submission==null;
  if(!active&&!candidate&&!postRetry)return {handled:false,rescue:r};
  if(config.liveActions!==true||config.browserMode!=='isolated_desktop'||config.headless!==false||config.legacyCheckerDisabled!==true)
    return active?report('fault_rescue_cutover_disabled'):{handled:false,rescue:r};
  if(!faultRescueHostSafe({host,lock,stopRequest,processClear,now:now().getTime()}))return report('fault_rescue_host_not_closed');
  // Current work, deadlines and server quotas are checked by ordinary code at
  // least every supervisor minute. Never sleep 30 minutes on stale local work.
  let planCheck=await readJson(path.join(directory,'fault-rescue-plan.json')),preparedThisTick=false;
  if(config.faultRescue?.scope==='approved_member_ops'&&!active&&candidate&&
    (!stamp(planCheck?.checkedAt)||now().getTime()-Date.parse(planCheck.checkedAt)>=60_000)) {
    try {await runAdmin('prepare-fault-rescue');}catch{}
    preparedThisTick=true;
    const proof=await refreshSafety();r=await readJson(faultRescueFile(directory));
    planCheck=await readJson(path.join(directory,'fault-rescue-plan.json'));
    if(!faultRescueHostSafe({...proof,now:now().getTime()}))return report('fault_rescue_prepare_host_not_closed');
    if(!r)return report(planCheck?.pendingCount===0?'no_valid_pending_work':
      planCheck?.rescueCanBegin===false?'member_rescue_'+planCheck.rescueReason:'fault_rescue_prepare_unavailable');
  }
  const pendingWork=Number.isSafeInteger(planCheck?.pendingCount)&&planCheck.pendingCount>0&&stamp(planCheck.checkedAt)&&
    now().getTime()-Date.parse(planCheck.checkedAt)<=65_000;
  // An ended, unresolved model does not disable finite deterministic recovery.
  // These reads retain backoff across restarts and never create another wake.
  if(postRetry&&r?.phase==='finished') {
    const delays=[60_000,120_000,300_000,600_000,900_000,1_800_000];
    const n=r.readOnlyRetry?.attempts??0,anchor=r.readOnlyRetry?.requestedAt??r.updatedAt;
    if(!Number.isSafeInteger(n)||n<0||!stamp(anchor)||Date.parse(anchor)>now().getTime())return report('fault_rescue_retry_evidence_invalid');
    const delay=pendingWork?60_000:delays[Math.min(n,delays.length-1)];
    const dueAt=new Date(Date.parse(anchor)+delay).toISOString();
    if(now().getTime()<Date.parse(dueAt))return report('fault_rescue_read_only_backoff',{dueAt});
    r={...r,readOnlyRetry:{attempts:n+1,requestedAt:now().toISOString()}};await atomicJson(faultRescueFile(directory),r);
    try {await runAdmin('recover-browser');}
    catch{return report('fault_rescue_read_only_retry_unavailable');}
    const proof=await refreshSafety();
    if(!faultRescueHostSafe({...proof,now:now().getTime()})||proof.host?.mode!=='admin'||
      proof.host.adminCommand!=='recover-browser'||proof.host.state!=='exited'||proof.host.exitCode!==0||
      proof.adminResult?.command!=='recover-browser'||proof.adminResult.success!==true)
      return report('fault_rescue_read_only_retry_not_verified');
    try {await runProbe();}catch{return report('fault_rescue_recovery_probe_unavailable');}
    return report('fault_rescue_recovery_probe_exited');
  }
  if(!active&&r?.phase==='finished'&&['unresolved','handled'].includes(r.outcome)&&!newerHealth)return {handled:false,rescue:r};
  if(!active&&r?.phase==='finished'&&!candidate)return {handled:false,rescue:r};
  if(config.faultRescue?.enabled!==true||!['read_only_reconcile','approved_member_ops'].includes(config.faultRescue.scope))return report('fault_rescue_dispatch_disabled');
  if(!r||r.phase==='finished'&&faultRescueGate(r).allowWorker||['preparing','uncertain'].includes(r.phase)&&!r.dispatchStartedAt&&r.reason!=='dispatch_intent_already_exists') {
    try {await runAdmin('prepare-fault-rescue');}catch{}
    preparedThisTick=true;
    const proof=await refreshSafety();r=await readJson(faultRescueFile(directory));
    if(!faultRescueHostSafe({...proof,now:now().getTime()}))return report('fault_rescue_prepare_host_not_closed');
    if(!r)return report('fault_rescue_prepare_unavailable');
    if(r.phase==='finished')return report('fault_rescue_same_incident_not_repeated');
  }
  if(r.phase==='prepared') {
    if(r.ticket?.scope==='approved_member_ops'&&!preparedThisTick) {
      try {await runAdmin('prepare-fault-rescue');}catch{}
      const proof=await refreshSafety();r=await readJson(faultRescueFile(directory));
      if(!faultRescueHostSafe({...proof,now:now().getTime()}))return report('fault_rescue_prepare_host_not_closed');
      if(!r||r.phase!=='prepared')return report('fault_rescue_pre_dispatch_recheck_changed');
    }
    const deadline=faultRescueDeadline(r);
    if(r.pendingCount===0||deadline!==null&&now().getTime()>=deadline) {
      try {await runAdmin('finish-fault-rescue',r.ticket.id);}catch{}
      r=await readJson(faultRescueFile(directory));return report('fault_rescue_expired_or_cancelled_before_dispatch');
    }
    const result=await withClient(client=>dispatchPreparedFaultRescue({directory,client,hostSafe:true,projectRoot,clock:now}));
    r=await readJson(faultRescueFile(directory));return report('fault_rescue_dispatch_'+result.state);
  }
  if(!r.dispatchStartedAt)return report('fault_rescue_ownership_unresolved');
  let stopped=false,observationReason;
  await withClient(async client=>{
    if(['sending','uncertain'].includes(r.phase))await reconcileFaultRescueDispatch({directory,client,clock:now});
    r=await readJson(faultRescueFile(directory));
    const identity={threadId:r.threadId,clientUserMessageId:r.clientId,queuedId:r.queuedId??null};
    const proof=await client.observeTurnState(identity);
    stopped=isStoppedFaultRescueProof(proof,faultRescueIdentity(r),{now:now().getTime(),maxAgeMs:60_000});
    if(stopped) {r={...r,watchdogStopProof:proof};await atomicJson(faultRescueFile(directory),r);}
    else observationReason=(await settleFaultRescue({directory,hostSafe:true,clock:now,
      client:{observeTurnState:async()=>proof,interruptTrackedTurn:(...args)=>client.interruptTrackedTurn(...args)},
      portal:{call:async()=>{throw new Error('No metadata host may start while the diagnostic turn is active.');}}})).reason;
  });
  if(!stopped)return report(observationReason==='agent_deadline_expired_stop_unconfirmed'?observationReason:'fault_rescue_agent_stop_unconfirmed');
  try {await runAdmin('finish-fault-rescue',r.ticket.id);}catch{}
  const proof=await refreshSafety();r=await readJson(faultRescueFile(directory));
  if(!faultRescueHostSafe({...proof,now:now().getTime()}))return report('fault_rescue_finish_host_not_closed');
  return report(r?.phase==='finished'&&faultRescueGate(r,{now:now().getTime()}).allowWorker?'fault_rescue_finished':'fault_rescue_finish_unconfirmed');
}

export async function supervise({config,host,status,journal,adminResult,lock,retryRecord,reviewIntent,intentDigest,stopRequest,run,save,faultRescueRecord,
  readBrowserRetry,saveBrowserRetry,now=()=>new Date()}) {
  const ownership=faultRescueGate(faultRescueRecord);
  if(!ownership.allowWorker) {
    const result={checkedAt:now().toISOString(),modelCalls:0,state:'held',allowed:false,reason:ownership.reason};
    await save(result);return result;
  }
  const input={host,status,journal,adminResult,lock,retryRecord,reviewIntent,intentDigest,stopRequest,now:now().getTime()};
  const rescueDecision=faultRescueRestartDecision({...input,rescue:faultRescueRecord});
  const primary=rescueDecision.allowed?rescueDecision:restartDecision(input);
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
  const [host,lock,statusSnapshot,journalSnapshot,stopSnapshot,rescueSnapshot]=await Promise.all([
    ...['host-desktop.json','worker.lock'].map(name=>readJson(path.join(runtimeDir,name))),
    ...['status.json','operation.json'].map(name=>readEvidenceSnapshot(runtimeDir,name)),
    readStopSnapshot(),readEvidenceSnapshot(runtimeDir,'fault-rescue.json')]);
  // Unrelated old administrator reports must not affect the existing recovery
  // paths; read this proof only for the exact reviewed-operation exit.
  const adminSnapshot=host?.mode==='admin' && ['review-verified-operation','finish-fault-rescue','recover-browser'].includes(host.adminCommand)
    ? await readEvidenceSnapshot(runtimeDir,'admin-result.json') : {value:null,digest:'absent'};
  const retrySnapshot=host?.mode==='admin' && host.adminCommand==='review-verified-operation'
    ? await readEvidenceSnapshot(runtimeDir,'review-retry.json') : {value:null,digest:'absent'};
  const intentSnapshot=host?.mode==='admin' && host.adminCommand==='review-verified-operation'
    ? await readEvidenceSnapshot(runtimeDir,'verified-review-intent.json') : {value:null,digest:'absent'};
  const {value:status}=statusSnapshot,{value:journal}=journalSnapshot,{value:adminResult}=adminSnapshot;
  const stopRequest=stopSnapshot.value;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const inspectPid=async pid=>{
    const result=await execute(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
      path.join(import.meta.dirname,'pid-identity.ps1'),'-ProcessId',String(pid)],
      {windowsHide:true,timeout:10_000,maxBuffer:16_384});
    return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
  };
  const gate=await processGate({host,lock},undefined,inspectPid);
  if(!gate.clear) {
    const result={checkedAt:new Date().toISOString(),state:'held',...gate,modelCalls:0};
    await atomicJson(file,result);return result;
  }
  const executeIsolated=async(mode,command,id)=>{
    await execute(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
      path.join(import.meta.dirname,'isolated-desktop.ps1'),'-NodeExe',process.execPath,'-Mode',mode,
      ...(command?['-AdminCommand',command]:[]),...(id?['-RequestId',id]:[])],
      {windowsHide:true,maxBuffer:1_048_576});
  };
  const refreshSafety=async()=>{
    const [latestHost,latestLock,latestStop,latestAdmin]=await Promise.all([
      ...['host-desktop.json','worker.lock','stop-request.json','admin-result.json'].map(name=>readJson(path.join(runtimeDir,name)))]);
    const freshGate=await processGate({host:latestHost,lock:latestLock},undefined,inspectPid);
    return {host:latestHost,lock:latestLock,stopRequest:latestStop,adminResult:latestAdmin,processClear:freshGate.clear};
  };
  const localContext=await superviseLocalContextRecovery({directory:runtimeDir,config,host,lock,status,journal,stopRequest,
    processClear:gate.clear,save:report=>atomicJson(file,report),refreshSafety,
    runAdmin:command=>executeIsolated('admin',command),runProbe:()=>executeIsolated('probe')});
  if(localContext.handled)return localContext.result;
  const rescueResult=await superviseFaultRescue({directory:runtimeDir,projectRoot:path.resolve(import.meta.dirname,'../..'),
    config,host,lock,status,journal,stopRequest,processClear:gate.clear,
    save:report=>atomicJson(file,report),runAdmin:(command,id)=>executeIsolated('admin',command,id),
    runProbe:()=>executeIsolated('probe'),
    refreshSafety,
    withClient:async callback=>{
      const [{FaultRescueClient},{resolveCodexCli}]=await Promise.all([
        import('./fault-rescue-client.mjs'),import('../codex-cli-resolver.mjs')]);
      const client=new FaultRescueClient(await resolveCodexCli(config.faultRescue?.cliPath),{
        cwd:path.resolve(import.meta.dirname,'../..'),timeoutMs:30_000});
      try {await client.initialize();return await callback(client);}finally {await client.close();}
    }});
  if(rescueResult.handled)return rescueResult.result;
  let browserRetrySnapshot;
  return supervise({config,host,status,journal,adminResult,lock,retryRecord:retrySnapshot.value,
    reviewIntent:intentSnapshot.value,intentDigest:intentSnapshot.digest,stopRequest,faultRescueRecord:rescueSnapshot.value,
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
        version:1,pid:process.pid,at:new Date().toISOString(),reason:decision.reason,stopDigest:stopSnapshot.digest,
        expectedHostPid:host?.processId??null,expectedHostCheckedAt:host?.checkedAt??null,
        ...(retryProof?{reviewExpected:{failureId:decision.failureId,targetId:decision.targetId,
          operationId:decision.operationId}}:{}),
        ...(['reviewed_verified_operation_start_candidate','review_pre_submit_retry_candidate'].includes(decision?.reason)
          ? {reviewProofDigests:{status:statusSnapshot.digest,journal:journalSnapshot.digest,
            admin:adminSnapshot.digest,intent:intentSnapshot.digest,...(retryProof?{retry:retryProof.digest}:{})}}:{}),
        ...(decision?.reason==='fault_rescue_verified_start_candidate'?{faultRescueExpected:{rescueId:decision.rescueId,failureId:decision.failureId},
          faultRescueProofDigests:{rescue:rescueSnapshot.digest,admin:adminSnapshot.digest,status:statusSnapshot.digest,journal:journalSnapshot.digest}}:{})});
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
    const rescue=await readJson(faultRescueFile(runtimeDir)).catch(()=>null);
    await atomicJson(file,{checkedAt:new Date().toISOString(),state:'held',reason:'watchdog_setup_or_evidence_invalid',
      ...(rescue?.dispatchStartedAt?{modelUsage:'reported_by_codex'}:{modelCalls:0})}).catch(()=>{});
    process.exitCode=1;
  });
