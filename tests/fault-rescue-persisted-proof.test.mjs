import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {completedRescueProof} from './helpers/completed-rescue-proof.mjs';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {faultRescueGate,faultRescueFile,settleFaultRescue} from '../scripts/agentless/fault-rescue.mjs';
import {localRecoveryOwned} from '../scripts/agentless/recovery-fence.mjs';
import {finishedFaultRescueEvidence} from '../scripts/agentless/fault-rescue-ownership.mjs';
const execute=promisify(execFile);
const base=Date.now()-10_000,at=n=>new Date(base+n).toISOString(),clock=()=>new Date(at(9000));
function record(){const r={version:1,phase:'finished',outcome:'unresolved',agentStopped:true,
  failureId:'failure-fixture',threadId:'thread-fixture',clientId:'client-fixture',queuedId:'queue-fixture',
  createdAt:at(0),updatedAt:at(5000),dispatchStartedAt:at(1000),
  ticket:{id:'rescue_1234567890abcdef',failureId:'failure-fixture',scope:'read_only_reconcile',token:'fixture-only-private-token'}};
  return {...r,agentProof:completedRescueProof(r)};}
async function temp(t){const directory=await mkdtemp(path.join(os.tmpdir(),'numems-terminal-proof-'));
  t.after(async()=>{const r=path.relative(os.tmpdir(),directory);assert.ok(r&&!r.startsWith('..')&&!path.isAbsolute(r));await rm(directory,{recursive:true,force:true});});return directory;}
const legacy=r=>({...r.agentProof,status:'interrupted',completedAt:null,terminalEvidence:undefined,terminalChain:undefined,terminalFamily:undefined});

test('legacy finished/status-only records stay fenced across synchronous and async routine ownership gates',async t=>{
  const directory=await temp(t),r=record();r.agentProof=legacy(r);
  await atomicJson(faultRescueFile(directory),r);
  assert.equal(faultRescueGate(r).allowWorker,false);assert.equal(await localRecoveryOwned(faultRescueFile(directory)),true);
  for(const change of [p=>{delete p.terminalEvidence;},p=>{p.completedAt=null;},
    p=>{p.terminalChain[0].completedAt=null;},p=>{p.terminalFamily.push({turnId:'still-active',status:'interrupted',startedAt:at(0),completedAt:null,ended:true});},
    p=>{p.readMethod='thread/turns/list';p.headRevalidated=false;}]){
    const bad=record();change(bad.agentProof);assert.equal(finishedFaultRescueEvidence(bad),false);
  }
  assert.equal(faultRescueGate(record()).allowWorker,true);
});

test('historically premature finish is re-certified only after fresh real completion, preserving the original proof',async t=>{
  const directory=await temp(t),r=record();r.agentProof=legacy(r);const original=structuredClone(r.agentProof);
  await atomicJson(faultRescueFile(directory),r);const calls=[];
  const portal={async call(name){calls.push(name);return {ticket:{id:r.ticket.id,failureId:r.failureId,phase:'finished',outcome:'unresolved'}};}};
  const fresh=completedRescueProof(r,{completedAt:at(7000),observedAt:at(9000)});
  const result=await settleFaultRescue({directory,portal,client:{observeTurnState:async()=>fresh},hostSafe:true,clock});
  const saved=await readJson(faultRescueFile(directory));assert.equal(result.state,'finished');
  assert.deepEqual(saved.agentProof,JSON.parse(JSON.stringify(original)));assert.deepEqual(saved.terminalRevalidationProof,fresh);
  assert.equal(faultRescueGate(saved).allowWorker,true);assert.deepEqual(calls,['fault_rescue_status']);
});

test('active interrupted/null projection cannot reconcile a prior finished or finish-result-unknown receipt',async t=>{
  for(const phase of ['finished','finishing','uncertain']){
    const directory=await temp(t),r=record();r.phase=phase;r.agentProof=legacy(r);
    if(phase!=='finished'){r.reason='finish_result_unknown';r.finishIntent={outcome:'unresolved'};}
    await atomicJson(faultRescueFile(directory),r);
    const result=await settleFaultRescue({directory,portal:{call:async()=>assert.fail('no cloud finish or ownership release')},
      client:{observeTurnState:async()=>({...legacy(r),observedAt:at(9000)})},hostSafe:true,clock});
    assert.equal(result.reason,'agent_stop_unconfirmed');assert.equal(faultRescueGate(await readJson(faultRescueFile(directory))).allowWorker,false);
  }
});

test('only genuine pre-dispatch cancellation remains exempt from model completion evidence',()=>{
  const r=record();delete r.dispatchStartedAt;delete r.queuedId;
  Object.assign(r,{notDispatched:true,reason:'cancelled_before_dispatch',agentProof:{kind:'not_dispatched',stopped:true,
    source:'local_dispatch_cancelled',clientUserMessageId:r.clientId,observedAt:at(5000)}});
  assert.equal(faultRescueGate(r).allowWorker,true);
  assert.equal(faultRescueGate({...r,dispatchStartedAt:at(1000)}).allowWorker,false);
  assert.equal(faultRescueGate({...r,agentProof:{...r.agentProof,source:'model_ack'}}).allowWorker,false);
});

test('native restart validates actual completion for every linked/family turn and rejects old persisted receipts',
  {skip:process.platform!=='win32'},async()=>{
    const source=await readFile(new URL('../scripts/agentless/isolated-desktop.ps1',import.meta.url),'utf8');
    const definition=source.match(/^function Test-FaultRescueTerminalProof\(\$Proof, \$Rescue\) \{[\s\S]*?^\}/m)?.[0];assert.ok(definition);
    const r=record(),good=r.agentProof,missing=legacy(r),active=structuredClone(good);
    active.terminalFamily.push({turnId:'active-descendant',status:'interrupted',startedAt:at(0),completedAt:null,ended:true});
    const payload=JSON.stringify({record:r,proofs:[good,missing,active]}).replaceAll("'","''");
    const command=`$ErrorActionPreference='Stop';${definition};$x=ConvertFrom-Json '${payload}';@($x.proofs|ForEach-Object {Test-FaultRescueTerminalProof $_ $x.record})|ConvertTo-Json -Compress`;
    const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000});
    assert.deepEqual(JSON.parse(stdout),[true,false,false]);
  });
