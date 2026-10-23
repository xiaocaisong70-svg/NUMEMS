import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertTestInviteResume,resumeTestInvite} from '../scripts/agentless/resume-test-invite.mjs';
import {validateConfig,ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';
import {Journal,readJson,atomicJson} from '../scripts/agentless/journal.mjs';
import {hostArguments} from '../scripts/agentless/host.mjs';
import {createState} from '../lib/seat-engine.ts';
import {observeWorkspace,prepareTest,workPlan,claimOperation,completeOperation,reviewFailure} from '../lib/codex-bridge.ts';
import {applyReminderPolicy} from '../lib/reminder-policy.ts';
import {bridgeObservation} from '../scripts/seat-executor/inventory.mjs';

const EMAIL='hit_wangning@outlook.com';
const config=validateConfig({liveActions:true,legacyCheckerDisabled:true});
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-resume-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'operation.json'),journal=new Journal(file),events=[];
  let ms=Date.parse('2026-10-23T12:00:00.000Z');
  const now=()=>new Date(ms).toISOString();
  const snapshot={workspaceId:WORKSPACE,workspaceName:'My Workspace',accountEmail:ADMIN,
    complete:true,totalSeats:4,seatLabel:'高级',observedAt:now(),
    pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,
    members:[{email:ADMIN,role:'owner',seatLabel:'高级'}],invites:[]};
  let state=applyReminderPolicy(createState(now()),'in_app');
  state=observeWorkspace(state,bridgeObservation(snapshot),now());
  state=prepareTest(state,now());
  const request=state.requests.find(r=>r.isTest);
  state=claimOperation(state,'invite',request.id,'original-private-token',now());
  const lease=structuredClone(state.codex.lease);
  await journal.prepare({kind:'invite',targetId:request.id,email:EMAIL});
  await journal.claimed(lease);
  state=completeOperation(state,{operationId:lease.id,token:lease.token,outcome:'blocked',failureCode:'unknown'},now());
  // The server retains the same lease even past its nominal expiration; never create a replacement.
  ms+=180_000;
  for(const method of ['attempting','evidence','settled']) {
    const original=journal[method].bind(journal);
    journal[method]=async(...args)=>{events.push(`journal.${method}`);return original(...args);};
  }
  let sends=0,statusReads=0,observations=0;
  const portal={async call(name,args={}) {
    events.push(name);
    if(name==='seat_portal_status'){statusReads++;await hooks.status?.(statusReads);}
    else if(name==='complete_seat_operation') {
      await hooks.complete?.(args);
      state=completeOperation(state,args,now());
    } else if(name==='review_seat_failure') {
      assert.equal(args.decision,'resume_workspace');
      state=reviewFailure(state,args,now());
    } else assert.fail(`Unexpected operation ${name}`);
    return {plan:workPlan(state,now())};
  }};
  const browser={async observe() {
    events.push('observe');observations++;ms+=1000;
    await hooks.observe?.(observations);
    snapshot.observedAt=now();return structuredClone(snapshot);
  },async invite(email,before) {
    events.push('prepare-invite');assert.equal(email,EMAIL);assert.equal(before.invites.length,0);
    await hooks.beforeAction?.();
    await this.onExternalAction();
    assert.equal((await readJson(file)).phase,'attempting','durable barrier before real Send');
    events.push('send');sends++;ms+=1000;
    snapshot.invites.push({email:EMAIL,role:'member',seatLabel:'高级'});
    if(hooks.afterAction)await hooks.afterAction();
    return now();
  }};
  const hooks={};
  return {directory,file,journal,portal,browser,config,events,hooks,lease,snapshot,clock:()=>ms,
    get sends(){return sends;},get state(){return state;},set state(value){state=value;},
    plan:()=>workPlan(state,now())};
}

test('explicit test resume sends once under original lease, verifies, settles, then reviews unknown pause',async t=>{
  const f=await fixture(t);
  const result=await resumeTestInvite(f);
  assert.deepEqual(result,{requestId:f.lease.requestId,outcome:'verified',workspaceResumed:true,modelCalls:0});
  assert.equal(f.sends,1);assert.equal((await readJson(f.file)).phase,'settled');
  assert.equal(f.state.codex.lease,undefined);assert.equal(f.state.codex.globalFailureCode,undefined);
  assert.equal(f.state.codex.receipts[0].id,f.lease.id);
  assert.equal(f.state.codex.receipts[0].kind,'invite');
  assert.ok(f.events.indexOf('journal.attempting')<f.events.indexOf('send'));
  assert.ok(f.events.indexOf('journal.evidence')<f.events.indexOf('complete_seat_operation'));
  assert.ok(f.events.indexOf('journal.settled')<f.events.indexOf('review_seat_failure'));
  assert.equal(f.events.filter(e=>e==='observe').length,3);
  assert.doesNotMatch(JSON.stringify(result),/original-private-token|token/);
  assert.equal(f.state.codex.testOnly,true);
  await assert.rejects(resumeTestInvite(f));assert.equal(f.sends,1);
});

