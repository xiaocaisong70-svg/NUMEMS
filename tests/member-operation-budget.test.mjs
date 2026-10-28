import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runBatch,MEMBER_OPERATION_BUDGETS} from '../scripts/agentless/core.mjs';
import {Journal,readJson} from '../scripts/agentless/journal.mjs';
import {BrowserAdapter,InventoryMismatchError} from '../scripts/seat-executor/browser.mjs';
import {AgentlessBrowser} from '../scripts/agentless/browser.mjs';
import {localContextRecoveryEligible} from '../scripts/agentless/main.mjs';
import {diagnoseHealthEvidence} from '../scripts/agentless/health-cycle.mjs';

const base=Date.parse('2026-10-29T12:00:00Z');
async function fixture(t,{kind='invite',count=1}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-v14-operation-'));
  t.after(async()=>{const rel=path.relative(os.tmpdir(),dir);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
  let elapsed=0,stop=false;const now=()=>base+elapsed,at=()=>new Date(now()).toISOString();
  const config={workspaceId:'workspace',adminEmail:'owner@example.com',liveActions:true,legacyCheckerDisabled:true,
    workspaceName:'My Workspace',seatLabel:'高级',totalSeats:4,mailMode:'in_app',maxItems:6};
  const target=i=>({id:`req_fixture_${i}`,email:`staff${i}@example.com`});
  const targets=Array.from({length:count},(_,i)=>target(i));
  const physical={members:kind==='remove'?targets.map(r=>r.email):[],invites:[]};
  const plan={workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,testOnly:false,busy:false,lease:null,
    invites:kind==='invite'?targets:[],removals:kind==='remove'?targets:[],awaitingAcceptance:[],blockedOperations:[],receipts:[]};
  const calls=[],reads=[],writes=[];let leaseSerial=0;
  const snapshot=()=>({complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,accountEmail:config.adminEmail,
    seatLabel:config.seatLabel,totalSeats:4,observedAt:at(),pageUrl:'https://admin.openai.com/workspace/workspace/members',
    members:[{email:config.adminEmail,role:'owner',seatLabel:config.seatLabel},...physical.members.map(email=>({email,role:'member',seatLabel:config.seatLabel}))],
    invites:physical.invites.map(email=>({email,role:'member',seatLabel:config.seatLabel}))});
  const portal={async refreshQueue(){return {mailMode:'in_app'};},async call(name,args={},controls){
    calls.push({name,args,controls});
    if(name==='claim_seat_operation'){
      const r=[...plan.invites,...plan.removals].find(r=>r.id===args.targetId);
      plan.lease={id:`op_fixture_${++leaseSerial}`,token:`token_${leaseSerial}`,kind:args.kind,targetId:r.id,email:r.email,claimedAt:at(),
        originalPresence:physical.members.includes(r.email)?'member':physical.invites.includes(r.email)?'invite':'absent'};
    }
    if(name==='complete_seat_operation'){
      if(['verified','joined'].includes(args.outcome)){
        plan.receipts.push({id:args.operationId});plan.invites=plan.invites.filter(r=>r.id!==plan.lease.targetId);
        plan.removals=plan.removals.filter(r=>r.id!==plan.lease.targetId);plan.lease=null;
      }else{plan.lease.status='uncertain';plan.globalFailureCode=args.failureCode;plan.lastError=args.detail;}
    }
    if(name==='defer_seat_operation'){plan.globalFailureCode=args.failureCode;plan.lastError=args.detail;}
    return {plan:structuredClone(plan)};
  }};
  const browser={async observe(options){reads.push(options);return snapshot();},
    async invite(email,_snapshot,options){await this.onExternalAction();writes.push({kind:'invite',email,options});physical.invites.push(email);
      const invitationSentAt=at();await this.onExternalActionCommitted({kind:'invite',email,invitationSentAt});return invitationSentAt;},
    async remove(email,_snapshot,options){await this.onExternalAction();writes.push({kind:'remove',email,options});
      physical.members=physical.members.filter(x=>x!==email);physical.invites=physical.invites.filter(x=>x!==email);}};
  const journal=new Journal(path.join(dir,'operation.json'));
  const args={portal,browser,config,journal,clock:()=>new Date(now()),pause:async ms=>{elapsed+=ms;},shouldStop:async()=>stop};
  return {args,portal,browser,journal,plan,physical,calls,reads,writes,snapshot,now,at,
    advance:ms=>{elapsed+=ms;},stop:()=>{stop=true;}};
}

test('ordinary target shares a 120 second deadline and performs one external write',async t=>{
  const f=await fixture(t);await runBatch(f.args);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].options.budgetMs,35000);
  assert.ok(f.reads.every(o=>o.deadlineAt<=base+MEMBER_OPERATION_BUDGETS.totalMs));
  assert.deepEqual(f.reads.map(o=>o.budgetMs),[40000,25000,35000]);
  assert.equal(f.calls.filter(c=>c.name==='claim_seat_operation').length,1);
  assert.equal(f.calls.filter(c=>c.name==='complete_seat_operation').length,1);
});

