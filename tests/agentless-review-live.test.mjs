import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertLiveWorkspaceReview,reviewLiveWorkspace} from '../scripts/agentless/review-live-workspace.mjs';
import {validateConfig,ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {hostArguments} from '../scripts/agentless/host.mjs';
import {createState,transition} from '../lib/seat-engine.ts';
import {observeWorkspace,workPlan,deferOperation,reviewFailure} from '../lib/codex-bridge.ts';
import {bridgeObservation} from '../scripts/seat-executor/inventory.mjs';

const email='person@example.com',owner={userId:'owner',email:ADMIN,isAdmin:true};
const person={userId:'person',email,isAdmin:false};
const config=validateConfig({liveActions:true,legacyCheckerDisabled:true});
async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-live-review-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const journalFile=path.join(dir,'operation.json'),statusFile=path.join(dir,'status.json');
  await atomicJson(journalFile,{phase:'settled',updatedAt:'2026-10-27T09:20:00.000Z'});
  await atomicJson(statusFile,{checkedAt:'2026-10-27T09:05:00.000Z',state:'blocked',modelCalls:0,
    failureCode:'unknown',error:'读取成员及邀请数与席位已分配数不一致，可能存在分页或加载变化。'});
  let ms=Date.parse('2026-10-27T09:00:00.000Z');const now=()=>new Date(ms).toISOString();
  const snapshot={workspaceId:WORKSPACE,workspaceName:'My Workspace',accountEmail:ADMIN,
    complete:true,totalSeats:4,seatLabel:'高级',observedAt:now(),
    pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,
    members:[{email:ADMIN,role:'owner',seatLabel:'高级'}],invites:[]};
  let state=observeWorkspace(createState(now()),bridgeObservation(snapshot),now());
  state=transition(state,owner,{type:'configure',config:{automationEnabled:true,whitelist:[email]}},now());
  state.codex.enabled=true;state.codex.testOnly=false;state.codex.mailEnabled=false;
  state=transition(state,person,{type:'apply',name:'Person',reason:'work',hours:1},now());
  state=transition(state,owner,{type:'tick'},now());
  state=transition(state,owner,{type:'confirm_invited',id:state.requests[0].id},now());
  ms+=301_000;state=transition(state,owner,{type:'tick'},now());
  state=deferOperation(state,{kind:'remove',targetId:state.requests[0].id,failureCode:'unknown',
    detail:'官方完整名单核对失败；未开始成员写入。'},now());
  snapshot.members.push({email,role:'member',seatLabel:'高级'});
  const calls=[],hooks={};let observations=0,reads=0;
  const portal={async call(name,args={}){
    calls.push(name);
    if(name==='seat_portal_status'){reads++;await hooks.status?.(reads);}
    else if(name==='review_seat_failure'){
      assert.equal(args.decision,'resume_preclaim_inventory');await hooks.beforeReview?.();
      state=reviewFailure(state,args,now());await hooks.review?.();
    }else assert.fail('no claim, invitation, removal or receipt allowed');
    return {plan:workPlan(state,now())};
  }};
  const browser={async observe(){calls.push('observe');observations++;ms+=1000;snapshot.observedAt=now();
    await hooks.observe?.(observations);return structuredClone(snapshot);},
    invite(){assert.fail('review must not invite');},remove(){assert.fail('review must not remove');}};
  return {portal,browser,config,journalFile,statusFile,calls,hooks,snapshot,clock:()=>ms,
    get state(){return state;},set state(value){state=value;},plan:()=>workPlan(state,now())};
}

