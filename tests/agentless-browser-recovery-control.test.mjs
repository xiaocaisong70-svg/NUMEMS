import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {recoverBrowser} from '../scripts/agentless/recovery.mjs';
import {recoverBatchError} from '../scripts/agentless/main.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-browser-recovery-control-'));
  const journalFile=path.join(dir,'operation.json');
  t.after(async()=>{await unlink(journalFile).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(dir);});
  let instant=Date.parse('2026-10-28T04:00:00Z'),stop=false;
  const calls=[],reports=[],sleeps=[];
  const plan={globalFailureCode:'browser_unavailable',globalFailureId:'failure-1',
    browserRecovery:{eligible:true},busy:false,lease:null,lastError:'waiting for official page'};
  const snapshot=()=>({workspaceId:'workspace',accountEmail:'owner@example.com',totalSeats:4,
    members:[{email:'owner@example.com',role:'owner'}],invites:[],observedAt:new Date(instant).toISOString(),
    pageUrl:'https://admin.openai.com/workspace/workspace/members'});
  const args={journalFile,config:{liveActions:true},clock:()=>new Date(instant),
    pause:async ms=>{sleeps.push(ms);instant+=ms;},shouldStop:async()=>stop,
    saveStatus:async report=>reports.push(report),
    portal:{call:async(name,body)=>{calls.push({name,body});return {plan:name==='review_seat_failure'?{}:structuredClone(plan)};}},
    browser:{observe:async()=>snapshot()}};
  return {args,calls,reports,sleeps,plan,snapshot,setStop:()=>{stop=true;},
    journal:async value=>writeFile(journalFile,JSON.stringify(value)),
    advance:ms=>{instant+=ms;}};
}

test('backoff is cancellable in one second and never reviews or observes after stop',async t=>{
  const f=await fixture(t);let observations=0;
  f.args.pause=async ms=>{f.sleeps.push(ms);f.advance(ms);f.setStop();};
  f.args.browser.observe=async()=>{observations++;return f.snapshot();};
  assert.deepEqual(await recoverBrowser(f.args),{stopped:true});
  assert.deepEqual(f.sleeps,[1000]);assert.equal(observations,0);
  assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
  assert.equal(f.reports.at(-1).phase,'stopped');
});

test('recovery publishes fresh bounded-stage heartbeats and forwards safe read controls',async t=>{
  const f=await fixture(t);let observations=0;
  f.args.browser.observe=async options=>{
    observations++;assert.equal(options.shouldStop,f.args.shouldStop);
    await options.onProgress({stage:'members_navigation',state:'challenge',
      expectedUrl:'https://admin.openai.com/workspace/workspace/members?secret=excluded',
      observedAt:f.args.clock().toISOString(),body:'do not persist',token:'do not persist'});
    return f.snapshot();
  };
  assert.equal(await recoverBrowser(f.args),true);assert.equal(observations,1);
  assert.ok(f.sleeps.every(ms=>ms<=1000));assert.equal(f.sleeps.reduce((a,b)=>a+b),1000);
  assert.equal(f.reports[0].checkedAt,'2026-10-28T04:00:00.000Z');
  assert.equal(f.reports.at(-1).checkedAt,'2026-10-28T04:00:01.000Z');
  assert.ok(f.reports.every(r=>r.state==='recovering'&&r.failureCode==='browser_unavailable'&&r.modelCalls===0));
  const diagnostic=f.reports.find(r=>r.officialDiagnostic).officialDiagnostic;
  assert.equal(diagnostic.expectedUrl,'https://admin.openai.com/workspace/workspace/members');
  assert.equal('body' in diagnostic,false);assert.equal('token' in diagnostic,false);
  assert.deepEqual(f.calls.map(c=>c.name),['seat_portal_status','seat_portal_status','seat_portal_status','review_seat_failure']);
});

test('only browser_unavailable observation errors retry and attempts remain bounded',async t=>{
  const f=await fixture(t);let observations=0;
  f.args.browser.observe=async()=>{observations++;throw Object.assign(new Error('unavailable'),{failureCode:'browser_unavailable'});};
  assert.equal(await recoverBrowser(f.args),false);assert.equal(observations,3);
  assert.equal(f.sleeps.reduce((a,b)=>a+b),8000);
  assert.deepEqual(f.reports.filter(r=>r.phase==='unavailable').map(r=>r.attempt),[1,2,3]);
  assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
});

test('login, identity, role, capacity and unknown observation failures retain their exact error',async t=>{
  for(const code of ['login_expired','workspace_mismatch','role_mismatch','capacity_mismatch','unknown',undefined]) {
    const f=await fixture(t);let observations=0;
    const error=Object.assign(new Error('original fatal error'),code?{failureCode:code}:{});
    f.args.browser.observe=async()=>{observations++;throw error;};
    await assert.rejects(recoverBrowser(f.args),actual=>actual===error);
    assert.equal(observations,1);assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
  }
});

