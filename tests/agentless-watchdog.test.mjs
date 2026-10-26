import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {supervise,processGate} from '../scripts/agentless/watchdog.mjs';
import {GracefulStopControl} from '../scripts/agentless/graceful-stop.mjs';
import {assertDesktop} from '../scripts/agentless/browser.mjs';
const now=()=>new Date('2026-10-26T02:00:00.000Z');
const config={liveActions:true,browserMode:'isolated_desktop',headless:false,legacyCheckerDisabled:true};
const host={mode:'run',state:'blocked',checkedAt:'2026-10-26T01:59:00.000Z',processId:123,
  error:'Input desktop cannot be audited',modelCalls:0};
const journal={phase:'settled'};
const desktop={windowStation:'WinSta0',inputDesktop:'Default'};
test('locked desktop waits without starting any member worker, then a later check can recover',async()=>{
  const calls=[],reports=[];
  const base={config,host,journal,now,save:async x=>reports.push(x)};
  const first=await supervise({...base,run:async kind=>{calls.push(kind);throw new Error('secured desktop');}});
  assert.equal(first.state,'waiting_desktop');assert.deepEqual(calls,['desktop']);
  calls.length=0;
  const second=await supervise({...base,run:async kind=>{calls.push(kind);return kind==='desktop'?desktop:null;}});
  assert.equal(second.state,'worker_exited');assert.deepEqual(calls,['desktop','worker']);
  assert.ok(reports.every(r=>r.modelCalls===0));
});
test('uncertain journal never probes desktop or restarts an operation',async()=>{
  for(const phase of ['claiming','claimed','attempting','completing']) {
    let calls=0;
    const result=await supervise({config,host,journal:{phase},now,save:async()=>{},run:async()=>{calls++;}});
    assert.equal(result.state,'held');assert.equal(calls,0);
  }
});
test('worker failure has no immediate retry and the next unknown failure is held',async()=>{
  const calls=[];
  const result=await supervise({config,host,journal,now,save:async()=>{},run:async kind=>{
    calls.push(kind);if(kind==='desktop')return desktop;throw new Error('unknown action');}});
  assert.equal(result.state,'worker_failed');assert.deepEqual(calls,['desktop','worker']);
  const held=await supervise({config,host:{...host,error:'Unknown member result'},journal,now,
    save:async()=>{},run:async()=>{throw new Error('must not run');}});
  assert.equal(held.state,'held');
});
test('disabled config and invalid availability do not open browser',async()=>{
  const disabled=await supervise({config:{...config,liveActions:false},host,journal,now,save:async()=>{},
    run:async()=>{throw new Error('must not run');}});
  assert.equal(disabled.state,'disabled');
  const calls=[];
  const unavailable=await supervise({config,host,journal,now,save:async()=>{},run:async kind=>{
    calls.push(kind);return {error:'desktop_isolation_unverified'};}});
  assert.equal(unavailable.state,'waiting_desktop');assert.deepEqual(calls,['desktop']);
});
test('PID checks reject live/reused or inaccessible processes, only ESRCH proves death',()=>{
  const lock={pid:123,at:'2026-10-26T01:59:00Z'};
  assert.equal(processGate({host,lock},()=>{}).clear,false);
  assert.equal(processGate({host,lock},()=>{throw Object.assign(new Error(),{code:'EPERM'});}).clear,false);
  assert.equal(processGate({host,lock},()=>{throw Object.assign(new Error(),{code:'ESRCH'});}).clear,true);
  assert.equal(processGate({host,lock:{pid:'123'}}).clear,false);
  let checks=0;
  assert.equal(processGate({host:{processId:5},lock},()=>{checks++;throw Object.assign(new Error(),{code:'ESRCH'});}).clear,true);
  assert.equal(checks,2);
});
test('stop submitted during supervised restart stops the new incarnation too',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-watchdog-stop-test-'));
  const file=path.join(directory,'stop-request.json');
  const value={version:1,id:'12345678-1234-1234-1234-123456789012',
    target:{pid:100,at:'2026-10-26T01:00:00Z'},requestedAt:'2026-10-26T01:59:01Z'};
  try {
    await writeFile(file,JSON.stringify(value));
    const control=new GracefulStopControl(directory,{pid:200,at:'2026-10-26T01:59:02Z'},
      {watchdogStartedAt:'2026-10-26T01:59:00Z'});
    assert.equal(await control.requested(),true);assert.equal(control.requestId,value.id);
    const later=new GracefulStopControl(directory,{pid:300,at:'2026-10-26T02:00:01Z'},
      {watchdogStartedAt:'2026-10-26T02:00:00Z'});
    assert.equal(await later.requested(),false);assert.equal(later.ignoredStaleRequest,true);
  } finally {await unlink(file);await rmdir(directory);}
});
test('only the exact native pre-action input-desktop failure is transient',async()=>{
  const options={platform:'win32',env:{NUMEMS_DESKTOP_NAME:'NUMEMS-Agentless-test123'}};
  for(const [proof,expected] of [
    [{error:'desktop_isolation_unverified',reason:'input_desktop_unavailable'},'browser_unavailable'],
    [{error:'desktop_isolation_unverified',reason:'desktop_isolation_unverified'},undefined],
    [{isolated:false},undefined]]) {
    await assert.rejects(assertDesktop(config,{...options,run:async()=>{
      throw Object.assign(new Error('desktop probe failed'),{stdout:JSON.stringify(proof)});
    }}),error=>error.failureCode===expected);
  }
});