test('only exact unattempted test claimed records qualify, never production or isolated approval',async t=>{
  const f=await fixture(t),basePlan=f.plan(),baseLocal=await readJson(f.file);
  const mutations=[
    ({p})=>p.enabled=false,({p})=>p.testOnly=false,({p})=>p.busy=false,
    ({p})=>p.administrator='other@example.com',({p})=>p.workspaceId='other',
    ({p})=>p.globalFailureCode='approval_required',({p})=>p.globalFailureCode='capacity_mismatch',
    ({p})=>p.globalFailureCode=null,({p})=>p.mailChannelError='mail failed',
    ({p})=>p.blockedOperations=[{code:'approval_required',operation:p.lease}],
    ({p})=>p.lease=null,({p})=>p.lease.token='different',({p})=>p.lease.originalPresence='invite',
    ({p})=>p.lease.kind='remove',({p})=>p.lease.email='another@example.com',
    ({p})=>p.invites[0].isTest=false,({p})=>p.invites[0].status='cancelled',
    ({p})=>p.receipts=[{id:p.lease.id}],
    ({j})=>j.phase='attempting',({j})=>j.phase='completing',({j})=>j.phase='settled',
    ({j})=>j.receipt={outcome:'verified'},({j})=>j.lease.status='uncertain',
    ({j})=>j.lease.id='changed',({j})=>j.target.targetId='different',
    ({c})=>c.liveActions=false,({c})=>c.legacyCheckerDisabled=false,
  ];
  for(const mutate of mutations){
    const x={p:structuredClone(basePlan),j:structuredClone(baseLocal),c:{...config}};mutate(x);
    assert.throws(()=>assertTestInviteResume(x.p,x.j,x.c));
  }
  assert.equal(f.sends,0);
});

test('full fresh official evidence rejects existing target, unknown roles or no paid capacity',async t=>{
  for(const kind of ['invite','member','extra-admin','capacity','owner','wrong-seat','wrong-workspace','incomplete']){
    const f=await fixture(t);
    if(kind==='invite')f.snapshot.invites.push({email:EMAIL,role:'member',seatLabel:'高级'});
    if(kind==='member')f.snapshot.members.push({email:EMAIL,role:'member',seatLabel:'高级'});
    if(kind==='extra-admin')f.snapshot.members.push({email:'admin@example.com',role:'admin',seatLabel:'高级'});
    if(kind==='capacity')for(let i=0;i<3;i++)f.snapshot.members.push({email:`person${i}@example.com`,role:'member',seatLabel:'高级'});
    if(kind==='owner')f.snapshot.members[0].role='member';
    if(kind==='wrong-seat')f.snapshot.totalSeats=5;
    if(kind==='wrong-workspace')f.snapshot.workspaceId='other';
    if(kind==='incomplete')f.snapshot.complete=false;
    await assert.rejects(resumeTestInvite(f));assert.equal(f.sends,0);
    assert.equal((await readJson(f.file)).phase,'claimed');
    assert.equal(f.events.filter(e=>e==='complete_seat_operation').length,0);
  }
});

test('changed cloud lease during official reads or final send callback blocks all sends',async t=>{
  for(const read of [2,3]) {
    const f=await fixture(t);
    f.hooks.status=n=>{if(n===read)f.state.codex.lease.token='remote-change';};
    await assert.rejects(resumeTestInvite(f));assert.equal(f.sends,0);
    assert.equal((await readJson(f.file)).phase,'claimed');
    assert.ok(!f.events.includes('journal.attempting'));
  }
});

test('uncertain send keeps attempting and original lease, and cannot be retried',async t=>{
  const f=await fixture(t);f.hooks.afterAction=()=>{throw new Error('result unknown');};
  await assert.rejects(resumeTestInvite(f),/result unknown/);
  assert.equal(f.sends,1);assert.equal((await readJson(f.file)).phase,'attempting');
  assert.equal(f.state.codex.lease.id,f.lease.id);assert.equal(f.state.codex.globalFailureCode,'unknown');
  await assert.rejects(resumeTestInvite(f));assert.equal(f.sends,1);
  assert.ok(!f.events.includes('review_seat_failure'));
});

test('approval rejection is isolated and is never retried through resume command',async t=>{
  const f=await fixture(t);
  f.hooks.beforeAction=()=>{const e=new Error('approval rejected');e.failureCode='approval_required';throw e;};
  await assert.rejects(resumeTestInvite(f),/approval rejected/);
  assert.equal(f.sends,0);assert.equal(f.state.codex.holds[0].code,'approval_required');
  assert.equal(f.state.codex.lease,undefined);
  assert.equal((await readJson(f.file)).phase,'claimed');
  await assert.rejects(resumeTestInvite(f));assert.equal(f.sends,0);
});

test('unknown completion retains completing evidence and never settles or repeats send',async t=>{
  const f=await fixture(t);f.hooks.complete=args=>{if(args.outcome==='verified')throw new Error('receipt response lost');};
  await assert.rejects(resumeTestInvite(f),/receipt response lost/);
  const local=await readJson(f.file);
  assert.equal(local.phase,'completing');assert.equal(local.receipt.operationId,f.lease.id);
  assert.equal(f.sends,1);assert.ok(!f.events.includes('journal.settled'));
  await assert.rejects(resumeTestInvite(f));assert.equal(f.sends,1);
});

test('new failure after successful receipt cannot be cleared by workspace review',async t=>{
  const f=await fixture(t);
  f.hooks.observe=n=>{if(n===3)f.state.codex.globalFailureCode='role_mismatch';};
  await assert.rejects(resumeTestInvite(f),/工作空间状态/);
  assert.equal((await readJson(f.file)).phase,'settled');
  assert.equal(f.state.codex.globalFailureCode,'role_mismatch');
  assert.ok(!f.events.includes('review_seat_failure'));
});

test('fixed host entry accepts no email, lease token, request id or arbitrary payload',()=>{
  assert.ok(hostArguments(['admin','resume-test-invite']).includes('resume-test-invite'));
  for(const value of ['req_123',EMAIL,'original-private-token','--force'])
    assert.throws(()=>hostArguments(['admin','resume-test-invite',value]));
});
