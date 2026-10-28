import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {readJson,atomicJson} from '../scripts/agentless/journal.mjs';
import {faultRescueFile,dispatchPreparedFaultRescue} from '../scripts/agentless/fault-rescue.mjs';
import {superviseFaultRescue,supervise,superviseLocalContextRecovery,faultRescueHostSafe,faultRescueRestartDecision} from '../scripts/agentless/watchdog.mjs';

const at=n=>new Date(Date.parse('2026-10-28T10:00:00Z')+n).toISOString();
const host={mode:'run',state:'blocked',exitCode:1,processId:1234,checkedAt:at(0),modelCalls:0,audits:3,
  desktop:'NUMEMS-Agentless-fixture',inputDesktop:'Default',maxOwnedWindowsOnInputDesktop:0,
  windowAudit:{isolated:true,desktop:'NUMEMS-Agentless-fixture',inputDesktop:'Default',ownedWindowsOnInputDesktop:0}};
const config={liveActions:true,browserMode:'isolated_desktop',headless:false,legacyCheckerDisabled:true,
  faultRescue:{enabled:true,scope:'read_only_reconcile',threadId:'thread-fixture'}};
const ticket={id:'rescue_fixture_1234567890123456',failureId:'fault-fixture',token:'fixture-only-secret-never-print',phase:'pending',scope:'read_only_reconcile'};
const pending=()=>({version:1,phase:'prepared',failureId:ticket.failureId,failureCode:'browser_unavailable',clientId:'client-fixture',
  threadId:'thread-fixture',createdAt:at(0),updatedAt:at(0),targetIds:[],ticket:{...ticket}});
const turn=(r,stopped=false)=>({kind:'codex_turn_state',source:'app_server_thread_read',confirmed:true,stopped,
  threadId:r.threadId,clientUserMessageId:r.clientId,queuedId:r.queuedId??null,turnId:'turn-fixture',linkedTurnId:'turn-fixture',
  status:stopped?'completed':'inProgress',startedAt:at(0),observedAt:at(20_000),exclusiveTurn:true});
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-fault-watchdog-'));
  t.after(async()=>{const relative=path.relative(os.tmpdir(),directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(directory,{recursive:true,force:true});});
  const calls=[],reports=[];let currentHost=structuredClone(host),currentAdmin=null,ms=20_000,proofStopped=false;
  const state={directory,projectRoot:path.resolve('fixture'),config:structuredClone(config),host:currentHost,
    journal:{phase:'settled'},lock:null,stopRequest:null,processClear:true,
    status:{state:'blocked',failureCode:'browser_unavailable',faultRescueEligible:true},now:()=>new Date(at(ms)),
    save:async report=>reports.push(report),
    runAdmin:async(command,id)=>{
      calls.push(command);currentHost={...host,mode:'admin',adminCommand:command,state:'exited',exitCode:0,checkedAt:at(ms)};
      currentAdmin={command,success:true};
      if(command==='prepare-fault-rescue')await atomicJson(faultRescueFile(directory),pending());
      if(command==='finish-fault-rescue') {
        const r=await readJson(faultRescueFile(directory));assert.equal(r.ticket.id,id);assert.equal(r.watchdogStopProof.stopped,true);
        await atomicJson(faultRescueFile(directory),{...r,phase:'finished',outcome:'unresolved',agentStopped:true,updatedAt:at(ms)});
      }
    },runProbe:async()=>{calls.push('probe');},
    refreshSafety:async()=>({host:currentHost,adminResult:currentAdmin,lock:null,stopRequest:null,processClear:true}),
    withClient:async callback=>{
      calls.push('client');return callback({async enqueue(){calls.push('enqueue');return{queuedSubmission:{id:'queue-fixture'}};},async queued(){return[];},
        async observeTurnState(){calls.push('read-turn');return turn(await readJson(faultRescueFile(directory)),proofStopped);},
        async interruptTrackedTurn(){calls.push('interrupt');}});
    }};
  return {directory,state,calls,reports,advance(n){ms+=n;},stopped(){proofStopped=true;},run(){return superviseFaultRescue(state);}};
}

