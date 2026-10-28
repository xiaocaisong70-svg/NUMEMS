import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {prepareFaultRescue,dispatchPreparedFaultRescue,settleFaultRescue,settleUndispatchedFaultRescue,
  faultRescueFile,faultRescueGate,faultRescuePrompt} from '../scripts/agentless/fault-rescue.mjs';
import {readFaultRescueContext,recordRescueSubmission} from '../scripts/agentless/fault-rescue-context.mjs';
import {superviseFaultRescue} from '../scripts/agentless/watchdog.mjs';
import {readJson,atomicJson} from '../scripts/agentless/journal.mjs';
import {localRecoveryOwned} from '../scripts/agentless/recovery-fence.mjs';
import {PortalClient,PortalOperationRejected} from '../scripts/seat-executor/portal-client.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';
const base=Date.parse('2026-10-28T10:00:00Z'),iso=n=>new Date(base+n).toISOString();
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-v14-broker-'));
  t.after(async()=>{const rel=path.relative(os.tmpdir(),directory);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await rm(directory,{recursive:true,force:true});});
  let ms=base,sequence=0,wakes=0,finishes=0,ticket=null;const calls=[];
  const config={adminEmail:'owner@example.test',workspaceId:'workspace-fixture',siteUrl:'https://portal.example.test/',
    liveActions:true,legacyCheckerDisabled:true,browserMode:'isolated_desktop',headless:false,
    faultRescue:{enabled:true,scope:'approved_member_ops',threadId:'thread-fixture',timeoutSeconds:300}};
  const job={id:'req_one',email:'person@example.test',status:'pending_removal',updatedAt:iso(0)};
  const plan={workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,testOnly:false,
    globalFailureCode:'browser_unavailable',globalFailureId:'failure-fixture',busy:false,lease:null,blockedOperations:[],
    removals:[job],invites:[],awaitingAcceptance:[],memberRescue:{canBegin:true,reason:'available'}};
  const clock=()=>new Date(ms);
  const portal={async call(name,args){
    calls.push([name,args]);
    if(name==='refresh_seat_queue')return{mailMode:'in_app'};
    if(name==='seat_portal_status')return{plan};
    if(name==='fault_rescue_status')return{plan,ticket:ticket?{...ticket,token:undefined}:null};
    if(name==='begin_fault_rescue') {
      if(!ticket||ticket.clientId!==args.clientId||ticket.scope!==args.scope) {
        ticket={id:'rescue_fixture_1234567890123456_'+calls.filter(x=>x[0]===name).length,
          token:'fixture-secret-never-print',failureId:args.expectedFailureId,scope:args.scope,phase:'pending',
          createdAt:clock().toISOString(),updatedAt:clock().toISOString(),...(args.clientId?{clientId:args.clientId}:{}),
          ...(args.scope==='approved_member_ops'?{expiresAt:new Date(ms+300_000).toISOString(),
            targets:[{kind:'remove',targetId:job.id,email:job.email,requestUpdatedAt:job.updatedAt}]}:{})};
        plan.faultRescue={...ticket,token:undefined};
      }
      return{ticket:{...ticket},plan};
    }
    if(name==='finish_fault_rescue') {
      finishes++;assert.equal(args.token,ticket.token);ticket={...ticket,phase:args.outcome==='uncertain'?'uncertain':'finished',outcome:args.outcome};
      plan.faultRescue={...ticket,token:undefined};return{ticket:plan.faultRescue,plan};
    }
    throw new Error('Unexpected operation '+name);
  }};
  const client={async enqueue(threadId,clientId,prompt){wakes++;assert.ok(!prompt.includes(ticket.token));return{queuedSubmission:{id:'queue-'+wakes}};},
    async observeTurnState(identity){return{kind:'codex_turn_state',source:'app_server_thread_read',confirmed:true,stopped:true,
      ...identity,turnId:'turn-fixture',linkedTurnId:'turn-fixture',status:'completed',observedAt:clock().toISOString()};}};
  const args={directory,config,portal,hostSafe:true,journalState:{phase:'settled'},clock,newId:()=> 'uuid-'+(++sequence)};
  return {directory,config,plan,portal,client,args,calls,clock,advance(n){ms+=n;},get ticket(){return ticket;},
    get counts(){return {wakes,finishes,begins:calls.filter(x=>x[0]==='begin_fault_rescue').length};},
    prepare:()=>prepareFaultRescue(args),dispatch:()=>dispatchPreparedFaultRescue({directory,client,hostSafe:true,clock,projectRoot:path.resolve('fixture-project')}),
    settle:extra=>settleFaultRescue({directory,client,portal,hostSafe:true,clock,...extra})};
}
test('V14 refreshes deterministic queue before status, freezes capability and sends only redacted metadata',async t=>{
  const f=await fixture(t);const prepared=await f.prepare();assert.equal(prepared.scope,'approved_member_ops');
  assert.deepEqual(f.calls.slice(0,2).map(x=>x[0]),['refresh_seat_queue','seat_portal_status']);
  const record=await readJson(faultRescueFile(f.directory));assert.equal(f.calls[2][1].clientId,record.clientId);
  const prompt=faultRescuePrompt(record,path.resolve('fixture-project'));
  for(const fragment of ['claim_rescue_operation','authorize_rescue_action','observation.observedAt >= lease.claimedAt','--credential','store(','functions.exec','not_started','handled'])assert.ok(prompt.includes(fragment));
  for(const secret of [f.ticket.token,f.ticket.targets[0].email])assert.ok(!prompt.includes(secret));
  await f.dispatch();assert.equal(f.counts.wakes,1);
});
test('no valid member work or only mail never requests a ticket or model',async t=>{
  const f=await fixture(t);f.plan.removals=[];f.plan.reminders=[{id:'mail-one'}];
  assert.equal((await f.prepare()).reason,'no_valid_pending_work');assert.equal(f.counts.begins,0);assert.equal(f.counts.wakes,0);
});
test('known server quota suppression happens before a new local ownership intent',async t=>{
  const f=await fixture(t);f.plan.memberRescue={canBegin:false,reason:'daily_limit'};
  assert.equal((await f.prepare()).state,'suppressed');assert.equal(await readJson(faultRescueFile(f.directory)),null);assert.equal(f.counts.begins,0);
});
test('finished read-only same-failure ticket can explicitly upgrade once to execution',async t=>{
  const f=await fixture(t);f.config.faultRescue.scope='read_only_reconcile';await f.prepare();await f.dispatch();await f.settle({verifiedRecovery:false});
  f.config.faultRescue.scope='approved_member_ops';const next=await f.prepare();assert.equal(next.scope,'approved_member_ops');
  const r=await readJson(faultRescueFile(f.directory));assert.equal(r.history[0].scope,'read_only_reconcile');assert.equal(f.counts.begins,2);
});
test('continuous failure allows at most two execution tickets locally and each enqueue remains once-only',async t=>{
  const f=await fixture(t);for(let i=0;i<2;i++){await f.prepare();await f.dispatch();await f.settle({verifiedHandled:true});}
  await f.prepare();await f.dispatch();assert.equal(f.counts.begins,2);assert.equal(f.counts.wakes,2);
});
test('transport ambiguity retrieves the same client receipt and never creates a second intent',async t=>{
  const f=await fixture(t),call=f.portal.call.bind(f.portal);let fail=true;
  f.portal.call=async(name,args)=>{const result=await call(name,args);if(name==='begin_fault_rescue'&&fail){fail=false;throw new Error('response lost');}return result;};
  assert.equal((await f.prepare()).state,'uncertain');const original=f.ticket.id;
  assert.equal((await f.prepare()).state,'prepared');assert.equal(f.ticket.id,original);assert.equal(f.counts.wakes,0);
  assert.equal(new Set(f.calls.filter(x=>x[0]==='begin_fault_rescue').map(x=>x[1].clientId)).size,1);
});
test('explicit CAS cancellation followed by matching fresh status ends only the undispatched local intent',async t=>{
  const f=await fixture(t),call=f.portal.call.bind(f.portal);
  f.portal.call=async(name,args)=>{if(name==='begin_fault_rescue'){f.plan.removals=[];throw new PortalOperationRejected(name);}return call(name,args);};
  const result=await f.prepare();assert.equal(result.reason,'server_refused_begin');
  const r=await readJson(faultRescueFile(f.directory));assert.equal(r.notDispatched,true);assert.equal(r.agentStopped,true);
  assert.equal(faultRescueGate(r).allowWorker,true);assert.equal(await localRecoveryOwned(faultRescueFile(f.directory)),false);assert.equal(f.counts.wakes,0);
});
test('explicit rejection cannot release intent on wrong workspace or a matching new cloud ticket',async t=>{
  for(const mismatch of ['workspace','new-client']) {
    const f=await fixture(t),call=f.portal.call.bind(f.portal);
    f.portal.call=async(name,args)=>{
      if(name==='begin_fault_rescue') {
        if(mismatch==='new-client')await call(name,args);
        if(mismatch==='workspace')f.plan.workspaceId='other-workspace';
        throw new PortalOperationRejected(name);
      }
      return call(name,args);
    };
    assert.equal((await f.prepare()).state,'uncertain');assert.equal(faultRescueGate(await readJson(faultRescueFile(f.directory))).allowWorker,false);
  }
});
test('execution deadline starts at server creation, including queue time, with no model reset',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();f.advance(301_000);
  const r=await readJson(faultRescueFile(f.directory));f.client.observeTurnState=async identity=>({kind:'codex_turn_state',source:'app_server_thread_read',
    confirmed:true,stopped:false,...identity,turnId:'turn-fixture',linkedTurnId:'turn-fixture',status:'inProgress',
    startedAt:iso(299_000),observedAt:f.clock().toISOString(),exclusiveTurn:false});
  assert.equal((await f.settle()).reason,'agent_deadline_expired_stop_unconfirmed');assert.equal(f.counts.finishes,0);
  assert.equal(faultRescueGate(await readJson(faultRescueFile(f.directory))).allowWorker,false);assert.equal(r.ticket.expiresAt,iso(300_000));
});
test('expired before enqueue can be atomically cancelled without pretending a model ran',async t=>{
  const f=await fixture(t);await f.prepare();f.advance(300_001);
  assert.equal((await f.dispatch()).reason,'ticket_expired_before_dispatch');assert.equal(f.counts.wakes,0);
  const result=await settleUndispatchedFaultRescue({directory:f.directory,portal:f.portal,hostSafe:true,clock:f.clock});
  assert.equal(result.state,'finished');const r=await readJson(faultRescueFile(f.directory));assert.equal(r.agentProof.kind,'not_dispatched');
  await f.dispatch();assert.equal(f.counts.wakes,0);
});
test('handled requires independent server settlement and cannot upgrade a read-only ticket',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();assert.equal((await f.settle({verifiedHandled:true})).outcome,'handled');
  const g=await fixture(t);g.config.faultRescue.scope='read_only_reconcile';await g.prepare();await g.dispatch();assert.equal((await g.settle({verifiedHandled:true})).outcome,'unresolved');
});
const safeHost={mode:'admin',adminCommand:'prepare-fault-rescue',state:'exited',exitCode:0,processId:1234,checkedAt:iso(0),modelCalls:0,audits:2,
  desktop:'NUMEMS-Agentless-fixture',inputDesktop:'Default',maxOwnedWindowsOnInputDesktop:0,
  windowAudit:{isolated:true,desktop:'NUMEMS-Agentless-fixture',inputDesktop:'Default',ownedWindowsOnInputDesktop:0}};
