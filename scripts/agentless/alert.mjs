import {randomUUID,createHash} from 'node:crypto';
import {readJson,atomicJson} from './journal.mjs';

const codes=new Set(['unknown','isolated','member_action','approval_required','mail_delivery',
  'login_expired','workspace_mismatch','capacity_mismatch','role_mismatch','browser_unavailable']);
const fingerprint=(code,key)=>createHash('sha256').update(JSON.stringify([code,key??code])).digest('hex');
const stamp=value=>typeof value==='string' && Number.isFinite(Date.parse(value));
const maximumIncidents=32;
// Both exception handlers use the same opaque scope. Distinct runtime errors
// must not collapse merely because they share the generic 'unknown' code.
export function runtimeIncidentKey(error) {
  return fingerprint(codes.has(error?.failureCode)?error.failureCode:'unknown',
    [String(error?.name??'Error'),String(error?.message??'runtime_failure')]);
}
function incidentsOf(value) {
  if(!value)return [];
  const list=Array.isArray(value.incidents)?value.incidents.map(item=>({...item})):[{...value}];
  // Retain compatibility with the explicit V11 resolve-alert command.
  if(value.resolvedAt)for(const item of list)if(item.id===value.id)item.resolvedAt=value.resolvedAt;
  return list.map(item=>({...item,fingerprint:item.fingerprint??fingerprint(item.code??'unknown')}));
}
async function save(file,incidents,current,extra={}) {
  await atomicJson(file,{...current,version:2,incidents,...extra});
}
function endpoint(env) {
  if(!env.NUMEMS_ALERT_URL)return null;
  const url=new URL(env.NUMEMS_ALERT_URL);
  if(url.protocol!=='https:' || url.username || url.password || url.hash || !env.NUMEMS_ALERT_TOKEN)
    throw new Error('Administrator alert gateway configuration is invalid.');
  return url;
}

/** No chat/Agent fallback or visible notification. Each incident owns a durable delivery ID. */
export async function notifyFailure(file,{code='unknown',detail='执行器已暂停，请检查本机状态和门户租约。',incidentKey},
  {env=process.env,fetcher=fetch,clock=()=>new Date(),newId=randomUUID}={}) {
  code=codes.has(code)?code:'unknown';
  const now=clock(),at=now.toISOString(),key=fingerprint(code,incidentKey);
  const stored=await readJson(file),incidents=incidentsOf(stored);
  let notice=incidents.find(item=>item.fingerprint===key && !item.resolvedAt);
  if(!notice) {
    // Prune only resolved records. An unconfirmed delivery is never discarded
    // and later recreated with a different ID, even during an incident storm.
    while(incidents.length>=maximumIncidents) {
      const resolved=incidents.findIndex(item=>item.resolvedAt);
      if(resolved<0) {
        const previous=stored?.overflow;
        await save(file,incidents,stored,{overflow:{at,reason:'unresolved_alert_capacity',code,fingerprint:key,
          count:Math.min(Number.MAX_SAFE_INTEGER,(Number.isSafeInteger(previous?.count)?previous.count:0)+1)}});
        return {state:'store_full',id:null};
      }
      incidents.splice(resolved,1);
    }
    notice={id:newId(),fingerprint:key,code,detail:String(detail).slice(0,512),createdAt:at,
      delivery:'local_only',attempts:0};
    incidents.push(notice);await save(file,incidents,notice);
  }
  return deliverNotice(file,incidents,notice,{env,fetcher,clock});
}

async function deliverNotice(file,incidents,notice,{env=process.env,fetcher=fetch,clock=()=>new Date()}={}) {
  if(notice.resolvedAt)return {state:'resolved',id:notice.id};
  if(notice.delivery==='accepted')return {state:'accepted',id:notice.id};
  const now=clock(),at=now.toISOString();
  let url;
  try {url=endpoint(env);} catch {
    if(!notice.configurationError) {
      notice.configurationError=true;notice.deliveryBeforeConfigurationError=notice.delivery;
      notice.delivery='configuration_error';await save(file,incidents,notice);
    }
    return {state:'configuration_error',id:notice.id};
  }
  if(notice.delivery==='configuration_error') {
    // Fixing gateway configuration cannot downgrade an ambiguous prior send to
    // prepared/local-only and thereby accidentally authorize a duplicate POST.
    notice.delivery=notice.deliveryBeforeConfigurationError??'local_only';
    delete notice.configurationError;delete notice.deliveryBeforeConfigurationError;
    await save(file,incidents,notice);
  }
  if(!url)return {state:notice.delivery,id:notice.id};
  // A crash in attempting has the same uncertainty as a transport timeout.
  // Repeated POST is opt-in and requires a gateway that durably deduplicates
  // Idempotency-Key. Ordinary gateways preserve the V11 no-resend rule.
  if(['attempting','uncertain'].includes(notice.delivery)) {
    if(env.NUMEMS_ALERT_IDEMPOTENT_RETRY!=='true')return {state:'uncertain',id:notice.id};
    if((notice.attempts??1)>=6 || !stamp(notice.nextAttemptAt) || now.getTime()<Date.parse(notice.nextAttemptAt))
      return {state:'uncertain',id:notice.id};
  }
  delete notice.configurationError;
  notice.delivery='attempting';notice.attempts=(notice.attempts??0)+1;notice.lastAttemptAt=at;
  const delay=Math.min(30*60_000,60_000*2**Math.min(notice.attempts-1,5));
  notice.nextAttemptAt=new Date(now.getTime()+delay).toISOString();
  await save(file,incidents,notice);
  try {
    const response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.NUMEMS_ALERT_TOKEN}`,
        'Idempotency-Key':notice.id},body:JSON.stringify({id:notice.id,code:notice.code,
          detail:notice.detail,createdAt:notice.createdAt})});
    if(!response.ok)throw new Error('Alert HTTP receipt missing.');
    notice.delivery='accepted';notice.acceptedAt=clock().toISOString();
    delete notice.nextAttemptAt;
  } catch {notice.delivery='uncertain';}
  await save(file,incidents,notice);
  return {state:notice.delivery,id:notice.id};
}

// Retry the durable outbox without inventing a new incident or waking an Agent.
// The worker already owns the runtime lock; all attempts retain their original IDs.
export async function flushFailureAlerts(file,options={}) {
  const stored=await readJson(file);if(!stored)return [];
  const incidents=incidentsOf(stored),results=[];
  for(const notice of incidents)if(!notice.resolvedAt && notice.delivery!=='accepted')
    results.push(await deliverNotice(file,incidents,notice,options));
  return results;
}

// Call only through the verified health-cycle guard, never for an idle heartbeat.
export async function resolveFailureAlerts(file,{healthyAt,officialObservedAt}) {
  const stored=await readJson(file);if(!stored)return {resolved:0};
  const incidents=incidentsOf(stored);let resolved=0;
  for(const item of incidents)if(!item.resolvedAt && stamp(item.createdAt) &&
      Date.parse(item.createdAt)<=Date.parse(officialObservedAt)) {
    item.resolvedAt=healthyAt;item.resolution='official_health_verified';resolved++;
  }
  const current=incidents.find(item=>item.id===stored.id)??incidents.at(-1);
  if(resolved && current)await save(file,incidents,current);
  return {resolved};
}
