import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertTestWorkspaceReview,reviewTestWorkspace} from '../scripts/agentless/review-test-workspace.mjs';
import {validateConfig,ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {hostArguments} from '../scripts/agentless/host.mjs';
import {createState} from '../lib/seat-engine.ts';
import {observeWorkspace,prepareTest,workPlan,deferOperation,reviewFailure} from '../lib/codex-bridge.ts';
import {applyReminderPolicy} from '../lib/reminder-policy.ts';
import {bridgeObservation} from '../scripts/seat-executor/inventory.mjs';

const config=validateConfig({liveActions:false,legacyCheckerDisabled:true});
async function fixture(t,{missingJournal=false}={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-review-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journalFile=path.join(directory,'operation.json'),calls=[];
  if(!missingJournal)await atomicJson(journalFile,{phase:'settled',updatedAt:'2026-10-23T12:00:00.000Z'});
  let ms=Date.parse('2026-10-23T12:00:00.000Z');
  const now=()=>new Date(ms).toISOString();
  const snapshot={workspaceId:WORKSPACE,workspaceName:'My Workspace',accountEmail:ADMIN,
    complete:true,totalSeats:4,seatLabel:'高级',observedAt:now(),
    pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,
    members:[{email:ADMIN,role:'owner',seatLabel:'高级'}],invites:[]};
  let state=applyReminderPolicy(createState(now()),'in_app');
  state=observeWorkspace(state,bridgeObservation(snapshot),now());state=prepareTest(state,now());
  state=deferOperation(state,{kind:'invite',targetId:state.requests.find(r=>r.isTest).id,
    failureCode:'unknown',detail:'官方完整名单核对失败；未开始成员写入。'},now());
  let reads=0,observations=0;
  const hooks={};
  const portal={async call(name,args={}) {
    calls.push(name);
    if(name==='seat_portal_status'){reads++;await hooks.status?.(reads);}
    else if(name==='review_seat_failure') {
      assert.equal(args.decision,'resume_workspace');
      state=reviewFailure(state,args,now());await hooks.review?.();
    } else assert.fail(`No claim, receipt or action endpoint allowed: ${name}`);
    return {plan:workPlan(state,now())};
  }};
  const browser={async observe() {
    calls.push('observe');observations++;ms+=1000;
    snapshot.observedAt=now();await hooks.observe?.(observations);
    return structuredClone(snapshot);
  },invite(){assert.fail('read-only review must not invite');},remove(){assert.fail('read-only review must not remove');}};
  return {portal,browser,config,journalFile,calls,hooks,snapshot,clock:()=>ms,
    advance(value){ms+=value;},get state(){return state;},set state(value){state=value;},plan:()=>workPlan(state,now())};
}

test('explicit preclaim test review requires two full snapshots and never changes settled journal',async t=>{
  const f=await fixture(t),before=await readFile(f.journalFile,'utf8');
  const result=await reviewTestWorkspace(f);
  assert.deepEqual(result,{outcome:'reviewed',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0});
  assert.deepEqual(f.calls,['seat_portal_status','observe','seat_portal_status','observe','seat_portal_status','review_seat_failure']);
  assert.equal(f.state.codex.globalFailureCode,undefined);assert.equal(f.state.codex.lastError,undefined);
  assert.equal(f.state.codex.lease,undefined);assert.deepEqual(f.state.codex.receipts,[]);
  assert.equal(f.state.codex.testOnly,true);assert.equal(await readFile(f.journalFile,'utf8'),before);
});

test('absent local journal is permitted without manufacturing a settled record',async t=>{
  const f=await fixture(t,{missingJournal:true});await reviewTestWorkspace(f);
  assert.equal(await readJson(f.journalFile),null);
});

test('production, other diagnostics, approvals, invalid config and unsettled logs cannot qualify',async t=>{
  const f=await fixture(t),base=f.plan();
  const mutations=[
    x=>x.p.testOnly=false,x=>x.p.enabled=false,x=>x.p.busy=true,x=>x.p.lease={id:'active'},
    x=>x.p.administrator='other@example.com',x=>x.p.workspaceId='other',
    x=>x.p.globalFailureCode='approval_required',x=>x.p.globalFailureCode='role_mismatch',
    x=>x.p.globalFailureCode='browser_unavailable',x=>x.p.lastError='another unknown result',
    x=>x.p.lastError+=' ',x=>x.p.blockedOperations=[{code:'approval_required'}],
    x=>x.p.blockedOperations=undefined,x=>x.p.mailChannelError='failed',
    x=>x.j={phase:'claimed'},x=>x.j={phase:'attempting'},x=>x.j={phase:'completing'},
    x=>x.j={phase:'settled',lease:{id:'inconsistent'}},x=>x.j={phase:'settled',receipt:{}},
    x=>x.c.liveActions=true,x=>x.c.legacyCheckerDisabled=false,
    x=>x.c.adminEmail='other@example.com',x=>x.c.workspaceId='other',x=>x.c.totalSeats=5,
  ];
  for(const mutate of mutations){
    const x={p:structuredClone(base),j:{phase:'settled'},c:{...config}};mutate(x);
    assert.throws(()=>assertTestWorkspaceReview(x.p,x.j,x.c));
  }
  assert.equal(f.calls.length,0);
});

test('changed lease, plan or journal during either official read preserves pause',async t=>{
  for(const index of [1,2])for(const change of ['lease','journal','settled-log','plan']) {
    const f=await fixture(t);
    f.hooks.observe=async n=>{
      if(n!==index)return;
      if(change==='lease')f.state.codex.lease={id:'new-lease'};
      else if(change==='journal')await atomicJson(f.journalFile,{phase:'attempting'});
      else if(change==='settled-log')await atomicJson(f.journalFile,{phase:'settled',updatedAt:'changed'});
      else f.state.codex.lastRunAt='2026-10-23T12:00:30.000Z';
    };
    await assert.rejects(reviewTestWorkspace(f));
    assert.ok(!f.calls.includes('review_seat_failure'));
    assert.equal(f.state.codex.globalFailureCode,'unknown');
  }
});

test('each full snapshot retains strict account, Owner, capacity and completeness checks',async t=>{
  for(const index of [1,2])for(const change of ['account','owner','admin','capacity','workspace','complete','source']) {
    const f=await fixture(t);
    f.hooks.observe=n=>{
      if(n!==index)return;
      if(change==='account')f.snapshot.accountEmail='other@example.com';
      if(change==='owner')f.snapshot.members[0].role='member';
      if(change==='admin')f.snapshot.members.push({email:'admin@example.com',role:'admin',seatLabel:'高级'});
      if(change==='capacity')f.snapshot.totalSeats=5;
      if(change==='workspace')f.snapshot.workspaceId='other';
      if(change==='complete')f.snapshot.complete=false;
      if(change==='source')f.snapshot.pageUrl='https://example.com/members';
    };
    await assert.rejects(reviewTestWorkspace(f));assert.ok(!f.calls.includes('review_seat_failure'));
  }
});

test('expired first snapshot or backward second snapshot cannot authorize review',async t=>{
  for(const drift of ['stale','backward']) {
    const f=await fixture(t);
    f.hooks.observe=n=>{
      if(n===2 && drift==='stale'){f.advance(61_000);f.snapshot.observedAt=new Date(f.clock()).toISOString();}
      if(n===2 && drift==='backward')f.snapshot.observedAt='2026-10-23T12:00:00.000Z';
    };
    await assert.rejects(reviewTestWorkspace(f));assert.ok(!f.calls.includes('review_seat_failure'));
  }
});

test('new backend failure in review result is not misreported as recovered',async t=>{
  const f=await fixture(t);f.hooks.review=()=>{f.state.codex.globalFailureCode='role_mismatch';};
  await assert.rejects(reviewTestWorkspace(f));
  assert.equal(f.state.codex.globalFailureCode,'role_mismatch');
});

test('review is a fixed no-argument administrator entry',()=>{
  assert.ok(hostArguments(['admin','review-test-workspace']).includes('review-test-workspace'));
  for(const value of ['req_123','--force','someone@example.com'])
    assert.throws(()=>hostArguments(['admin','review-test-workspace',value]));
});
