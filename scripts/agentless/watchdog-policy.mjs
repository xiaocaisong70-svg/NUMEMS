// Pure restart eligibility only. Before using ANY allowed result, a caller must
// prove host AND lock PID death (reject live/reused PIDs and inaccessible processes),
// then recheck that proof under the native project mutex. The caller must also
// prove exclusive ownership, desktop isolation and the current cloud plan.
// Never clears a lock, settles a journal, resumes a lease or launches a browser.
import {validPortalFailure} from './portal-recovery.mjs';
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
const orphanedIdleWorker = (host,status,journal) => {
  return host?.mode==='run' && host.state==='running' && positivePid(host.processId) &&
    !present(host.error) && !present(host.failureCode) && !present(host.exitCode) &&
    isolatedAudit(host) && cleanIdleRecords(host,status,journal);
};

export function restartDecision(input={}) {
  if(!record(input))return deny('invalid_input');
  const {host=null,status=null,journal=null,stopRequest=null,now=Date.now()}=input;
  const current=timeOf(now);
  if(!Number.isFinite(current))return deny('invalid_now');
  for(const [name,value] of Object.entries({host,status,journal,stopRequest})) {
    if(present(value) && !record(value))return deny(`invalid_${name}`);
  }
  // Even an apparently settled journal cannot override retained lease/evidence.
  if(journal && (present(journal.lease) || present(journal.receipt)))return deny('retained_operation_evidence');
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
      (present(status.mode) && !['idle','processed','browser_recovered','disabled','dry_run','portal_recovery'].includes(status.mode)) ||
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
