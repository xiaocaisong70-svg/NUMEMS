import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {notifyFailure,flushFailureAlerts} from '../scripts/agentless/alert.mjs';
import {verifiedHealthEvidence,markRuntimeHealthy,diagnoseHealthEvidence,HEALTH_CLOCK_SKEW_MS} from '../scripts/agentless/health-cycle.mjs';
import {browserRetryDecision,browserFailureDigest} from '../scripts/agentless/browser-retry-policy.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';

const baseTime=Date.parse('2026-10-28T07:00:00Z'),at=ms=>new Date(baseTime+ms).toISOString();
const config=validateConfig({liveActions:true});
function healthy() {
  const snapshot={complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,
    accountEmail:config.adminEmail,totalSeats:config.totalSeats,seatLabel:config.seatLabel,
    observedAt:at(20_000),pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`,
    members:[{email:config.adminEmail,role:'owner',seatLabel:config.seatLabel}],invites:[]};
  return {config,snapshot,plan:{enabled:true,testOnly:false,workspaceId:config.workspaceId,
    administrator:config.adminEmail,busy:false,lease:null,lastError:null,globalFailureCode:null,
    blockedOperations:[],mailChannelError:null,officialObservedAt:snapshot.observedAt,checkedAt:at(21_000)},
    journalState:{phase:'settled'},checkedAt:at(22_000)};
}
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-v12-alert-'));
  t.after(async()=>{
    const relative=path.relative(os.tmpdir(),directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    await rm(directory,{recursive:true,force:true});
  });
  return {directory,file:path.join(directory,'alert.json')};
}
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const gateway={NUMEMS_ALERT_URL:'https://example.test/alerts',NUMEMS_ALERT_TOKEN:'fixture-only'};

test('a different incident is persisted despite an unresolved old unknown alert; same incident deduplicates',async t=>{
  const {file}=await fixture(t);let id=0,sends=0;
  const options={env:gateway,clock:()=>new Date(baseTime),newId:()=>`notice-${++id}`,fetcher:async()=>{sends++;return {ok:true};}};
  assert.equal((await notifyFailure(file,{code:'unknown'},options)).id,'notice-1');
  assert.equal((await notifyFailure(file,{code:'browser_unavailable'},options)).id,'notice-2');
  assert.equal((await notifyFailure(file,{code:'unknown'},options)).id,'notice-1');
  assert.equal(sends,2);assert.equal((await read(file)).incidents.length,2);
});

test('scope is hashed and differentiates distinct cloud failures without persisting its raw value',async t=>{
  const {file}=await fixture(t);let id=0;
  const options={env:{},clock:()=>new Date(baseTime),newId:()=>`notice-${++id}`};
  await notifyFailure(file,{code:'isolated',incidentKey:'scope-one'},options);
  await notifyFailure(file,{code:'isolated',incidentKey:'scope-two'},options);
  assert.equal((await read(file)).incidents.length,2);
  assert.doesNotMatch(await readFile(file,'utf8'),/scope-one|scope-two/);
});

test('local-only alert can be delivered after gateway configuration using its original ID',async t=>{
  const {file}=await fixture(t);const options={env:{},clock:()=>new Date(baseTime),newId:()=>`prepared`};
  assert.equal((await notifyFailure(file,{code:'unknown'},options)).state,'local_only');
  let seen;
  assert.equal((await notifyFailure(file,{code:'unknown'},{...options,env:gateway,fetcher:async(_url,args)=>{
    seen=args;assert.equal((await read(file)).delivery,'attempting');return {ok:true};}})).state,'accepted');
  assert.equal(seen.headers['Idempotency-Key'],'prepared');assert.equal(JSON.parse(seen.body).id,'prepared');
});

test('ambiguous sends remain uncertain and are not repeated without an explicit idempotent contract',async t=>{
  const {file}=await fixture(t);let sends=0;
  const options={env:gateway,clock:()=>new Date(baseTime),fetcher:async()=>{sends++;throw new Error('lost response');}};
  const first=await notifyFailure(file,{code:'unknown'},options);
  assert.equal(first.state,'uncertain');
  assert.deepEqual(await notifyFailure(file,{code:'unknown'},options),first);assert.equal(sends,1);
});

test('opt-in idempotent retry uses the same delivery ID, waits a cooldown and is bounded to six attempts',async t=>{
  const {file}=await fixture(t);let elapsed=0,sends=0;const ids=[];
  const options={env:{...gateway,NUMEMS_ALERT_IDEMPOTENT_RETRY:'true'},clock:()=>new Date(baseTime+elapsed),
    fetcher:async(_url,args)=>{sends++;ids.push(args.headers['Idempotency-Key']);throw new Error('timeout');}};
  await notifyFailure(file,{code:'unknown'},options);
  await notifyFailure(file,{code:'unknown'},options);assert.equal(sends,1);
  for(let i=1;i<6;i++) {elapsed+=31*60_000;await notifyFailure(file,{code:'unknown'},options);}
  elapsed+=31*60_000;await notifyFailure(file,{code:'unknown'},options);
  assert.equal(sends,6);assert.equal(new Set(ids).size,1);assert.equal((await read(file)).attempts,6);
});

test('invalid gateway is recorded without suppressing the primary failure or leaking the token',async t=>{
  const {file}=await fixture(t);let sends=0;
  const result=await notifyFailure(file,{code:'login_expired'},{env:{NUMEMS_ALERT_URL:'http://example.test',NUMEMS_ALERT_TOKEN:'sensitive'},fetcher:async()=>{sends++;}});
  assert.equal(result.state,'configuration_error');assert.equal(sends,0);
  assert.equal((await read(file)).delivery,'configuration_error');
  assert.doesNotMatch(await readFile(file,'utf8'),/sensitive/);
});

test('unresolved legacy V11 incidents are migrated and do not suppress a distinct failure',async t=>{
  const {file}=await fixture(t);
  await writeFile(file,JSON.stringify({id:'legacy',code:'unknown',createdAt:at(0),delivery:'uncertain'}));
  await notifyFailure(file,{code:'browser_unavailable'},{env:{},clock:()=>new Date(baseTime+1_000)});
  const data=await read(file);assert.equal(data.version,2);assert.equal(data.incidents.length,2);
  assert.equal(data.incidents[0].id,'legacy');assert.equal(data.incidents[0].delivery,'uncertain');
});

test('repairing gateway configuration never turns an uncertain send into permission to resend',async t=>{
  const {file}=await fixture(t);let sends=0;
  const options={env:gateway,clock:()=>new Date(baseTime),fetcher:async()=>{sends++;throw new Error('timeout');}};
  await notifyFailure(file,{code:'unknown'},options);
  assert.equal((await notifyFailure(file,{code:'unknown'},{...options,env:{...gateway,NUMEMS_ALERT_URL:'http://invalid.test'}})).state,'configuration_error');
  assert.equal((await notifyFailure(file,{code:'unknown'},options)).state,'uncertain');
  assert.equal(sends,1);assert.equal((await read(file)).delivery,'uncertain');
});

test('verified health closes old incidents, retires retry attempts and starts the next independent failure at 60 seconds',async t=>{
  const {file,directory}=await fixture(t);const retry=path.join(directory,'browser-retry.json');
  const failed={state:'blocked',failureCode:'browser_unavailable',checkedAt:at(0)};
  await writeFile(retry,JSON.stringify({version:1,failureCode:'browser_unavailable',statusDigest:browserFailureDigest(failed),
    statusCheckedAt:at(0),issuedAt:at(10_000),attempts:6}));
  const old=await notifyFailure(file,{code:'unknown'},{env:{},clock:()=>new Date(baseTime+1_000)});
  const f=healthy();
  const result=await markRuntimeHealthy({...f,directory,clock:()=>new Date(f.checkedAt)});
  assert.equal(result.resolvedAlerts,1);assert.equal(result.backoffReset,true);
  const marker=await read(retry);assert.equal(marker.retiredAttempts,6);assert.equal(marker.state,'healthy');
  const nextStatus={...failed,checkedAt:at(30_000)},host={mode:'run',state:'blocked',checkedAt:at(31_000)};
  const due=browserRetryDecision({status:nextStatus,host,retryRecord:marker,now:baseTime+91_000});
  assert.equal(due.allowed,true);assert.equal(due.delayMs,60_000);assert.equal(due.nextRecord.attempts,1);
  const after=await notifyFailure(file,{code:'unknown'},{env:{},clock:()=>new Date(baseTime+30_000)});
  assert.notEqual(after.id,old.id);
  const again=await markRuntimeHealthy({...f,directory,clock:()=>new Date(f.checkedAt)});
  assert.equal(again.backoffReset,false);assert.equal(again.resolvedAlerts,0);
  assert.equal((await read(file)).resolvedAt,undefined,'a new incident newer than the official observation is not cleared');
});

test('idle-only, stale, unlinked or unsafe evidence cannot resolve any alert or reset retry history',async t=>{
  const {file,directory}=await fixture(t);
  await notifyFailure(file,{code:'unknown'},{env:{},clock:()=>new Date(baseTime)});
  const patches=[{snapshot:null},{plan:{officialObservedAt:null}},{plan:{busy:true}},{plan:{lease:{id:'op_unknown'}}},
    {plan:{lastError:'unknown'}},{plan:{globalFailureCode:'browser_unavailable'}},{plan:{blockedOperations:[{}]}},
    {plan:{mailChannelError:'mail_delivery'}},{plan:{testOnly:true}},{plan:{enabled:false}},
    {journalState:{phase:'claiming'}},{journalState:{phase:'settled',lease:{id:'unfinished'}}},
    {snapshot:{observedAt:at(-90_000)}},{plan:{checkedAt:at(90_000)}},{config:{liveActions:false}}];
  for(const patch of patches) {
    const f=healthy();for(const [key,value] of Object.entries(patch))
      f[key]=value&&typeof value==='object'?{...f[key],...value}:value;
    await assert.rejects(markRuntimeHealthy({...f,directory,clock:()=>new Date(f.checkedAt)}));
  }
  assert.equal((await read(file)).resolvedAt,undefined);
  await assert.rejects(readFile(path.join(directory,'browser-retry.json')),{code:'ENOENT'});
});

test('stale official health cannot retire newer retry evidence',async t=>{
  const {directory}=await fixture(t),file=path.join(directory,'browser-retry.json');
  await writeFile(file,JSON.stringify({version:1,failureCode:'browser_unavailable',statusDigest:'a'.repeat(64),
    statusCheckedAt:at(10_000),issuedAt:at(21_000),attempts:3}));
  const before=await readFile(file,'utf8'),f=healthy();
  await assert.rejects(markRuntimeHealthy({...f,directory,clock:()=>new Date(f.checkedAt)}),/newer/);
  assert.equal(await readFile(file,'utf8'),before);
});

test('invalid or regressed healthy markers cannot enable a browser retry',()=>{
  const marker=verifiedHealthEvidence(healthy()),status={state:'blocked',failureCode:'browser_unavailable',checkedAt:at(30_000)},
    host={mode:'run',state:'blocked',checkedAt:at(31_000)};
  for(const patch of [{healthyAt:at(40_000)},{officialObservedAt:at(80_000)},{state:'idle'},
    {workspaceId:''},{administrator:''}])
    assert.equal(browserRetryDecision({status,host,retryRecord:{...marker,...patch},now:baseTime+100_000}).allowed,false);
});

test('quiet outbox flushing delivers prepared incidents after configuration without creating new IDs',async t=>{
  const {file}=await fixture(t);let id=0,sends=0;const ids=[];
  const local={env:{},clock:()=>new Date(baseTime),newId:()=>`prepared-${++id}`};
  await notifyFailure(file,{code:'unknown'},local);await notifyFailure(file,{code:'browser_unavailable'},local);
  const result=await flushFailureAlerts(file,{env:gateway,clock:()=>new Date(baseTime+1_000),
    fetcher:async(_url,args)=>{sends++;ids.push(args.headers['Idempotency-Key']);return {ok:true};}});
  assert.deepEqual(ids,['prepared-1','prepared-2']);assert.equal(result.length,2);
  assert.deepEqual(await flushFailureAlerts(file,{env:gateway,fetcher:async()=>{sends++;}}),[]);
  assert.equal(sends,2);assert.equal((await read(file)).incidents.length,2);
});

test('the bounded alert outbox preserves all uncertain delivery IDs when full instead of evicting and resending them',async t=>{
  const {file}=await fixture(t);let id=0;
  const options={env:{},clock:()=>new Date(baseTime),newId:()=>`pending-${++id}`};
  for(let i=0;i<32;i++)await notifyFailure(file,{code:'isolated',incidentKey:`target-${i}`},options);
  const before=await read(file);
  const result=await notifyFailure(file,{code:'isolated',incidentKey:'overflow-target'},options);
  assert.equal(result.state,'store_full');const after=await read(file);
  assert.equal(after.incidents.length,32);assert.deepEqual(after.incidents,before.incidents);
  assert.equal(after.overflow.reason,'unresolved_alert_capacity');assert.equal(id,32);
});

test('a server clock up to five seconds ahead does not reject otherwise proven current official health',()=>{
  assert.equal(HEALTH_CLOCK_SKEW_MS,5000);
  for(const offset of [1,250,5000]) {
    const f=healthy();f.plan.checkedAt=at(22_000+offset);
    const diagnosis=diagnoseHealthEvidence(f);assert.equal(diagnosis.valid,true);
    assert.equal(diagnosis.planClockOffsetMs,offset);assert.equal(verifiedHealthEvidence(f).state,'healthy');
  }
  const excessive=healthy();excessive.plan.checkedAt=at(27_001);
  assert.equal(diagnoseHealthEvidence(excessive).reason,'cloud_clock_ahead');
  assert.throws(()=>verifiedHealthEvidence(excessive),error=>error.code==='HEALTH_EVIDENCE_INVALID'&&
    error.healthDiagnostic.planClockOffsetMs===5001&&error.message.includes('cloud_clock_ahead'));
});

test('bounded server-before-snapshot skew is accepted but stale and more than five-second misordering stay denied',()=>{
  const f=healthy();f.plan.checkedAt=at(15_000);
  assert.equal(diagnoseHealthEvidence(f).planObservationGapMs,-5000);
  assert.equal(verifiedHealthEvidence(f).state,'healthy');
  f.plan.checkedAt=at(14_999);assert.equal(diagnoseHealthEvidence(f).reason,'cloud_predates_official');
  const stale=healthy();stale.plan.checkedAt=at(-38_001);
  assert.equal(diagnoseHealthEvidence(stale).reason,'cloud_plan_stale');
  const futureOfficial=healthy();futureOfficial.snapshot.observedAt=at(27_001);
  futureOfficial.plan.officialObservedAt=futureOfficial.snapshot.observedAt;futureOfficial.plan.checkedAt=at(27_000);
  assert.equal(diagnoseHealthEvidence(futureOfficial).reason,'local_clock_regressed');
});

test('health failure diagnostics expose fixed reason codes and numeric deltas without identity or provider payload',()=>{
  const cases=[['cloud_operation_unsettled',{lease:{token:'do-not-print'}}],
    ['cloud_failure_present',{lastError:'private-provider-text'}],['cloud_holds_present',{blockedOperations:[{secret:'hidden'}]}],
    ['mail_failure_present',{mailChannelError:'private-mail-text'}],['official_roundtrip_mismatch',{officialObservedAt:at(0)}]];
  for(const [reason,patch]of cases) {
    const f=healthy();Object.assign(f.plan,patch);
    assert.throws(()=>verifiedHealthEvidence(f),error=>{
      assert.equal(error.healthDiagnostic.reason,reason);
      const output=JSON.stringify({message:error.message,diagnostic:error.healthDiagnostic});
      assert.doesNotMatch(output,/do-not-print|private-provider-text|hidden|private-mail-text|@|https?:/);
      return true;
    });
  }
});

test('a local official snapshot even one millisecond in the future never persists a self-invalid healthy marker',async t=>{
  const {directory}=await fixture(t),f=healthy();
  f.snapshot.observedAt=at(22_001);f.plan.officialObservedAt=f.snapshot.observedAt;f.plan.checkedAt=at(22_001);
  assert.equal(diagnoseHealthEvidence(f).reason,'local_clock_regressed');
  await assert.rejects(markRuntimeHealthy({...f,directory,clock:()=>new Date(f.checkedAt)}),error=>
    error.healthDiagnostic.reason==='local_clock_regressed'&&error.healthDiagnostic.snapshotClockOffsetMs===1);
  await assert.rejects(readFile(path.join(directory,'browser-retry.json')),{code:'ENOENT'});
});

