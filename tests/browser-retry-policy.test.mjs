import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {browserRetryDecision} from '../scripts/agentless/browser-retry-policy.mjs';
import {restartDecision} from '../scripts/agentless/watchdog-policy.mjs';
import {readEvidenceSnapshot,supervise} from '../scripts/agentless/watchdog.mjs';

const t=Date.parse('2026-10-28T03:00:00.000Z'),at=ms=>new Date(t+ms).toISOString();
const status={checkedAt:at(0),state:'blocked',failureCode:'browser_unavailable',error:'official challenge',modelCalls:0};
const host={mode:'run',state:'blocked',processId:123,checkedAt:at(1000),exitCode:1,modelCalls:0};
const journal={phase:'settled'};
const config={liveActions:true,browserMode:'isolated_desktop',headless:false,legacyCheckerDisabled:true};
const desktop={windowStation:'WinSta0',inputDesktop:'Default'};

test('first blocked-browser restart waits 60 seconds after the completed failure',()=>{
  const early=browserRetryDecision({status,host,now:t+60_000});
  assert.equal(early.allowed,false);assert.equal(early.reason,'browser_retry_backoff');
  assert.equal(early.dueAt,at(61_000));assert.equal(early.attempts,0);
  const ready=browserRetryDecision({status,host,now:t+61_000});
  assert.equal(ready.allowed,true);assert.equal(ready.nextRecord.attempts,1);
  assert.equal(ready.nextRecord.issuedAt,at(61_000));
});

test('successive fresh failure timestamps retain persisted counts and delay up to 30 minutes',()=>{
  let currentStatus=status,currentHost=host,retryRecord=null,current=t+61_000;
  for(const [index,delayMs] of [60_000,120_000,300_000,600_000,900_000,1_800_000,1_800_000].entries()) {
    const decision=browserRetryDecision({status:currentStatus,host:currentHost,retryRecord,now:current});
    assert.equal(decision.allowed,true);assert.equal(decision.delayMs,delayMs);
    assert.equal(decision.nextRecord.attempts,index+1);retryRecord=decision.nextRecord;
    // A different process writes a fresh failure time, but this does not reset
    // the retry budget. Its run time also must not consume the next cooldown.
    const failedAt=current+13*60_000;
    currentStatus={...status,checkedAt:new Date(failedAt).toISOString()};
    currentHost={...host,checkedAt:new Date(failedAt+1000).toISOString()};
    const held=browserRetryDecision({status:currentStatus,host:currentHost,retryRecord,now:failedAt+1000});
    assert.equal(held.allowed,false);assert.equal(held.reason,'browser_retry_backoff');
    const nextDelay=[120_000,300_000,600_000,900_000,1_800_000,1_800_000,1_800_000][index];
    assert.equal(held.delayMs,nextDelay);assert.equal(Date.parse(held.dueAt),failedAt+1000+nextDelay);
    current=Date.parse(held.dueAt);
  }
});

test('invalid, regressed and unresolved retry evidence fails closed',()=>{
  const record=browserRetryDecision({status,host,now:t+61_000}).nextRecord;
  const laterHost={...host,checkedAt:at(62_000)};
  for(const retryRecord of [{},[],{...record,attempts:0},{...record,issuedAt:at(200_000)},
    {...record,statusDigest:'invalid'},{...record,statusCheckedAt:at(62_000)}])
    assert.equal(browserRetryDecision({status,host:laterHost,retryRecord,now:t+190_000}).allowed,false);
  assert.equal(browserRetryDecision({status,host,retryRecord:record,now:t+200_000}).reason,'browser_retry_launch_unresolved');
  assert.equal(browserRetryDecision({status:{...status,error:'mutated'},host:laterHost,retryRecord:record,now:t+200_000}).reason,
    'browser_retry_status_regressed');
});

test('read errors and malformed persisted files do not probe or start a browser',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-browser-retry-'));
  try {
    await writeFile(path.join(directory,'browser-retry.json'),'{broken');
    for(const readBrowserRetry of [async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});},
      async()=>(await readEvidenceSnapshot(directory,'browser-retry.json')).value]) {
      let calls=0;
      const result=await supervise({config,host,status,journal,now:()=>new Date(t+61_000),
        save:async()=>{},readBrowserRetry,saveBrowserRetry:async()=>{},run:async()=>{calls++;}});
      assert.equal(result.reason,'browser_retry_store_unavailable');assert.equal(calls,0);
    }
  } finally {await unlink(path.join(directory,'browser-retry.json'));await rmdir(directory);}
});

test('write failure stops before worker launch; successful persistence precedes the launch',async()=>{
  const calls=[],written=[];
  const base={config,host,status,journal,now:()=>new Date(t+61_000),save:async()=>{},
    readBrowserRetry:async()=>null,run:async kind=>{calls.push(kind);return kind==='desktop'?desktop:null;}};
  const failed=await supervise({...base,saveBrowserRetry:async()=>{calls.push('persist');throw new Error('disk unavailable');}});
  assert.equal(failed.reason,'browser_retry_store_unavailable');assert.deepEqual(calls,['desktop','persist']);
  calls.length=0;
  const success=await supervise({...base,saveBrowserRetry:async value=>{calls.push('persist');written.push(value);}});
  assert.equal(success.state,'worker_exited');assert.deepEqual(calls,['desktop','persist','worker']);
  assert.equal(written[0].attempts,1);assert.equal(success.modelCalls,0);
  const held=await supervise({...base,host:{...host,checkedAt:at(62_000)},readBrowserRetry:async()=>written[0],
    now:()=>new Date(t+100_000),saveBrowserRetry:async()=>{throw new Error('must not write');}});
  assert.equal(held.reason,'browser_retry_backoff');assert.equal(held.dueAt,at(182_000));
});

test('additional cooldown never permits login, unknown, active or unsettled cases',async()=>{
  for(const change of [{status:{...status,failureCode:'login_expired'}},{status:{...status,failureCode:'unknown'}},
    {journal:{phase:'claimed',lease:{id:'op_unfinished'}}},{host:{...host,state:'running'}},
    {status:{...status,mode:'browser_recovery',state:'recovering'}}]) {
    const input={config,host,status,journal,...change,now:()=>new Date(t+200_000)};
    let calls=0,reads=0;
    const result=await supervise({...input,save:async()=>{},readBrowserRetry:async()=>{reads++;return null;},
      saveBrowserRetry:async()=>{throw new Error('must not write');},run:async()=>{calls++;}});
    assert.equal(result.state,'held');assert.equal(calls,0);assert.equal(reads,0);
  }
  assert.notEqual(restartDecision({host,status:{...status,mode:'browser_recovery',state:'recovering'},journal,now:t+200_000}).reason,
    'invalid_status');
});