test('invitation commit timestamp is journaled before a later dialog timeout and preserved in success receipt',async t=>{
  const f=await fixture(t);let committed;
  f.browser.invite=async function(email,_snapshot,options){await this.onExternalAction();f.writes.push({kind:'invite',options});
    f.advance(1500);committed=f.at();f.physical.invites.push(email);await this.onExternalActionCommitted({kind:'invite',email,invitationSentAt:committed});
    const j=await readJson(f.journal.file);assert.equal(j.phase,'attempting');assert.equal(j.submission.invitationSentAt,committed);
    f.advance(2000);throw Object.assign(new Error('dialog did not close'),{name:'TimeoutError'});};
  const result=await runBatch(f.args);assert.equal(result.actions[0].outcome,'verified');assert.equal(f.writes.length,1);
  const receipt=f.calls.find(c=>c.name==='complete_seat_operation').args;assert.equal(receipt.invitationSentAt,committed);
  const settled=await readJson(f.journal.file);assert.equal(settled.phase,'settled');assert.equal(settled.submission,undefined);
});

test('eventual official state is checked twice without replaying the external action',async t=>{
  const f=await fixture(t);let read=0;
  f.browser.observe=async options=>{f.reads.push(options);read++;if(read===3)f.physical.invites=[];
    if(read===4)f.physical.invites=['staff0@example.com'];return f.snapshot();};
  const result=await runBatch(f.args);assert.equal(result.actions[0].outcome,'verified');assert.equal(f.writes.length,1);
  assert.equal(read,4);assert.ok(f.reads[2].deadlineAt===f.reads[3].deadlineAt);
});

test('three immediate then 1s/3s catch reads retain prior recovery behavior under one verification deadline',async t=>{
  const f=await fixture(t);let read=0;const pauses=[];
  f.args.pause=async ms=>{pauses.push(ms);f.advance(ms);};
  f.browser.observe=async options=>{f.reads.push(options);read++;f.advance(5000);
    if([3,4,5].includes(read))throw Object.assign(new Error('bounded incomplete provider list'),{failureCode:'browser_unavailable'});
    return f.snapshot();};
  assert.equal((await runBatch(f.args)).actions[0].outcome,'verified');
  assert.equal(read,6);assert.deepEqual(pauses,[1000,3000]);assert.equal(f.writes.length,1);
  assert.equal(new Set(f.reads.slice(2).map(r=>r.deadlineAt)).size,1);
  assert.ok(f.now()<base+MEMBER_OPERATION_BUDGETS.totalMs);
});

test('restored catch retries cannot exceed the shared 35 second phase or replay the write',async t=>{
  const f=await fixture(t);let read=0;
  f.browser.observe=async options=>{f.reads.push(options);read++;
    if(read>=3){f.advance(Math.min(12000,options.budgetMs));throw Object.assign(new Error('still loading'),{failureCode:'browser_unavailable'});}
    return f.snapshot();};
  await assert.rejects(runBatch(f.args),error=>error.failureCode==='unknown');
  assert.equal(f.now(),base+35000);assert.equal(read,5);assert.equal(f.writes.length,1);
  assert.equal(f.plan.lease.status,'uncertain');assert.ok((await readJson(f.journal.file)).lease);
});

test('a full deadline after a possible submission preserves the original unknown lease and cannot replay',async t=>{
  const f=await fixture(t);
  f.browser.invite=async function(email,_snapshot,options){await this.onExternalAction();f.writes.push({kind:'invite',options});
    f.advance(1000);await this.onExternalActionCommitted({kind:'invite',email,invitationSentAt:f.at()});
    f.advance(120000);throw Object.assign(new Error('UI wait timed out after send'),{name:'TimeoutError'});};
  await assert.rejects(runBatch(f.args),error=>error.failureCode==='unknown');
  assert.equal(f.writes.length,1);assert.equal(f.plan.lease.status,'uncertain');assert.equal(f.plan.globalFailureCode,'unknown');
  const j=await readJson(f.journal.file);assert.equal(j.lease.id,f.plan.lease.id);assert.ok(j.submission);
  await assert.rejects(runBatch(f.args));assert.equal(f.writes.length,1);
});

test('an ambiguous completion keeps its full original receipt and never sends another completion',async t=>{
  const f=await fixture(t),call=f.portal.call.bind(f.portal);let completes=0;
  f.portal.call=async(name,...args)=>{if(name==='complete_seat_operation'){completes++;throw new Error('completion response unknown');}return call(name,...args);};
  await assert.rejects(runBatch(f.args),/回执写入未确认/);assert.equal(completes,1);assert.equal(f.writes.length,1);
  const j=await readJson(f.journal.file);assert.equal(j.phase,'completing');assert.equal(j.receipt.operationId,j.lease.id);assert.ok(j.submission);
});

