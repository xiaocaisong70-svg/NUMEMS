// Pure restart eligibility only. Before using ANY allowed result, a caller must
// prove host AND lock PID death, or prove that the PID now belongs to a different,
// later-created non-Node process; unknown process identities remain held. Then
// recheck that proof under the native project mutex. The caller must also
// prove exclusive ownership, desktop isolation and the current cloud plan.
// Never clears a lock, settles a journal, resumes a lease or launches a browser.
import {validPortalFailure} from './portal-recovery.mjs';
import {createHash} from 'node:crypto';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const present = value => value !== undefined && value !== null;
const positivePid = value => Number.isSafeInteger(value) && value > 0;
const stamp = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const timeOf = value => value instanceof Date ? value.getTime() : value;
const deny = reason => ({allowed:false,reason});
const allow = reason => ({allowed:true,reason});
const isolatedAudit = host => {
  const audit=host?.windowAudit;
  return !!host && host.modelCalls===0 && Number.isSafeInteger(host.audits) && host.audits>0 &&
    host.maxOwnedWindowsOnInputDesktop===0 &&
    typeof host.desktop==='string' && /^NUMEMS-Agentless-[a-zA-Z0-9-]+$/.test(host.desktop) &&
    typeof host.inputDesktop==='string' && !!host.inputDesktop.trim() &&
    host.inputDesktop.toLowerCase()!==host.desktop.toLowerCase() &&
    record(audit) && audit.isolated===true && audit.desktop===host.desktop &&
    typeof audit.inputDesktop==='string' && !!audit.inputDesktop.trim() &&
    audit.inputDesktop.toLowerCase()!==host.desktop.toLowerCase() && audit.ownedWindowsOnInputDesktop===0;
};
const cleanIdleRecords = (host,status,journal) =>
    journal?.phase==='settled' && !!status && !present(status.state) &&
    ['idle','processed'].includes(status.mode) && !present(status.failureCode) && !present(status.error);
const reviewedProbe = (host,status,journal,current) => {
  return ['probe','once'].includes(host?.mode) && host.state==='exited' && host.exitCode===0 && !present(host.error) &&
    !present(host.failureCode) && current-Date.parse(host.checkedAt)<=15*60*1000 &&
    isolatedAudit(host) && cleanIdleRecords(host,status,journal) &&
    Date.parse(status.checkedAt)<=Date.parse(host.checkedAt);
};
// A single, explicit verified-operation review can seed a supervised start.
// The worker must still obtain a fresh cloud plan and official inventory before
// any member action. Never use a generic admin command or an old idle status.
const reviewedVerifiedOperation = (host,status,journal,admin,intent,intentDigest,current) => {
  const e=status?.reviewEvidence, result=admin?.result;
  const times=[admin?.startedAt,e?.previousStatusAt,e?.firstObservedAt,e?.secondObservedAt,
    e?.workspaceReviewedAt,status?.checkedAt,admin?.finishedAt,host?.checkedAt];
  if(!times.every(stamp))return false;
  const [start,previous,first,second,reviewed,statusAt,finish,hostAt]=times.map(Date.parse);
  return host?.mode==='admin' && host.adminCommand==='review-verified-operation' &&
    host.state==='exited' && host.exitCode===0 && !present(host.error) && !present(host.failureCode) &&
    positivePid(host.processId) && isolatedAudit(host) && cleanIdleRecords(host,status,journal) &&
    status.mode==='idle' && status.liveActions===true && status.modelCalls===0 &&
    admin.command==='review-verified-operation' && admin.success===true && admin.modelCalls===0 &&
    result?.outcome==='reviewed' && result.workspaceResumed===true && result.officialSnapshots===2 &&
    result.memberActions===0 && result.modelCalls===0 &&
    typeof intentDigest==='string' && /^[0-9a-f]{64}$/.test(intentDigest) &&
    intent?.version===1 && intent.phase==='settled' && intent.failureId===e.failureId &&
    intent.operationId===e.operationId && intent.targetId===e.targetId && journal.target?.targetId===e.targetId &&
    intent.firstObservedAt===e.firstObservedAt && intent.secondObservedAt===e.secondObservedAt &&
    intent.previousStatusAt===e.previousStatusAt && intent.reviewedAt===e.workspaceReviewedAt &&
    intent.journalDigest===createHash('sha256').update(JSON.stringify(journal)).digest('hex') &&
    /^[0-9a-f]{64}$/.test(intent.statusDigest??'') &&
    typeof e.failureId==='string' && /^[a-zA-Z0-9_-]{1,160}$/.test(e.failureId) &&
    typeof e.targetId==='string' && /^req_[a-zA-Z0-9_]{1,160}$/.test(e.targetId) &&
    typeof e.operationId==='string' && /^op_[a-zA-Z0-9_-]{1,160}$/.test(e.operationId) &&
    previous<=first && first<=second && second<=reviewed && reviewed<=statusAt &&
    ((result.source==='fresh_review' && start<=first) ||
      (result.source==='receipt_recovery' && second<=start)) &&
    statusAt<=finish && finish<=hostAt && hostAt<=current && current-hostAt<=15*60*1000;
};
const orphanedIdleWorker = (host,status,journal) => {
  return host?.mode==='run' && host.state==='running' && positivePid(host.processId) &&
    !present(host.error) && !present(host.failureCode) && !present(host.exitCode) &&
    isolatedAudit(host) && cleanIdleRecords(host,status,journal);
};