test('production recovery reviews stable evidence twice and activates joined target without external action',async t=>{
  const f=await fixture(t),before=await readFile(f.journalFile,'utf8');
  const result=await reviewLiveWorkspace(f);
  assert.deepEqual(result,{outcome:'reviewed',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0});
  assert.deepEqual(f.calls,['seat_portal_status','observe','seat_portal_status','observe','seat_portal_status','review_seat_failure','seat_portal_status']);
  assert.equal(f.state.requests[0].status,'active');
  assert.equal(f.state.requests[0].expiresAt,new Date(f.clock()+3_600_000).toISOString());
  assert.equal(f.state.codex.globalFailureCode,undefined);assert.equal(f.state.codex.lease,undefined);
  assert.equal(await readFile(f.journalFile,'utf8'),before);
  const status=await readJson(f.statusFile);assert.equal(status.mode,'idle');assert.equal(status.state,undefined);
  assert.ok(status.reviewEvidence.failureId);assert.equal(status.modelCalls,0);
});

test('new same-text fault between final plan read and server transaction is rejected atomically',async t=>{
  const f=await fixture(t),old=f.plan().globalFailureId;
  f.hooks.beforeReview=()=>{f.state=deferOperation(f.state,{kind:'remove',targetId:f.state.requests[0].id,
    failureCode:'unknown',detail:'官方完整名单核对失败；未开始成员写入。'},new Date(f.clock()).toISOString());};
  await assert.rejects(reviewLiveWorkspace(f),/故障已变化/);
  assert.notEqual(f.plan().globalFailureId,old);assert.equal(f.plan().globalFailureCode,'unknown');
  assert.equal((await readJson(f.statusFile)).state,'blocked');
});

test('local status write failure leaves blocked status and never starts a member operation',async t=>{
  const f=await fixture(t);f.writeStatus=async()=>{throw new Error('disk failure');};
  await assert.rejects(reviewLiveWorkspace(f),/disk failure/);
  assert.equal((await readJson(f.statusFile)).state,'blocked');
  assert.ok(!f.calls.includes('claim_seat_operation'));
});

test('production recovery never re-enables test mode, clears other errors or skips settled journal',async t=>{
  const f=await fixture(t),base=f.plan();
  const mutations=[
    x=>x.p.testOnly=true,x=>x.p.enabled=false,x=>x.p.busy=true,x=>x.p.lease={id:'x'},
    x=>x.p.administrator='other@example.com',x=>x.p.workspaceId='wrong',
    x=>x.p.globalFailureCode='approval_required',x=>x.p.globalFailureCode='capacity_mismatch',
    x=>x.p.lastError='another error',x=>x.p.blockedOperations=[{code:'member_action'}],
    x=>x.p.mailChannelError='failed',x=>x.j=null,x=>x.j={phase:'claimed'},x=>x.j={phase:'attempting'},
    x=>x.j={phase:'settled',lease:{id:'x'}},x=>x.j={phase:'settled',receipt:{}},
    x=>x.c.liveActions=false,x=>x.c.legacyCheckerDisabled=false,x=>x.c.totalSeats=5,
  ];
  for(const mutate of mutations){const x={p:structuredClone(base),j:{phase:'settled'},c:{...config}};
    mutate(x);assert.throws(()=>assertLiveWorkspaceReview(x.p,x.j,x.c));}
});

test('changed plan, journal or changed official inventory aborts before review',async t=>{
  for(const change of ['plan','journal','inventory','role','capacity','incomplete']){
    const f=await fixture(t);f.hooks.observe=async n=>{if(n!==2)return;
      if(change==='plan')f.state.codex.lastRunAt='2026-10-27T09:05:01.000Z';
      if(change==='journal')await atomicJson(f.journalFile,{phase:'attempting'});
      if(change==='inventory')f.snapshot.members.pop();
      if(change==='role')f.snapshot.members[1].role='admin';
      if(change==='capacity')f.snapshot.totalSeats=5;
      if(change==='incomplete')f.snapshot.complete=false;
    };
    await assert.rejects(reviewLiveWorkspace(f));assert.ok(!f.calls.includes('review_seat_failure'));
    assert.equal(f.state.codex.globalFailureCode,'unknown');
  }
});

test('production review fixed host command accepts no email, request id or force flag',()=>{
  assert.ok(hostArguments(['admin','review-live-workspace']).includes('review-live-workspace'));
  for(const value of ['req_123',email,'--force'])assert.throws(()=>hostArguments(['admin','review-live-workspace',value]));
});