async function credentialFixture(t) {
  const f=await fixture(t);await f.prepare();await f.dispatch();await atomicJson(path.join(f.directory,'host-desktop.json'),safeHost);
  await atomicJson(path.join(f.directory,'operation.json'),{phase:'settled'});
  return {f,args:{directory:f.directory,config:f.config,rescueId:f.ticket.id,clock:f.clock,
    signal:()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});},inspect:async()=>null}};
}
test('credential handoff defaults to redacted and explicitly verifies actual process death',async t=>{
  const {f,args}=await credentialFixture(t);const safe=await readFaultRescueContext(args);assert.ok(!JSON.stringify(safe).includes(f.ticket.token));
  const secret=await readFaultRescueContext({...args,credential:true});assert.equal(secret.credential.token,f.ticket.token);assert.equal(secret.cloudStatusRequired,true);assert.equal(secret.workerStopped,true);
  await assert.rejects(readFaultRescueContext({...args,credential:true,signal:()=>{}}));
});
test('expired capability, retained submission and a foreign rescue never export credentials',async t=>{
  const {f,args}=await credentialFixture(t);await atomicJson(path.join(f.directory,'operation.json'),{phase:'settled',submission:{kind:'invite'}});
  await assert.rejects(readFaultRescueContext({...args,credential:true}));await atomicJson(path.join(f.directory,'operation.json'),{phase:'settled'});
  await assert.rejects(readFaultRescueContext({...args,credential:true,rescueId:'foreign'}));f.advance(301_000);
  assert.equal((await readFaultRescueContext(args)).expired,true);await assert.rejects(readFaultRescueContext({...args,credential:true}));
});
test('execution scope configuration has an exact five-minute budget',()=>{
  const fields={enabled:true,scope:'approved_member_ops',threadId:'thread-fixture',timeoutSeconds:300};
  assert.equal(validateConfig({faultRescue:fields}).faultRescue.scope,'approved_member_ops');
  assert.throws(()=>validateConfig({faultRescue:{...fields,timeoutSeconds:600}}));
});
test('only matched HTTP-200 begin tool rejection receives the definite-business flag',async()=>{
  const client=new PortalClient(null,{siteUrl:'https://portal.example.test/'},['begin_fault_rescue']);
  let status=200,mismatch=false;client.open=async()=>({evaluate:async(fn,body)=>({status,body:{id:mismatch?999:body.id,
    result:{isError:true,content:[{type:'text',text:'provider-private-secret-body'}]}}})});
  await assert.rejects(client.call('begin_fault_rescue'),e=>e.definitelyRejected===true&&!e.message.includes('provider-private'));
  mismatch=true;await assert.rejects(client.call('begin_fault_rescue'),e=>e.definitelyRejected!==true);
  mismatch=false;status=500;await assert.rejects(client.call('begin_fault_rescue'),e=>e.definitelyRejected!==true);
  status=200;await assert.rejects(client.call('defer_seat_operation'),e=>e.definitelyRejected!==true);
});
test('a lost unsent begin followed by explicit cancellation can release only its local intent',async t=>{
  const f=await fixture(t),call=f.portal.call.bind(f.portal);let first=true;
  f.portal.call=async(name,args)=>{if(name==='begin_fault_rescue'){if(first){first=false;throw new Error('request may not have arrived');}throw new PortalOperationRejected(name);}return call(name,args);};
  assert.equal((await f.prepare()).state,'uncertain');f.plan.removals=[];
  assert.equal((await f.prepare()).reason,'server_refused_begin');assert.equal(f.counts.wakes,0);
});
test('frozen targets invalidated before dispatch are cancelled instead of waking a model for replacement targets',async t=>{
  const f=await fixture(t);await f.prepare();f.plan.removals=[{id:'req_other',email:'other@example.test',updatedAt:iso(1000)}];
  f.plan.memberRescue={canBegin:false,reason:'existing_ticket'};
  assert.equal((await f.prepare()).reason,'pending_work_cancelled');assert.equal((await f.dispatch()).reason,'no_valid_pending_work');assert.equal(f.counts.wakes,0);
  assert.equal((await settleUndispatchedFaultRescue({directory:f.directory,portal:f.portal,hostSafe:true,clock:f.clock})).state,'finished');
});
test('rescue invitation marker is exact, client-bound and immutable after a real send',async t=>{
  const f=await fixture(t);f.plan.removals=[];f.plan.invites=[{id:'req_invite',email:'invite@example.test',updatedAt:iso(0)}];
  const call=f.portal.call.bind(f.portal);f.portal.call=async(name,args)=>{const result=await call(name,args);if(name==='begin_fault_rescue')result.ticket.targets=[{kind:'invite',targetId:'req_invite',email:'invite@example.test',requestUpdatedAt:iso(0),operationId:'op_invite'}];return result;};
  await f.prepare();await f.dispatch();const args={directory:f.directory,rescueId:f.ticket.id,operationId:'op_invite',targetId:'req_invite',invitationSentAt:iso(0),clock:f.clock};
  assert.equal((await recordRescueSubmission(args)).stored,true);f.advance(120_000);assert.equal((await recordRescueSubmission(args)).stored,true);
  const entries=(await readJson(path.join(f.directory,'rescue-submissions.json'))).entries;assert.equal(entries.length,1);
  assert.equal(entries[0].clientId,(await readJson(faultRescueFile(f.directory))).clientId);assert.ok(!JSON.stringify(entries).includes('token'));
  await assert.rejects(recordRescueSubmission({...args,invitationSentAt:iso(120_000)}));await assert.rejects(recordRescueSubmission({...args,operationId:'op_other'}));
});
test('valid work keeps ordinary recovery within sixty seconds despite a thirty-minute idle backoff',async t=>{
  for(const pending of [true,false]) {
    const f=await fixture(t);await f.prepare();await f.dispatch();await f.settle({verifiedHandled:true});
    const r=await readJson(faultRescueFile(f.directory));r.readOnlyRetry={attempts:6,requestedAt:iso(0)};await atomicJson(faultRescueFile(f.directory),r);f.advance(600_000);
    const calls=[];let currentHost={...safeHost,mode:'admin',adminCommand:'finish-fault-rescue',checkedAt:iso(0)},admin;
    const result=await superviseFaultRescue({directory:f.directory,projectRoot:path.resolve('fixture'),config:f.config,
      host:currentHost,status:{state:'blocked',failureCode:'browser_unavailable',faultRescueEligible:true},journal:{phase:'settled'},
      lock:null,processClear:true,now:f.clock,save:async()=>{},runProbe:async()=>{calls.push('probe');},
      runAdmin:async command=>{
        calls.push(command);currentHost={...safeHost,adminCommand:command,checkedAt:f.clock().toISOString()};admin={command,success:true};
        if(command==='prepare-fault-rescue')await atomicJson(path.join(f.directory,'fault-rescue-plan.json'),{version:1,checkedAt:f.clock().toISOString(),pendingCount:pending?1:0,rescueCanBegin:false,rescueReason:'daily_limit'});
      },refreshSafety:async()=>({host:currentHost,lock:null,processClear:true,adminResult:admin}),
      withClient:async()=>{throw new Error('No model client is needed for quota/read-only recovery.');}});
    if(pending){assert.equal(result.result.reason,'fault_rescue_recovery_probe_exited');assert.deepEqual(calls,['prepare-fault-rescue','recover-browser','probe']);}
    else{assert.equal(result.result.reason,'fault_rescue_read_only_backoff');assert.deepEqual(calls,['prepare-fault-rescue']);}
  }
});