test('healthy ticks and first diagnostic without exhausted-recovery marker never load a Codex client',async t=>{
  const f=await fixture(t);f.state.status.faultRescueEligible=false;assert.equal((await f.run()).handled,false);
  f.state.status={mode:'idle'};assert.equal((await f.run()).handled,false);assert.deepEqual(f.calls,[]);
});
test('broker dispatch occurs only after isolated prepare host has fully exited',async t=>{
  const f=await fixture(t);const r=await f.run();assert.equal(r.result.reason,'fault_rescue_dispatch_queued');
  assert.deepEqual(f.calls,['prepare-fault-rescue','client','enqueue']);assert.ok(!JSON.stringify(r).includes(ticket.token));
});
test('unknown PID, residual lock, visible-window audit and explicit stop all forbid dispatch',async t=>{
  for(const change of [{processClear:false},{lock:{pid:1234,at:at(0)}},{host:{...host,maxOwnedWindowsOnInputDesktop:1}},
    {stopRequest:{version:1,id:'stop-fixture',target:{pid:1234,at:at(0)},requestedAt:at(0)}}]) {
    const f=await fixture(t);Object.assign(f.state,change);assert.equal((await f.run()).result.reason,'fault_rescue_host_not_closed');assert.deepEqual(f.calls,[]);
  }
});
test('native-host uncertainty after ticket preparation preserves pending ownership without enqueue',async t=>{
  const f=await fixture(t);f.state.refreshSafety=async()=>({host,lock:null,processClear:false});
  assert.equal((await f.run()).result.reason,'fault_rescue_prepare_host_not_closed');assert.deepEqual(f.calls,['prepare-fault-rescue']);
});
test('ACK or absence from queue never starts finish admin while an exact turn remains active',async t=>{
  const f=await fixture(t);await f.run();f.calls.length=0;
  assert.equal((await f.run()).result.reason,'fault_rescue_agent_stop_unconfirmed');assert.deepEqual(f.calls,['client','read-turn']);
  f.stopped();f.calls.length=0;assert.equal((await f.run()).result.reason,'fault_rescue_finished');
  assert.deepEqual(f.calls,['client','read-turn','finish-fault-rescue']);
});
test('active ticket blocks ordinary worker even when fault-only dispatch has been disabled',async t=>{
  const f=await fixture(t);await atomicJson(faultRescueFile(f.directory),pending());f.state.config.faultRescue.enabled=false;
  assert.equal((await f.run()).result.reason,'fault_rescue_dispatch_disabled');assert.deepEqual(f.calls,[]);
  let launches=0;const r=await supervise({config:f.state.config,host,journal:{phase:'settled'},now:f.state.now,
    faultRescueRecord:pending(),save:async()=>{},run:async()=>{launches++;}});
  assert.equal(r.reason,'fault_rescue_owns_recovery');assert.equal(launches,0);
});
test('ended unresolved browser incident retries only deterministic read-only recovery with durable backoff',async t=>{
  const f=await fixture(t);await atomicJson(faultRescueFile(f.directory),{...pending(),phase:'finished',outcome:'unresolved',agentStopped:true});
  assert.equal((await f.run()).result.reason,'fault_rescue_read_only_backoff');f.advance(41_000);
  assert.equal((await f.run()).result.reason,'fault_rescue_recovery_probe_exited');assert.deepEqual(f.calls,['recover-browser','probe']);
  f.calls.length=0;assert.equal((await f.run()).result.reason,'fault_rescue_read_only_backoff');assert.deepEqual(f.calls,[]);
  assert.equal((await readJson(faultRescueFile(f.directory))).readOnlyRetry.attempts,1);
});
test('unsettled original action cannot be retried by post-rescue deterministic recovery',async t=>{
  const f=await fixture(t);await atomicJson(faultRescueFile(f.directory),{...pending(),phase:'finished',outcome:'unresolved',agentStopped:true});
  f.state.journal={phase:'attempting',lease:{id:'original'}};f.advance(60_000);
  assert.equal((await f.run()).handled,false);assert.deepEqual(f.calls,[]);
});
test('simultaneous dispatchers use one permanent pre-enqueue intent witness',async t=>{
  const f=await fixture(t);await atomicJson(faultRescueFile(f.directory),pending());let wakes=0;
  const args={directory:f.directory,projectRoot:path.resolve('fixture'),hostSafe:true,clock:f.state.now,
    client:{enqueue:async()=>{wakes++;return{queuedSubmission:{id:'queue-fixture'}};}}};
  await Promise.all([dispatchPreparedFaultRescue(args),dispatchPreparedFaultRescue(args)]);assert.equal(wakes,1);
  await dispatchPreparedFaultRescue(args);assert.equal(wakes,1);
});
test('only exact finished recovery, fresh metadata and a zero-window isolated exit seed restart',()=>{
  const rescue={...pending(),phase:'finished',outcome:'recovered',agentStopped:true,updatedAt:at(12_000),agentProof:turn(pending(),true)};
  rescue.agentProof.observedAt=at(10_000);
  const h={...host,mode:'admin',adminCommand:'finish-fault-rescue',state:'exited',exitCode:0,checkedAt:at(16_000)};
  const status={mode:'idle',modelCalls:0,liveActions:true,checkedAt:at(14_000),faultRescueEvidence:{rescueId:ticket.id,failureId:ticket.failureId}};
  const adminResult={command:'finish-fault-rescue',requestId:ticket.id,success:true,modelCalls:0,startedAt:at(9_000),finishedAt:at(15_000),
    result:{rescueId:ticket.id,failureId:ticket.failureId,state:'finished',outcome:'recovered'}};
  const data={host:h,status,journal:{phase:'settled'},adminResult,rescue,now:Date.parse(at(20_000))};
  assert.equal(faultRescueRestartDecision(data).allowed,true);
  for(const change of [{rescue:{...rescue,agentStopped:false}},{rescue:{...rescue,agentProof:{...rescue.agentProof,confirmed:false}}},
    {status:{...status,state:'blocked'}},{adminResult:{...adminResult,success:false}},
    {journal:{phase:'settled',receipt:{}}},{host:{...h,maxOwnedWindowsOnInputDesktop:1}}])
    assert.equal(faultRescueRestartDecision({...data,...change}).allowed,false);
  assert.equal(faultRescueHostSafe({host:h,lock:null,processClear:false,now:data.now}),false);
});