test('stop before the next target prevents another claim while a completed write retains its receipt',async t=>{
  const f=await fixture(t,{count:2}),call=f.portal.call.bind(f.portal);
  f.portal.call=async(name,...args)=>{const result=await call(name,...args);if(name==='complete_seat_operation')f.stop();return result;};
  const result=await runBatch(f.args);assert.equal(result.stopped,true);assert.equal(f.writes.length,1);
  assert.equal(f.calls.filter(c=>c.name==='claim_seat_operation').length,1);assert.equal((await readJson(f.journal.file)).phase,'settled');
});

test('stop after local preparation but before claim settles only the unsent preparation',async t=>{
  const f=await fixture(t),prepare=f.journal.prepare.bind(f.journal);
  f.journal.prepare=async target=>{await prepare(target);f.stop();};
  assert.equal((await runBatch(f.args)).stopped,true);assert.equal(f.calls.some(c=>c.name==='claim_seat_operation'),false);
  assert.equal(f.writes.length,0);assert.equal((await readJson(f.journal.file)).phase,'settled');
});

test('preclaim read retry uses one shared phase deadline and never enters a member action on expiry',async t=>{
  const f=await fixture(t);let reads=0;
  f.browser.observe=async options=>{f.reads.push(options);reads++;f.advance(reads===1?20000:19000);
    if(reads===1)throw new InventoryMismatchError({total:4,assigned:2,available:2},1,0);
    throw Object.assign(new Error('incomplete within deadline'),{failureCode:'browser_unavailable'});};
  await assert.rejects(runBatch(f.args));assert.equal(reads,2);assert.equal(f.now(),base+40000);
  assert.equal(f.reads[0].deadlineAt,f.reads[1].deadlineAt);assert.equal(f.reads[1].budgetMs,19000);
  assert.equal(f.writes.length,0);assert.equal(f.plan.lease,null);assert.equal(f.plan.globalFailureCode,'browser_unavailable');
});

test('even a late successful adapter response cannot bypass the preclaim phase deadline',async t=>{
  const f=await fixture(t);f.browser.observe=async()=>{f.advance(40001);return f.snapshot();};
  await assert.rejects(runBatch(f.args),error=>error.code==='OPERATION_BUDGET_EXHAUSTED');
  assert.equal(f.writes.length,0);assert.equal(f.calls.some(c=>c.name==='claim_seat_operation'),false);
  assert.equal(f.plan.globalFailureCode,'browser_unavailable');
});

test('action deadline awaits the actual operation promise instead of leaving a racing mutation behind',async()=>{
  let instant=0,release,settled=false;const browser=new BrowserAdapter({});
  browser.inviteOnce=async()=>new Promise(resolve=>{release=resolve;});
  const result=browser.invite('staff@example.com',{}, {budgetMs:10,now:()=>instant}).finally(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));instant=100;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  release('completed');await assert.rejects(result,error=>error.failureCode==='browser_unavailable');
  assert.equal(settled,true);assert.equal(browser.readOnlyWaitControls,undefined);
});

test('pre-action desktop proof consumes the action deadline and cannot start journaling after it expires',async()=>{
  let instant=0,wrote=false;const browser=new AgentlessBrowser({workspaceId:'workspace'});
  browser.readOnlyWaitControls={deadlineAt:5000,now:()=>instant,actionKind:'invite'};
  browser.desktopProofForLaunch=async options=>{assert.equal(options.timeoutMs,5000);instant=6000;return {isolated:true};};
  browser.onExternalAction=async()=>{wrote=true;};
  await assert.rejects(browser.onExternalAction(),error=>error.failureCode==='browser_unavailable');assert.equal(wrote,false);
});

test('retained submission evidence is not a settled journal or a locally recoverable empty context',async t=>{
  const f=await fixture(t),submission={operationId:'op_retained',kind:'invite',email:'staff0@example.com',invitationSentAt:f.at()};
  await f.journal.update({phase:'settled',submission});
  await assert.rejects(f.journal.reconcile(f.plan),/未完成办理日志/);
  assert.equal(localContextRecoveryEligible(new Error('page.evaluate: Target page, context or browser has been closed'),{phase:'settled',submission}),false);
  assert.equal(diagnoseHealthEvidence({config:f.args.config,plan:{...f.plan,lastError:null,globalFailureCode:null,
    officialObservedAt:f.at(),checkedAt:f.at(),mailChannelError:null},snapshot:f.snapshot(),journalState:{phase:'settled',submission},checkedAt:f.at()}).reason,'local_operation_unsettled');
});