export function restartDecision(input={}) {
  if(!record(input))return deny('invalid_input');
  const {host=null,status=null,journal=null,adminResult=null,reviewIntent=null,intentDigest=null,stopRequest=null,now=Date.now()}=input;
  const current=timeOf(now);
  if(!Number.isFinite(current))return deny('invalid_now');
  for(const [name,value] of Object.entries({host,status,journal,adminResult,stopRequest})) {
    if(present(value) && !record(value))return deny(`invalid_${name}`);
  }
  // Even an apparently settled journal cannot override retained lease/evidence.
  if(journal && (present(journal.lease) || present(journal.receipt) || present(journal.submission)))return deny('retained_operation_evidence');
  if(journal && journal.phase!=='settled')return deny('unsettled_or_invalid_journal');

  if(host) {
    if(!['probe','once','run','admin'].includes(host.mode) ||
      !['starting','running','exited','blocked'].includes(host.state) ||
      !stamp(host.checkedAt) || Date.parse(host.checkedAt)>current ||
      (present(host.processId) && !positivePid(host.processId)) ||
      (present(host.error) && (typeof host.error!=='string' || !host.error.trim())) ||
      (present(host.exitCode) && (!Number.isInteger(host.exitCode) || host.exitCode<0)) ||
      (present(host.modelCalls) && host.modelCalls!==0))return deny('invalid_host');
  }
  if(status) {
    if(!stamp(status.checkedAt) || Date.parse(status.checkedAt)>current ||
      (present(status.state) && !['blocked','stopped','recovering'].includes(status.state)) ||
      (present(status.mode) && !['idle','processed','browser_recovered','browser_recovery','disabled','dry_run','portal_recovery'].includes(status.mode)) ||
      (!present(status.state) && !present(status.mode)) ||
      (present(status.failureCode) && (typeof status.failureCode!=='string' || !status.failureCode.trim())) ||
      (present(status.error) && (typeof status.error!=='string' || !status.error.trim())) ||
      (present(status.modelCalls) && status.modelCalls!==0))return deny('invalid_status');
  }
  if(stopRequest) {
    if(stopRequest.version!==1 || typeof stopRequest.id!=='string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stopRequest.id) ||
      !record(stopRequest.target) || !positivePid(stopRequest.target.pid) ||
      !stamp(stopRequest.target.at) || !stamp(stopRequest.requestedAt) ||
      Date.parse(stopRequest.target.at)>Date.parse(stopRequest.requestedAt) ||
      Date.parse(stopRequest.requestedAt)>current)return deny('invalid_stop_request');
    // The report does not contain the exact worker.lock incarnation. Matching PID
    // or missing newer-session evidence is therefore conservatively treated as stop.
    if(!host || !positivePid(host.processId) || host.processId===stopRequest.target.pid ||
      Date.parse(stopRequest.requestedAt)>=Date.parse(host.checkedAt))return deny('stop_requested_or_ambiguous');
  }

  if(status?.state==='stopped' || ['disabled','dry_run'].includes(status?.mode))return deny('explicit_stop_or_disabled');
  if(['portal_read_unavailable','portal_queue_unavailable'].includes(status?.failureCode)) {
    if(!validPortalFailure(status.failureCode,status.readFailure))return deny('invalid_portal_recovery_evidence');
    if(journal?.phase!=='settled')return deny('portal_recovery_requires_settled_journal');
    if(host?.mode!=='run' || !['blocked','running'].includes(host.state) || host.error || !isolatedAudit(host))
      return deny('portal_recovery_host_unverified');
    return allow('safe_portal_health_recovery_candidate');
  }
  // A recent successful administrator-run probe/once can seed the first supervised
  // session after repair. The caller still enforces installation authorization,
  // process liveness and fresh cloud-plan gates; normal run exits never qualify.
  if(reviewedProbe(host,status,journal,current))return allow('administrator_reviewed_start_candidate');
  if(reviewedVerifiedOperation(host,status,journal,adminResult,reviewIntent,intentDigest,current))
    return allow('reviewed_verified_operation_start_candidate');
  // A system shutdown/logoff may leave an old "running" report. This does not
  // establish process death: the caller's two PID checks and mutex are mandatory.
  if(orphanedIdleWorker(host,status,journal))return allow('orphaned_idle_worker_recovery_candidate');
  if(host && (host.mode!=='run' || host.state==='exited'))return deny('non_run_or_normal_exit');
  if(host && host.state!=='blocked')return deny('host_not_confirmed_failed');
  // An idle status is not sufficient evidence to disregard the host's failure.
  if(status?.failureCode && status.failureCode!=='browser_unavailable')return deny('nonrecoverable_status_failure');
  if(status?.state==='blocked' && status.failureCode!=='browser_unavailable')return deny('unknown_status_failure');
  if(status?.error && status.failureCode!=='browser_unavailable')return deny('unclassified_status_error');

  const inputAuditFailure=host?.state==='blocked' && host.error?.includes('Input desktop cannot be audited');
  if(host?.error && !inputAuditFailure)return deny('unknown_host_failure');
  if(inputAuditFailure)return allow('input_desktop_audit_recovery_candidate');
  if(status?.state==='blocked' && status.failureCode==='browser_unavailable')
    return allow('browser_unavailable_read_only_recovery_candidate');
  if(!host && !status && !journal && !stopRequest)return allow('initial_start_without_failure');
  return deny('no_explicit_recovery_evidence');
}