const contextStatus=()=>({checkedAt:at(0),state:'blocked',failureCode:'unknown',localContextRecoveryEligible:true,
  error:'page.evaluate: Target page, context or browser has been closed'});
async function contextFixture(t) {
  const f=await fixture(t);f.state.status=contextStatus();f.advance(41_000);
  const oldRefresh=f.state.refreshSafety;
  f.state.refreshSafety=async()=>{
    const proof=await oldRefresh();return {...proof,adminResult:{...proof.adminResult,result:{state:'verified',modelCalls:0,officialObservedAt:f.state.now().toISOString()}}};
  };
  return {...f,run:()=>superviseLocalContextRecovery(f.state)};
}
test('exact pre-claim closed context uses fresh deterministic recovery and probe without Codex',async t=>{
  const f=await contextFixture(t);const r=await f.run();assert.equal(r.result.reason,'local_context_isolated_probe_exited');
  assert.equal(r.result.modelCalls,0);assert.deepEqual(f.calls,['recover-browser','probe']);
  const saved=await readJson(path.join(f.directory,'local-context-retry.json'));assert.equal(saved.state,'official_healthy');assert.equal(saved.attempts,1);
});
test('generic unknown, changed error text and absent marker do not grant local context recovery',async t=>{
  for(const change of [{localContextRecoveryEligible:false},{error:'Unknown member write failure'},
    {error:'page.evaluate: Target page, context or browser has been closed; operation result unknown'},
    {failureCode:'browser_unavailable'}]) {
    const f=await contextFixture(t);Object.assign(f.state.status,change);const r=await f.run();
    assert.equal(r.handled,change.localContextRecoveryEligible===false?false:true);assert.deepEqual(f.calls,[]);
  }
});
test('closed-context marker cannot override an unfinished journal, active rescue, live process or input-desktop window',async t=>{
  for(const change of [{journal:{phase:'attempting',lease:{id:'original'}}},{processClear:false},
    {host:{...host,maxOwnedWindowsOnInputDesktop:1}},{lock:{pid:1234,at:at(0)}}]) {
    const f=await contextFixture(t);Object.assign(f.state,change);assert.equal((await f.run()).handled,true);assert.deepEqual(f.calls,[]);
  }
  const f=await contextFixture(t);await atomicJson(faultRescueFile(f.directory),pending());
  assert.equal((await f.run()).result.reason,'fault_rescue_owns_recovery');assert.deepEqual(f.calls,[]);
});
test('backend global unknown or failed official health does not launch a probe, model or member action',async t=>{
  const f=await contextFixture(t);f.state.runAdmin=async command=>{f.calls.push(command);throw new Error('Cloud unknown remains unresolved');};
  assert.equal((await f.run()).result.reason,'local_context_fresh_health_not_verified');assert.deepEqual(f.calls,['recover-browser']);
  const retained=await readJson(path.join(f.directory,'local-context-retry.json'));assert.equal(retained.state,'attempted');
  f.calls.length=0;assert.equal((await f.run()).result.reason,'local_context_read_only_backoff');assert.deepEqual(f.calls,[]);
});
test('closed-context recovery carries bounded retry history across restarts instead of resetting from a new timestamp',async t=>{
  const f=await contextFixture(t);f.state.runAdmin=async()=>{throw new Error('read-only unavailable');};await f.run();
  f.advance(119_000);assert.equal((await f.run()).result.reason,'local_context_read_only_backoff');
  f.advance(2000);assert.equal((await f.run()).result.reason,'local_context_fresh_health_not_verified');
  assert.equal((await readJson(path.join(f.directory,'local-context-retry.json'))).attempts,2);
});
test('stale or generic administrator success is insufficient for local-context recovery',async t=>{
  const f=await contextFixture(t);
  f.state.refreshSafety=async()=>({host:{...host,mode:'admin',adminCommand:'recover-browser',state:'exited',exitCode:0},
    lock:null,processClear:true,adminResult:{command:'recover-browser',success:true,result:{state:'verified',modelCalls:0,officialObservedAt:at(0)}}});
  assert.equal((await f.run()).result.reason,'local_context_fresh_health_not_verified');assert.deepEqual(f.calls,['recover-browser']);
});
