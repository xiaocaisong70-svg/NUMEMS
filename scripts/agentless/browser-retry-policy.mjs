// Additional throttling only. This policy never grants restart eligibility,
// touches an operation journal, or clears a cloud/local failure.
import {createHash} from 'node:crypto';

const delays=[60_000,120_000,300_000,600_000,900_000,1_800_000];
const record=value=>value!==null && typeof value==='object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);
const stamp=value=>typeof value==='string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const digest=value=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
const deny=reason=>({allowed:false,reason});

export function browserFailureDigest(status) {
  return createHash('sha256').update(JSON.stringify({checkedAt:status.checkedAt,
    failureCode:status.failureCode,error:status.error??null})).digest('hex');
}

export function browserRetryDecision({status,host,retryRecord=null,now=Date.now()}={}) {
  const current=now instanceof Date?now.getTime():now;
  if(!Number.isFinite(current) || !record(status) || status.state!=='blocked' ||
      status.failureCode!=='browser_unavailable' || !stamp(status.checkedAt) ||
      Date.parse(status.checkedAt)>current || !record(host) || host.mode!=='run' ||
      host.state!=='blocked' || !stamp(host.checkedAt) || Date.parse(host.checkedAt)>current)
    return deny('browser_retry_evidence_invalid');
  const statusDigest=browserFailureDigest(status),statusAt=Date.parse(status.checkedAt);
  let attempts=0,anchor=Math.max(statusAt,Date.parse(host.checkedAt));
  if(retryRecord!==null) {
    if(!record(retryRecord) || retryRecord.version!==1 || retryRecord.failureCode!=='browser_unavailable' ||
        !digest(retryRecord.statusDigest) || !stamp(retryRecord.statusCheckedAt) || !stamp(retryRecord.issuedAt) ||
        !Number.isSafeInteger(retryRecord.attempts) || retryRecord.attempts<1 || retryRecord.attempts>=Number.MAX_SAFE_INTEGER ||
        Date.parse(retryRecord.statusCheckedAt)>Date.parse(retryRecord.issuedAt) || Date.parse(retryRecord.issuedAt)>current)
      return deny('browser_retry_record_invalid');
    if(statusAt<Date.parse(retryRecord.statusCheckedAt) ||
        (statusAt===Date.parse(retryRecord.statusCheckedAt) && statusDigest!==retryRecord.statusDigest))
      return deny('browser_retry_status_regressed');
    // An issued launch with no later signed-off host is not permission to launch
    // again. The existing PID, mutex, journal and cloud gates remain mandatory.
    if(Date.parse(host.checkedAt)<=Date.parse(retryRecord.issuedAt))
      return deny('browser_retry_launch_unresolved');
    attempts=retryRecord.attempts;anchor=Math.max(anchor,Date.parse(retryRecord.issuedAt));
  }
  const delayMs=delays[Math.min(attempts,delays.length-1)],dueAt=new Date(anchor+delayMs).toISOString();
  const detail={attempts,delayMs,dueAt,statusDigest};
  if(current<Date.parse(dueAt))return {allowed:false,reason:'browser_retry_backoff',...detail};
  return {allowed:true,reason:'browser_retry_due',...detail,nextRecord:{version:1,
    failureCode:'browser_unavailable',statusDigest,statusCheckedAt:status.checkedAt,
    attempts:attempts+1,issuedAt:new Date(current).toISOString()}};
}