test('cancellation during official wait and stop after an observation never submit recovery review',async t=>{
  for(const cancelled of [true,false]) {
    const f=await fixture(t);
    f.args.browser.observe=async()=>{
      if(cancelled)throw Object.assign(new Error('read cancelled'),{code:'OFFICIAL_READ_CANCELLED'});
      f.setStop();return f.snapshot();
    };
    assert.deepEqual(await recoverBrowser(f.args),{stopped:true});
    assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
  }
});

test('unsettled journal or retained operation evidence never enters read recovery',async t=>{
  for(const journal of [{phase:'claimed'},{phase:'settled',lease:{id:'op'}},{phase:'settled',receipt:{outcome:'unknown'}}]) {
    const f=await fixture(t);await f.journal(journal);
    assert.equal(await recoverBrowser(f.args),false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.sleeps,[]);
  }
});

test('new cloud lease, changed failure or new local journal after wait blocks review',async t=>{
  for(const change of ['lease','failure','journal']) {
    const f=await fixture(t);
    f.args.browser.observe=async()=>{
      if(change==='lease')f.plan.lease={id:'new-op'};
      if(change==='failure')f.plan.globalFailureId='new-failure';
      if(change==='journal')await f.journal({phase:'attempting'});
      return f.snapshot();
    };
    assert.equal(await recoverBrowser(f.args),false);
    assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
  }
});

test('recovery review RPC failures are never retried or reclassified',async t=>{
  const f=await fixture(t);let reviews=0;
  const original=f.args.portal.call,error=Object.assign(new Error('write result unknown'),{failureCode:'browser_unavailable'});
  f.args.portal.call=async(name,args)=>{
    if(name==='review_seat_failure'){reviews++;throw error;}
    return original(name,args);
  };
  await assert.rejects(recoverBrowser(f.args),actual=>actual===error);assert.equal(reviews,1);
});

test('main propagates recovery controls and records cancellation without claiming browser recovery',async()=>{
  const error=Object.assign(new Error('original unavailable'),{failureCode:'browser_unavailable'});
  const shouldStop=async()=>true,saveStatus=async()=>{};
  let passed;
  const result=await recoverBatchError({error,shouldStop,saveStatus,config:{liveActions:true},
    recoverBrowserFn:async args=>{passed=args;return {stopped:true};}});
  assert.equal(passed.shouldStop,shouldStop);assert.equal(passed.saveStatus,saveStatus);
  assert.equal(passed.config.liveActions,true);
  assert.deepEqual(result,{mode:'idle',actions:[],stopped:true,modelCalls:0});
});

test('separate browser progress callback preserves the previous failure status until actual completion',async()=>{
  const error=Object.assign(new Error('official unavailable'),{failureCode:'browser_unavailable'});
  const original={checkedAt:'2026-10-28T04:00:00.000Z',state:'blocked',modelCalls:0,
    error:'official unavailable',failureCode:'browser_unavailable'};
  let status=structuredClone(original);const progress=[];
  const options={error,clock:()=>new Date(original.checkedAt),saveStatus:async value=>{status=value;},saveBrowserProgress:async value=>progress.push(value),
    recoverBrowserFn:async({saveStatus})=>{await saveStatus({state:'recovering',phase:'backoff'});return false;}};
  await assert.rejects(recoverBatchError(options),actual=>actual===error);
  assert.deepEqual(status,original);assert.deepEqual(progress,[{state:'recovering',phase:'backoff'}]);
  const stopped=await recoverBatchError({...options,
    recoverBrowserFn:async({saveStatus})=>{await saveStatus({state:'recovering',phase:'stopped'});return {stopped:true};}});
  assert.deepEqual(status,original);assert.equal(stopped.stopped,true);assert.equal(stopped.mode,'idle');
  assert.notEqual(stopped.mode,'browser_recovered');
});

test('first actual browser fault replaces prior idle before recovery can start or be interrupted',async()=>{
  const error=Object.assign(new Error('actual original browser failure'),{failureCode:'browser_unavailable'});
  let status={mode:'idle',checkedAt:'2026-10-28T03:59:00.000Z'};
  const writes=[],progress=[];
  const result=await recoverBatchError({error,config:{liveActions:true},clock:()=>new Date('2026-10-28T04:00:00Z'),
    saveStatus:async value=>{writes.push(value);status=value;},saveBrowserProgress:async value=>progress.push(value),
    recoverBrowserFn:async({saveStatus})=>{
      assert.equal(status.state,'blocked');assert.equal(status.failureCode,'browser_unavailable');
      assert.equal(status.error,error.message);assert.equal(status.checkedAt,'2026-10-28T04:00:00.000Z');
      await saveStatus({phase:'backoff',state:'recovering'});return {stopped:true};
    }});
  assert.equal(writes.length,1);assert.equal(status.state,'blocked');assert.equal(status.modelCalls,0);
  assert.equal(status.liveActions,true);assert.deepEqual(progress,[{phase:'backoff',state:'recovering'}]);
  assert.equal(result.stopped,true);assert.notEqual(result.mode,'browser_recovered');
});
