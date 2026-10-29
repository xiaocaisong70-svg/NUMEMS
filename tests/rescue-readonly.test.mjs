import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {localRecoveryOwned,cloudRecoveryOwned} from '../scripts/agentless/recovery-fence.mjs';
import {reconcileRescueReadOnly} from '../scripts/agentless/rescue-readonly.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';
import {runBatch} from '../scripts/agentless/core.mjs';
import {diagnoseHealthEvidence} from '../scripts/agentless/health-cycle.mjs';
import {localContextRecoveryEligible} from '../scripts/agentless/main.mjs';
import {recordReadOnlyHealth} from '../scripts/agentless/admin.mjs';
import {completedRescueProof} from './helpers/completed-rescue-proof.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-rescue-readonly-'));
  t.after(async()=>{const r=path.relative(os.tmpdir(),dir);assert.ok(r&&!r.startsWith('..')&&!path.isAbsolute(r));await rm(dir,{recursive:true,force:true});});
  const file=path.join(dir,'operation.json'),config=validateConfig({liveActions:true,legacyCheckerDisabled:true});
  const at=new Date().toISOString();
  const snapshot={complete:true,workspaceId:config.workspaceId,accountEmail:config.adminEmail,totalSeats:4,
    observedAt:at,pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`,
    members:[{email:config.adminEmail,role:'owner'}],invites:[]};
  let p={enabled:true,testOnly:false,workspaceId:config.workspaceId,administrator:config.adminEmail,busy:false,
    lease:null,lastError:'temporary',globalFailureCode:'browser_unavailable',globalFailureId:'failure_one',blockedOperations:[]};
  const calls=[],ticket={ticket:{id:'rescue_1234567890abcdef'},failureId:'failure_one'};
  const portal={async call(name,args){calls.push({name,args});
    if(name==='review_seat_failure'){p={...p,globalFailureCode:null,lastError:null,officialObservedAt:args.observation.observedAt};}
    if(name==='observe_workspace')p={...p,officialObservedAt:args.observation.observedAt};
    if(name==='complete_seat_operation'){p={...p,busy:false,lease:null,globalFailureCode:null,lastError:null};}
    return {plan:p};}};
  const browser={async observe(){return snapshot;},async invite(){assert.fail('no invitation');},async remove(){assert.fail('no removal');}};
  return {file,dir,config,snapshot,calls,ticket,portal,browser,get plan(){return p;},set plan(v){p=v;},
    run:()=>reconcileRescueReadOnly({portal,browser,config,journalFile:file,ticket})};
}

test('an active cloud rescue blocks every normal batch before any official or member action',async t=>{
  const f=await fixture(t);f.plan={...f.plan,faultRescue:{id:f.ticket.ticket.id,phase:'pending'}};
  f.browser.observe=async()=>assert.fail('normal worker must not enter owned browser');
  const result=await runBatch({portal:f.portal,browser:f.browser,config:f.config});
  assert.equal(result.mode,'fault_rescue_pending');assert.equal(result.modelCalls,0);
  assert.deepEqual(f.calls.map(c=>c.name),['seat_portal_status']);
});
test('local unresolved dispatch fences startup; only a genuinely finished diagnostic permits routine preflight',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'fault-rescue.json');
  assert.equal(await localRecoveryOwned(file),false);
  for(const phase of ['prepared','sending','queued','uncertain','finishing']){
    await atomicJson(file,{version:1,phase});assert.equal(await localRecoveryOwned(file),true);
  }
  const closed={version:1,phase:'finished',agentStopped:true,outcome:'unresolved',ticket:{id:'rescue_1234567890abcdef'},
    failureId:'fault-fixture',clientId:'client-fixture',threadId:'thread-fixture',createdAt:f.snapshot.observedAt};
  await atomicJson(file,{...closed,agentProof:completedRescueProof(closed)});
  assert.equal(await localRecoveryOwned(file),false);
  assert.equal(cloudRecoveryOwned({faultRescue:{phase:'uncertain'}}),true);
});
test('fresh official read can recover only the same paused incident without a new claim',async t=>{
  const f=await fixture(t);f.plan={...f.plan,faultRescue:{id:f.ticket.ticket.id,failureId:f.ticket.failureId,phase:'pending'}};
  assert.equal((await f.run()).healthy,true);
  assert.equal(f.calls.filter(c=>c.name==='review_seat_failure').length,1);
  assert.ok(f.calls.every(c=>!['claim_seat_operation','defer_seat_operation'].includes(c.name)));
});
test('a newer global incident is never cleared by an old rescue',async t=>{
  const f=await fixture(t);f.plan={...f.plan,globalFailureId:'failure_new'};
  await assert.rejects(f.run(),/更新的故障/);
  assert.equal(f.calls.some(c=>c.name==='review_seat_failure'),false);
});
test('unknown or capacity failures cannot be downgraded to a generic security check',async t=>{
  const f=await fixture(t);
  for(const code of ['unknown','capacity_mismatch','role_mismatch']){
    f.plan={...f.plan,globalFailureCode:code};await assert.rejects(f.run(),/不能.*降级|不可降级/);
  }
  assert.equal(f.calls.some(c=>c.name==='review_seat_failure'),false);
});
test('a restored login requires a fresh official snapshot and a failure-ID-bound login-only review',async t=>{
  const f=await fixture(t);f.plan={...f.plan,globalFailureCode:'login_expired'};
  assert.equal((await f.run()).healthy,true);
  const review=f.calls.find(c=>c.name==='review_seat_failure');
  assert.equal(review.args.decision,'recover_login');assert.equal(review.args.expectedFailureId,'failure_one');
  assert.equal(review.args.observation.observedAt,f.snapshot.observedAt);
});
test('an exact original removal lease can settle only after official absence; no side effect is repeated',async t=>{
  const f=await fixture(t),lease={id:'op_original',token:'lease-secret',kind:'remove',targetId:'req_one',email:'staff@example.com',status:'uncertain'};
  f.plan={...f.plan,busy:true,lease,globalFailureCode:'unknown'};f.ticket.originalOperationId=lease.id;
  await atomicJson(f.file,{phase:'attempting',lease});
  assert.equal((await f.run()).healthy,true);
  assert.equal((await readJson(f.file)).phase,'settled');
  const complete=f.calls.filter(c=>c.name==='complete_seat_operation');assert.equal(complete.length,1);
  assert.equal(complete[0].args.operationId,lease.id);assert.equal(complete[0].args.token,lease.token);
});
test('a still-present member keeps the uncertain original removal lease untouched',async t=>{
  const f=await fixture(t),lease={id:'op_original',token:'lease-secret',kind:'remove',targetId:'req_one',email:'staff@example.com',status:'uncertain'};
  f.plan={...f.plan,busy:true,lease,globalFailureCode:'unknown'};f.ticket.originalOperationId=lease.id;
  f.snapshot.members.push({email:lease.email,role:'member'});await atomicJson(f.file,{phase:'attempting',lease});
  await assert.rejects(f.run(),/保留原租约/);
  assert.equal((await readJson(f.file)).phase,'attempting');assert.equal(f.calls.some(c=>c.name==='complete_seat_operation'),false);
});
test('a cleared global fault alone cannot create a healthy epoch while a rescue owns recovery',async t=>{
  const f=await fixture(t),now=new Date().toISOString();
  const d=diagnoseHealthEvidence({config:f.config,plan:{...f.plan,globalFailureCode:null,lastError:null,
    faultRescue:{phase:'pending'},checkedAt:now,officialObservedAt:f.snapshot.observedAt},snapshot:f.snapshot,
    journalState:{phase:'settled'},checkedAt:now});
  assert.equal(d.valid,false);assert.equal(d.reason,'fault_rescue_unsettled');
});
test('closed-context recovery is strictly a local pre-claim read path, never a result-unknown downgrade',()=>{
  const error=new Error('page.evaluate: Target page, context or browser has been closed');
  assert.equal(localContextRecoveryEligible(error,{phase:'settled'}),true);
  assert.equal(localContextRecoveryEligible(error,null),false);
  for(const phase of ['claiming','claimed','attempting','completing'])
    assert.equal(localContextRecoveryEligible(error,{phase}),false);
  assert.equal(localContextRecoveryEligible(error,{phase:'settled',lease:{id:'original'}}),false);
  assert.equal(localContextRecoveryEligible(new Error('unknown'),{phase:'settled'}),false);
});
test('a verified empty runtime gets an explicit settled marker and clean health status for the restart gate',async t=>{
  const f=await fixture(t),now=new Date().toISOString();
  Object.assign(f.snapshot,{workspaceName:f.config.workspaceName,seatLabel:f.config.seatLabel});
  f.snapshot.members[0].seatLabel=f.config.seatLabel;
  const plan={...f.plan,globalFailureCode:null,lastError:null,checkedAt:now,
    officialObservedAt:f.snapshot.observedAt,mailChannelError:null};
  await recordReadOnlyHealth({directory:f.dir,config:f.config,plan,snapshot:f.snapshot,ticket:f.ticket});
  assert.equal((await readJson(f.file)).phase,'settled');
  const status=await readJson(path.join(f.dir,'status.json'));assert.equal(status.mode,'idle');
  assert.equal(status.faultRescueEvidence.rescueId,f.ticket.ticket.id);
  assert.equal((await readJson(path.join(f.dir,'browser-retry.json'))).state,'healthy');
});
test('an active diagnostic ownership cannot seed an empty journal or reset health during recovery',async t=>{
  const f=await fixture(t),now=new Date().toISOString();
  const plan={...f.plan,globalFailureCode:null,lastError:null,checkedAt:now,faultRescue:{phase:'pending'}};
  await assert.rejects(recordReadOnlyHealth({directory:f.dir,config:f.config,plan,snapshot:f.snapshot}),/fault_rescue_unsettled/);
  assert.equal(await readJson(f.file),null);
  assert.equal(await readJson(path.join(f.dir,'status.json')),null);
});
