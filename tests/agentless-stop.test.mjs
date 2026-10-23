import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {GracefulStopControl,runGracefulBatch,requestGracefulStop,STOP_FILE} from '../scripts/agentless/graceful-stop.mjs';
import {stopOptions} from '../scripts/agentless/stop.mjs';

const owner={pid:12345,at:'2026-10-23T12:00:00.000Z'};
const stop=target=>({version:1,id:randomUUID(),target,requestedAt:'2026-10-23T12:00:01.000Z'});
async function local(run) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-graceful-stop-'));
  try {await run(directory);}finally {await rm(directory,{recursive:true,force:true});}
}

test('startup ignores but does not delete stale requests, including PID reuse',async()=>local(async directory=>{
  const old=stop({...owner,at:'2026-10-22T12:00:00.000Z'}),file=path.join(directory,STOP_FILE);
  await atomicJson(file,old);
  const control=new GracefulStopControl(directory,owner);
  assert.equal(await control.requested(),false);assert.equal(control.ignoredStaleRequest,true);
  assert.deepEqual(await readJson(file),old);
  const fresh=stop(owner);await atomicJson(file,fresh);
  assert.equal(await control.requested(),true);assert.equal(control.requestId,fresh.id);
  assert.deepEqual(await readJson(file),fresh,'startup must not erase a concurrent current request');
}));

test('stop during a batch waits for its receipt and prevents the next batch',async()=>local(async directory=>{
  const control=new GracefulStopControl(directory,owner),events=[];
  let enter,finish;
  const entered=new Promise(resolve=>{enter=resolve;}),receipt=new Promise(resolve=>{finish=resolve;});
  let settled=false;
  const running=runGracefulBatch(async()=>{
    events.push('claimed');enter();await receipt;events.push('receipt');return {mode:'processed'};
  },()=>control.requested()).then(result=>{settled=true;return result;});
  await entered;
  await atomicJson(path.join(directory,STOP_FILE),stop(owner));
  assert.equal(settled,false);assert.deepEqual(events,['claimed']);
  finish();const result=await running;
  assert.deepEqual(events,['claimed','receipt']);assert.equal(result.stopped,true);assert.equal(result.ran,true);
  const next=await runGracefulBatch(()=>assert.fail('must not start another batch'),()=>control.requested());
  assert.deepEqual(next,{ran:false,stopped:true});
}));

test('unknown batch failure still throws and does not turn into a successful stop',async()=>local(async directory=>{
  const control=new GracefulStopControl(directory,owner);
  await assert.rejects(runGracefulBatch(async()=>{
    await atomicJson(path.join(directory,STOP_FILE),stop(owner));throw new Error('uncertain original lease');
  },()=>control.requested()),/uncertain original lease/);
  assert.equal(await control.requested(),true);
}));

test('requester waits for lock release without changing operation journal',async()=>local(async directory=>{
  const lock=path.join(directory,'worker.lock'),journal=path.join(directory,'operation.json');
  const evidence={phase:'claimed',lease:{id:'original',token:'retain-secret'}};
  await atomicJson(lock,owner);await atomicJson(journal,evidence);
  const control=new GracefulStopControl(directory,owner);let clock=0;
  const result=await requestGracefulStop({directory,timeoutMs:1000,now:()=>clock,pause:async ms=>{
    clock+=ms;assert.equal(await control.requested(),true);await unlink(lock);
  }});
  assert.equal(result.state,'stopped');assert.equal(result.modelCalls,0);
  assert.deepEqual(await readJson(journal),evidence);
}));

test('timeout retains request, lock and uncertain lease; never forces termination',async()=>local(async directory=>{
  const lock=path.join(directory,'worker.lock'),journal=path.join(directory,'operation.json');
  const evidence={phase:'attempting',lease:{token:'keep-original'}};
  await atomicJson(lock,owner);await atomicJson(journal,evidence);let clock=0;
  await assert.rejects(requestGracefulStop({directory,timeoutMs:1000,now:()=>clock,pause:async ms=>{clock+=ms;}}),/超时/);
  assert.deepEqual(await readJson(lock),owner);assert.deepEqual(await readJson(journal),evidence);
  assert.equal(await new GracefulStopControl(directory,owner).requested(),true);
}));

test('replacement instance is reported rather than stopped with an old request',async()=>local(async directory=>{
  const lock=path.join(directory,'worker.lock');await atomicJson(lock,owner);let clock=0;
  const replacement={...owner,at:'2026-10-23T12:01:00.000Z'};
  await assert.rejects(requestGracefulStop({directory,timeoutMs:1000,now:()=>clock,pause:async ms=>{
    clock+=ms;await atomicJson(lock,replacement);
  }}),/实例已改变/);
  assert.equal(await new GracefulStopControl(directory,replacement).requested(),false);
}));

test('no worker is a no-op and an initializing lock gets a bounded read retry',async()=>local(async directory=>{
  assert.equal((await requestGracefulStop({directory})).state,'already_stopped');
  assert.equal(await readJson(path.join(directory,STOP_FILE)),null);
  const lock=path.join(directory,'worker.lock');await writeFile(lock,'');let clock=0,round=0;
  const result=await requestGracefulStop({directory,timeoutMs:1000,now:()=>clock,pause:async ms=>{
    clock+=ms;if(++round===1)await atomicJson(lock,owner);else await unlink(lock);
  }});
  assert.equal(result.state,'stopped');assert.equal(round,2);
}));

test('malformed stop data and arbitrary CLI destinations are rejected',async()=>local(async directory=>{
  await atomicJson(path.join(directory,STOP_FILE),{version:1,id:'bad',target:owner});
  await assert.rejects(new GracefulStopControl(directory,owner).requested(),/停机请求无效/);
  assert.deepEqual(stopOptions([]),{timeoutMs:300_000});
  assert.deepEqual(stopOptions(['--timeout-ms','1000']),{timeoutMs:1000});
  for(const args of [['--file','elsewhere'],['--timeout-ms','0'],['--timeout-ms','600001'],
    ['--timeout-ms','1000','extra'],['--kill'],['--timeout-ms','1e5']])assert.throws(()=>stopOptions(args));
}));
