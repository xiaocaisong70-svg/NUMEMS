// Explicit local credential handoff only. Never start a browser, model or API
// call here. The caller must capture --credential stdout inside functions.exec,
// immediately match the connected portal's fresh status, then use atomic APIs.
import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {readJson,atomicJson} from './journal.mjs';import {loadConfig,runtimeDir} from './config.mjs';
import {faultRescueFile,faultRescueDeadline} from './fault-rescue.mjs';
import {faultRescueHostSafe,processGate} from './watchdog.mjs';
const execute=promisify(execFile);
async function inspectPid(pid) {
  if(process.platform!=='win32')return null;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await execute(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
    path.join(import.meta.dirname,'pid-identity.ps1'),'-ProcessId',String(pid)],{windowsHide:true,timeout:10_000,maxBuffer:16_384});
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
}
export async function readFaultRescueContext({directory,config,rescueId,credential=false,clock=()=>new Date(),
  signal=pid=>process.kill(pid,0),inspect=inspectPid}) {
  const [r,host,lock,stop,journal]=await Promise.all([
    readJson(faultRescueFile(directory)),...['host-desktop.json','worker.lock','stop-request.json','operation.json'].map(name=>readJson(path.join(directory,name)))]);
  if(r?.version!==1||!r.ticket||r.ticket.id!==rescueId||r.failureId!==r.ticket.failureId||
    r.threadId!==config.faultRescue?.threadId||typeof r.ticket.token!=='string'||r.ticket.token.length<16||
    r.ticket.token.length>200||!Number.isFinite(Date.parse(r.createdAt))||!r.dispatchStartedAt||
    !['queued','sending','uncertain'].includes(r.phase)||!['read_only_reconcile','approved_member_ops'].includes(r.ticket.scope))
    throw new Error('The requested dispatched rescue identity is not current.');
  const deadline=faultRescueDeadline(r),expired=deadline!==null&&clock().getTime()>=deadline;
  const view={rescueId:r.ticket.id,failureId:r.failureId,clientId:r.clientId,scope:r.ticket.scope,expiresAt:r.ticket.expiresAt??null,expired,
    targetIds:r.targetIds??[],cloudStatusRequired:true};
  if(!credential)return view;
  if(config.liveActions!==true||config.legacyCheckerDisabled!==true||config.faultRescue?.enabled!==true||
    config.browserMode!=='isolated_desktop'||config.headless!==false||expired)
    throw new Error('Credential handoff is disabled or expired; only original-result reconciliation is permitted.');
  const gate=await processGate({host,lock},signal,inspect);
  if(!faultRescueHostSafe({host,lock,stopRequest:stop,processClear:gate.clear,now:clock().getTime()}))
    throw new Error('The ordinary worker and isolated host have not been proven stopped.');
  const settled=!journal||journal.phase==='settled'&&journal.lease==null&&journal.receipt==null&&journal.submission==null;
  if(r.ticket.scope==='approved_member_ops'&&!settled)
    throw new Error('An original local operation remains unsettled; member execution cannot take over.');
  if(r.ticket.scope==='read_only_reconcile'&&!settled&&(!r.originalOperationId||journal.lease?.id!==r.originalOperationId))
    throw new Error('The original read-only lease does not match.');
  return {...view,workerStopped:true,hostVerifiedAt:clock().toISOString(),siteUrl:config.siteUrl,
    workspaceId:config.workspaceId,administrator:config.adminEmail,
    credential:{rescueId:r.ticket.id,token:r.ticket.token,expectedFailureId:r.failureId},
    allowedTargets:r.ticket.targets??[]};
}
/** Timestamp-only fact recorded immediately AFTER the official send click.
 * Never changes a lease, deadline, authorization, employee or existing marker. */
export async function recordRescueSubmission({directory,rescueId,operationId,targetId,invitationSentAt,clock=()=>new Date()}) {
  if(!/^op_[a-zA-Z0-9_-]{1,240}$/.test(operationId??'')||!/^req_[a-zA-Z0-9_]{1,240}$/.test(targetId??''))
    throw new Error('A current operation and target are required.');
  const r=await readJson(faultRescueFile(directory));
  if(r?.ticket?.id!==rescueId||r.ticket.scope!=='approved_member_ops'||!r.dispatchStartedAt||
    !['queued','sending','uncertain'].includes(r.phase))throw new Error('The dispatched execution ticket is not current.');
  const target=r.ticket.targets?.find(x=>x.kind==='invite'&&x.targetId===targetId);
  if(!target||target.operationId&&target.operationId!==operationId)throw new Error('The invitation does not match the frozen target.');
  const file=path.join(directory,'rescue-submissions.json'),previous=await readJson(file);
  if(previous&&(previous.version!==1||!Array.isArray(previous.entries)))throw new Error('Submission evidence is invalid; preserve it.');
  const entries=previous?.entries??[],prior=entries.find(x=>x.rescueId===rescueId&&(x.operationId===operationId||x.targetId===targetId));
  if(prior) {
    if(prior.operationId!==operationId||prior.targetId!==targetId||prior.invitationSentAt!==invitationSentAt||prior.email!==target.email||prior.clientId!==r.clientId)
      throw new Error('Existing submission evidence cannot be changed.');
    return {stored:true,rescueId,operationId,targetId,invitationSentAt};
  }
  const sent=Date.parse(invitationSentAt),now=clock().getTime();
  if(typeof invitationSentAt!=='string'||!Number.isFinite(sent)||sent<Date.parse(r.ticket.createdAt)-5000||sent>now+5000||now-sent>60_000)
    throw new Error('The actual send timestamp must be recorded immediately.');
  const entry={rescueId,clientId:r.clientId,queuedId:r.queuedId??null,operationId,targetId,email:target.email,kind:'invite',invitationSentAt,recordedAt:clock().toISOString(),
    ...(sent>Date.parse(r.ticket.expiresAt)?{afterDeadline:true}:{})};
  await atomicJson(file,{version:1,entries:[...entries,entry].slice(-100)});
  return {stored:true,rescueId,operationId,targetId,invitationSentAt};
}
export async function main(args=process.argv.slice(2)) {
  const [flag,rescueId,option,...extra]=args;
  if(flag!=='--rescue-id'||!/^rescue_[a-zA-Z0-9_-]{16,100}$/.test(rescueId??''))throw new Error('An existing rescue ID is required.');
  let result;
  if(option==='--submission') {
    const [opFlag,operationId,targetFlag,targetId,timeFlag,invitationSentAt,...rest]=extra;
    if(opFlag!=='--operation-id'||targetFlag!=='--target-id'||timeFlag!=='--invitation-sent-at'||rest.length)
      throw new Error('Submission requires the original operation, target and actual click time.');
    result=await recordRescueSubmission({directory:runtimeDir,rescueId,operationId,targetId,invitationSentAt});
  }else {
    if(extra.length||option!==undefined&&option!=='--credential')throw new Error('Unsupported context option.');
    result=await readFaultRescueContext({directory:runtimeDir,config:await loadConfig(),rescueId,credential:option==='--credential'});
  }
  process.stdout.write(JSON.stringify(result)+'\n');return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename)
  main().catch(()=>{console.error('Fault rescue context is not available; no credentials were exported.');process.exitCode=1;});