// This admits ONLY a retry of read-only evidence collection, never a member
// action or an uncertain review RPC. The admin command repeats the cloud CAS
// checks and MUST persist the following structured pre-submit failure proof.
export function reviewRetryDecision(input={}) {
  const {host,status,journal,adminResult,lock=null,retryRecord=null,intentDigest,now=Date.now()}=input;
  const current=timeOf(now), base=restartDecision(input);
  if(base.reason!=='non_run_or_normal_exit' || !Number.isFinite(current))return deny('review_base_guard');
  const proof=adminResult?.reviewRetry;
  if(lock!=null || intentDigest!=='absent' || journal?.phase!=='settled' || present(journal.lease) || present(journal.receipt) || present(journal.submission) ||
     status?.state!=='blocked' || !['browser_unavailable','unknown'].includes(status.failureCode) || status.modelCalls!==0 ||
     host?.mode!=='admin' || host.adminCommand!=='review-verified-operation' || host.state!=='blocked' ||
     !Number.isInteger(host.exitCode) || host.exitCode<=0 || present(host.error) || !positivePid(host.processId) ||
     !isolatedAudit(host) || !stamp(host.checkedAt) || !stamp(status.checkedAt) ||
     adminResult?.command!=='review-verified-operation' || adminResult.success!==false || adminResult.modelCalls!==0 ||
     !stamp(adminResult.startedAt) || !stamp(adminResult.finishedAt) ||
     proof?.phase!=='pre_submit' || proof.reason!=='browser_unavailable' || proof.retryable!==true ||
     proof.statusCheckedAt!==status.checkedAt || proof.statusFailureCode!==status.failureCode ||
     typeof proof.failureId!=='string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(proof.failureId) ||
     typeof proof.targetId!=='string' || !/^req_[a-zA-Z0-9_]{1,160}$/.test(proof.targetId) ||
     journal.target?.targetId!==proof.targetId || !['invite','remove'].includes(journal.target?.kind) ||
     typeof journal.target?.email!=='string' || !journal.target.email ||
     typeof proof.operationId!=='string' || !/^op_[a-zA-Z0-9_-]{1,160}$/.test(proof.operationId))
    return deny('review_evidence_unverified');
  const hostAt=Date.parse(host.checkedAt), startedAt=Date.parse(adminResult.startedAt),
    finishedAt=Date.parse(adminResult.finishedAt);
  if(Date.parse(status.checkedAt)>startedAt || startedAt>finishedAt || finishedAt>hostAt || hostAt>current)
    return deny('review_evidence_time_invalid');
  let attempts=0;
  if(retryRecord!=null) {
    if(!record(retryRecord) || retryRecord.version!==1 ||
       typeof retryRecord.failureId!=='string' || typeof retryRecord.targetId!=='string' || typeof retryRecord.operationId!=='string' ||
       !Number.isSafeInteger(retryRecord.attempts) || retryRecord.attempts<1 || retryRecord.attempts>5 ||
       !stamp(retryRecord.issuedAt))return deny('review_retry_record_invalid');
    if(retryRecord.failureId!==proof.failureId || retryRecord.targetId!==proof.targetId || retryRecord.operationId!==proof.operationId)
      return deny('review_retry_record_mismatch');
    attempts=retryRecord.attempts;
    // An initiated retry with no later signed-off host is an uncertain run.
    if(Date.parse(retryRecord.issuedAt)>=startedAt)return deny('review_retry_unresolved');
  }
  if(attempts>=5)return deny('review_retry_limit_reached');
  const delay=[60_000,120_000,300_000,600_000,900_000][attempts];
  const dueAt=hostAt+delay;
  if(current<dueAt)return {allowed:false,reason:'review_retry_backoff',dueAt:new Date(dueAt).toISOString()};
  return {allowed:true,reason:'review_pre_submit_retry_candidate',failureId:proof.failureId,
    targetId:proof.targetId,operationId:proof.operationId,attempts:attempts+1};
}
