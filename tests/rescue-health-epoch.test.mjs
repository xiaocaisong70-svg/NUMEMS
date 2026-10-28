import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {markRuntimeHealthy} from '../scripts/agentless/health-cycle.mjs';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {prepareFaultRescue,faultRescueFile} from '../scripts/agentless/fault-rescue.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';
import {AgentlessBrowser,isDedicatedObservation} from '../scripts/agentless/browser.mjs';
import {recordReadOnlyHealth} from '../scripts/agentless/admin.mjs';

const base=Date.parse('2026-10-28T15:00:00Z'),at=ms=>new Date(base+ms).toISOString();
const config=validateConfig({liveActions:true,faultRescue:{enabled:true,scope:'read_only_reconcile',threadId:'thread-fixture',timeoutSeconds:300}});
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-rescue-health-'));
  t.after(async()=>{const rel=path.relative(os.tmpdir(),directory);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await rm(directory,{recursive:true,force:true});});
  const retry=path.join(directory,'browser-retry.json');
  const old={version:2,state:'healthy',healthyAt:at(20000),officialObservedAt:at(19000),workspaceId:config.workspaceId,
    administrator:config.adminEmail,retiredAttempts:6,previousIssuedAt:at(10000),previousStatusDigest:'a'.repeat(64),previousStatusCheckedAt:at(0),
    legacyRetryRecord:{version:1,failureCode:'browser_unavailable',attempts:6,issuedAt:at(10000),statusCheckedAt:at(0),statusDigest:'a'.repeat(64)}};
  const rescue={version:1,phase:'finished',agentStopped:true,outcome:'unresolved',failureId:'codex_failure_one',
    clientId:'numems-fault:client-one',threadId:'thread-fixture',createdAt:at(30000),updatedAt:at(40000),
    ticket:{id:'rescue_0123456789abcdef0123456789abcdef',failureId:'codex_failure_one',token:'fixture-only-protected-token',
      phase:'pending',scope:'read_only_reconcile'}};
  const snapshot={complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,accountEmail:config.adminEmail,
    totalSeats:config.totalSeats,seatLabel:config.seatLabel,observedAt:at(50000),pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`,
    members:[{email:config.adminEmail,role:'owner',seatLabel:config.seatLabel}],invites:[]};
  const plan={enabled:true,testOnly:false,workspaceId:config.workspaceId,administrator:config.adminEmail,busy:false,lease:null,
    lastError:null,globalFailureCode:null,blockedOperations:[],mailChannelError:null,officialObservedAt:snapshot.observedAt,checkedAt:at(51000),
    faultRescue:{id:rescue.ticket.id,failureId:rescue.failureId,phase:'finished',outcome:'unresolved',scope:'read_only_reconcile',createdAt:at(31000),updatedAt:at(41000)}};
  await atomicJson(retry,old);await atomicJson(faultRescueFile(directory),rescue);
  const args={directory,config,plan,snapshot,journalState:{phase:'settled'},clock:()=>new Date(at(52000))};
  return {directory,retry,old,rescue,plan,snapshot,args};
}

test('a closed newer rescue plus full healthy round trip rotates an unconsumed old epoch once',async t=>{
  const f=await fixture(t),first=await markRuntimeHealthy(f.args),marker=await readJson(f.retry);
  assert.equal(first.backoffReset,true);assert.equal(first.healthEpochRotated,true);
  assert.equal(marker.healthyAt,at(52000));assert.equal(marker.officialObservedAt,at(50000));
  assert.deepEqual(marker.legacyRetryRecord,f.old.legacyRetryRecord);assert.equal(marker.retiredAttempts,6);
  assert.deepEqual(marker.faultRescueHealth,{rescueId:f.rescue.ticket.id,failureId:f.rescue.failureId,createdAt:at(30000),finishedAt:at(40000)});
  assert.doesNotMatch(await readFile(f.retry,'utf8'),/protected-token|token/);
  const bytes=await readFile(f.retry,'utf8');
  f.snapshot.observedAt=at(70000);f.plan.officialObservedAt=f.snapshot.observedAt;f.plan.checkedAt=at(71000);
  const again=await markRuntimeHealthy({...f.args,clock:()=>new Date(at(72000))});
  assert.equal(again.backoffReset,false);assert.equal(again.healthEpochRotated,false);assert.equal(await readFile(f.retry,'utf8'),bytes);
});

test('a ticket alone, stale/missing official evidence or an ongoing fault cannot rotate health',async t=>{
  for(const change of [f=>{f.args.snapshot=null;},f=>{f.plan.globalFailureCode='browser_unavailable';f.plan.lastError='still blocked';},
    f=>{f.plan.faultRescue.phase='pending';},f=>{f.plan.lease={id:'op_unfinished'};},
    f=>{f.snapshot.observedAt=at(-20000);f.plan.officialObservedAt=f.snapshot.observedAt;},
    f=>{f.plan.officialObservedAt=at(49000);},f=>{f.args.journalState={phase:'attempting'};}]) {
    const f=await fixture(t),before=await readFile(f.retry,'utf8');change(f);
    await assert.rejects(markRuntimeHealthy(f.args));assert.equal(await readFile(f.retry,'utf8'),before);
  }
});

test('unmatched, unclosed or future rescue metadata cannot reset a valid retained health epoch',async t=>{
  for(const change of [f=>{f.rescue.phase='queued';},f=>{f.rescue.agentStopped=false;},f=>{f.plan.faultRescue.id='rescue_ffffffffffffffffffffffffffffffff';},
    f=>{f.plan.faultRescue.failureId='codex_another_failure';},f=>{f.plan.faultRescue.outcome='recovered';},
    f=>{f.rescue.createdAt=at(60000);},f=>{f.rescue.updatedAt=at(60000);},f=>{f.plan.faultRescue.updatedAt=at(60000);},
    f=>{f.rescue.createdAt=at(10000);},f=>{f.rescue.ticket.scope='different_scope';}]) {
    const f=await fixture(t);change(f);await atomicJson(faultRescueFile(f.directory),f.rescue);
    const before=await readFile(f.retry,'utf8'),result=await markRuntimeHealthy(f.args);
    assert.equal(result.backoffReset,false);assert.equal(result.healthEpochRotated,false);assert.equal(await readFile(f.retry,'utf8'),before);
  }
});

test('rotated official health re-arms only a later independent fault, without starting a model',async t=>{
  const f=await fixture(t);await markRuntimeHealthy(f.args);let begins=0;
  const nextPlan={...f.plan,globalFailureCode:'browser_unavailable',globalFailureId:'codex_failure_two',lastError:'new real fault',
    removals:[{id:'req_new_independent',email:'fixture@example.com'}],invites:[],awaitingAcceptance:[]};
  const portal={async call(name,args){if(['seat_portal_status','refresh_seat_queue'].includes(name))return {plan:nextPlan};
    assert.equal(name,'begin_fault_rescue');begins++;assert.equal(args.expectedFailureId,'codex_failure_two');
    return {ticket:{id:'rescue_ffffffffffffffffffffffffffffffff',token:'fixture-protected-new-token',failureId:'codex_failure_two',phase:'pending',scope:'read_only_reconcile'}};}};
  const result=await prepareFaultRescue({directory:f.directory,config,portal,hostSafe:true,journalState:{phase:'settled'},
    clock:()=>new Date(at(80000)),newId:()=> 'client-two'});
  assert.equal(result.state,'prepared');assert.equal(result.modelUsage,'not_requested');assert.equal(begins,1);
  const again=await prepareFaultRescue({directory:f.directory,config,portal,hostSafe:true,journalState:{phase:'settled'},clock:()=>new Date(at(81000))});
  assert.equal(again.state,'prepared');assert.equal(begins,1);
});

test('a second closed independent rescue can rotate again, while the same old ticket cannot',async t=>{
  const f=await fixture(t);await markRuntimeHealthy(f.args);
  Object.assign(f.rescue,{failureId:'codex_failure_two',createdAt:at(70000),updatedAt:at(80000)});
  Object.assign(f.rescue.ticket,{id:'rescue_ffffffffffffffffffffffffffffffff',failureId:f.rescue.failureId});
  Object.assign(f.plan.faultRescue,{id:f.rescue.ticket.id,failureId:f.rescue.failureId,createdAt:at(71000),updatedAt:at(81000)});
  await atomicJson(faultRescueFile(f.directory),f.rescue);
  f.snapshot.observedAt=at(90000);f.plan.officialObservedAt=f.snapshot.observedAt;f.plan.checkedAt=at(91000);
  const result=await markRuntimeHealthy({...f.args,clock:()=>new Date(at(92000))});
  assert.equal(result.healthEpochRotated,true);assert.equal((await readJson(f.retry)).healthyAt,at(92000));
  assert.equal((await readJson(f.retry)).faultRescueHealth.failureId,'codex_failure_two');
});

test('approved execution rescue closure rotates only through the exact dedicated observation object',async t=>{
  const f=await fixture(t);
  f.rescue.scope='approved_member_ops';f.rescue.ticket.scope='approved_member_ops';f.rescue.outcome='handled';
  Object.assign(f.plan.faultRescue,{scope:'approved_member_ops',outcome:'handled'});
  await atomicJson(faultRescueFile(f.directory),f.rescue);
  const reader=new AgentlessBrowser(config);reader.observeStable=async()=>f.snapshot;
  const dedicated=await reader.observe({now:()=>Date.parse(f.snapshot.observedAt),budgetMs:1000});
  assert.equal(dedicated,f.snapshot);assert.equal(isDedicatedObservation(dedicated),true);
  const copy=JSON.parse(JSON.stringify(dedicated));assert.equal(isDedicatedObservation(copy),false);
  const before=await readFile(f.retry,'utf8');
  await assert.rejects(markRuntimeHealthy({...f.args,snapshot:copy}),error=>error.healthDiagnostic?.reason==='dedicated_channel_proof_missing');
  assert.equal(await readFile(f.retry,'utf8'),before);
  const result=await markRuntimeHealthy({...f.args,snapshot:dedicated});assert.equal(result.healthEpochRotated,true);
  assert.equal((await readJson(f.retry)).faultRescueHealth.rescueId,f.rescue.ticket.id);
  assert.equal((await markRuntimeHealthy({...f.args,snapshot:dedicated})).healthEpochRotated,false);
});

test('administrator finish health entry preserves dedicated provenance and cannot accept a serialized substitute',async t=>{
  const f=await fixture(t),atNow=new Date().toISOString(),createdAt=new Date(Date.now()-2000).toISOString();
  f.rescue.scope='approved_member_ops';f.rescue.ticket.scope='approved_member_ops';f.rescue.outcome='handled';
  Object.assign(f.rescue,{createdAt,updatedAt:createdAt});
  Object.assign(f.plan.faultRescue,{scope:'approved_member_ops',outcome:'handled',createdAt,updatedAt:createdAt});
  f.snapshot.observedAt=atNow;f.plan.officialObservedAt=atNow;f.plan.checkedAt=atNow;
  await atomicJson(f.retry,{version:2,state:'healthy',healthyAt:new Date(Date.now()-10000).toISOString(),
    officialObservedAt:new Date(Date.now()-11000).toISOString(),workspaceId:config.workspaceId,administrator:config.adminEmail});
  await atomicJson(faultRescueFile(f.directory),f.rescue);
  const reader=new AgentlessBrowser(config);reader.observeStable=async()=>f.snapshot;
  const observed=await reader.observe();
  await recordReadOnlyHealth({directory:f.directory,config,plan:f.plan,snapshot:observed,ticket:f.rescue});
  assert.equal((await readJson(f.retry)).faultRescueHealth.rescueId,f.rescue.ticket.id);
  assert.equal((await readJson(path.join(f.directory,'status.json'))).mode,'idle');
  await assert.rejects(recordReadOnlyHealth({directory:f.directory,config,plan:f.plan,snapshot:structuredClone(observed),ticket:f.rescue}),
    error=>error.healthDiagnostic?.reason==='dedicated_channel_proof_missing');
});
