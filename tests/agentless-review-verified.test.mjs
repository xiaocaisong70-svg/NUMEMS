import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createState,transition} from '../lib/seat-engine.ts';
import {observeWorkspace,claimOperation,completeOperation,deferOperation,reviewFailure,verifiedReviewReceipt,workPlan} from '../lib/codex-bridge.ts';
import {reviewVerifiedOperation,recoverVerifiedReviewIntent} from '../scripts/agentless/review-verified-operation.mjs';
import {validateConfig,ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {bridgeObservation} from '../scripts/seat-executor/inventory.mjs';
import {hostArguments} from '../scripts/agentless/host.mjs';
import {OfficialPageError} from '../scripts/seat-executor/official-readiness.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {restartDecision,reviewRetryDecision} from '../scripts/agentless/watchdog-policy.mjs';

async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-verified-review-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const journalFile=path.join(dir,'operation.json'),statusFile=path.join(dir,'status.json');
  let ms=Date.parse('2026-10-27T10:00:00Z');const now=()=>new Date(ms).toISOString();
  const owner={userId:'owner',email:ADMIN,isAdmin:true},email='person@example.com';
  const person={userId:'person',email,isAdmin:false};
  const snapshot={workspaceId:WORKSPACE,workspaceName:'My Workspace',accountEmail:ADMIN,
    complete:true,totalSeats:4,seatLabel:'高级',observedAt:now(),
    pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,
    members:[{email:ADMIN,role:'owner',seatLabel:'高级'}],invites:[]};
  let state=observeWorkspace(createState(now()),bridgeObservation(snapshot),now());
  state=transition(state,owner,{type:'configure',config:{automationEnabled:true,whitelist:[email]}},now());
  state.codex.enabled=true;state.codex.testOnly=false;state.codex.mailEnabled=false;
  state=transition(state,person,{type:'apply',name:'Person',reason:'work',hours:1},now());
  state=transition(state,owner,{type:'tick'},now());
  const requestId=state.requests[0].id;
  state=claimOperation(state,'invite',requestId,'test-token',now());const op=state.codex.lease;
  ms+=1000;state=completeOperation(state,{operationId:op.id,token:op.token,outcome:'uncertain',
    failureCode:'unknown',detail:'程序办理未完成；保留原租约和证据，不自动重做外部动作。'},now());
  // Preserve a historical incident predating explicit operation provenance.
  delete state.codex.operationFailureOrigin;
  ms+=1000;snapshot.observedAt=now();snapshot.members.push({email,role:'member',seatLabel:'高级'});
  state=completeOperation(state,{operationId:op.id,token:op.token,outcome:'verified',observation:bridgeObservation(snapshot)},now());
  await atomicJson(journalFile,{phase:'settled',createdAt:'2026-10-27T10:00:00.000Z',target:{kind:'invite',targetId:requestId,email}});
  await atomicJson(statusFile,{state:'blocked',failureCode:'browser_unavailable',checkedAt:now(),modelCalls:0});
  const config=validateConfig({liveActions:true,legacyCheckerDisabled:true});
  const hooks={},calls=[];
  const portal={async call(name,args={}){calls.push(name);if(name==='verified_review_receipt')return verifiedReviewReceipt(state,args);if(name==='review_seat_failure'){
    await hooks.beforeReview?.(args);state=reviewFailure(state,args,now());
  }else assert.equal(name,'seat_portal_status');return {plan:workPlan(state,now())};}};
  const browser={async observe(){ms+=1000;snapshot.observedAt=now();await hooks.observe?.();return structuredClone(snapshot);},
    async snapshot(){return this.observe();}};
  return {portal,browser,config,journalFile,statusFile,clock:()=>ms,hooks,calls,snapshot,requestId,op,
    now, advance(n){ms+=n}, get state(){return state},set state(value){state=value},plan:()=>workPlan(state,now())};
}
test('verified original incident is resumed only after two stable official reads',async t=>{
  const f=await fixture(t),result=await reviewVerifiedOperation(f);
  assert.deepEqual(result,{outcome:'reviewed',source:'fresh_review',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0});
  assert.equal(f.state.codex.globalFailureCode,undefined);assert.equal((await readJson(f.statusFile)).reviewEvidence.operationId,f.op.id);
  assert.deepEqual(f.calls,['seat_portal_status','seat_portal_status','seat_portal_status','review_seat_failure','seat_portal_status','verified_review_receipt']);
});
test('recovery reads exactly two complete snapshots instead of nesting observation pairs',async t=>{
  const f=await fixture(t),read=f.browser.observe.bind(f.browser);let reads=0;
  f.browser.snapshot=async()=>{reads++;return read();};
  f.browser.observe=async()=>{throw Error('Nested observation pair must not run');};
  await reviewVerifiedOperation(f);assert.equal(reads,2);
});
test('an incomplete second raw snapshot cannot submit recovery or create an intent',async t=>{
  const f=await fixture(t),read=f.browser.observe.bind(f.browser);let reads=0;
  f.browser.snapshot=async()=>{const value=await read();if(++reads===2)value.complete=false;return value;};
  await assert.rejects(reviewVerifiedOperation(f));
  assert.equal(reads,2);assert.equal(f.calls.includes('review_seat_failure'),false);
  assert.equal(await readJson(path.join(path.dirname(f.journalFile),'verified-review-intent.json')),null);
});

function reviewHost(checkedAt,state='exited') {return {mode:'admin',adminCommand:'review-verified-operation',state,
  exitCode:state==='exited'?0:1,checkedAt,processId:3456,modelCalls:0,audits:3,
  desktop:'NUMEMS-Agentless-integration',inputDesktop:'Default',maxOwnedWindowsOnInputDesktop:0,
  windowAudit:{isolated:true,desktop:'NUMEMS-Agentless-integration',inputDesktop:'Default',ownedWindowsOnInputDesktop:0}};}
async function checkRealReviewGate(f,adminStart,result) {
  const intentFile=path.join(path.dirname(f.journalFile),'verified-review-intent.json');
  const intentBytes=await readFile(intentFile),reviewIntent=JSON.parse(intentBytes.toString('utf8'));
  const status=await readJson(f.statusFile),journal=await readJson(f.journalFile);
  const finish=new Date(f.clock()+1000).toISOString(),hostAt=new Date(f.clock()+2000).toISOString();
  const adminResult={command:'review-verified-operation',success:true,modelCalls:0,startedAt:adminStart,
    finishedAt:finish,result};
  const input={host:reviewHost(hostAt),status,journal,adminResult,reviewIntent,
    intentDigest:createHash('sha256').update(intentBytes).digest('hex'),now:f.clock()+3000};
  assert.equal(restartDecision(input).reason,'reviewed_verified_operation_start_candidate');
  assert.equal(restartDecision({...input,reviewIntent:{...reviewIntent,phase:'submitted'}}).allowed,false);
}
test('actual fresh review output admits only the bound guarded worker startup',async t=>{
  const f=await fixture(t),adminStart=f.now(),result=await reviewVerifiedOperation(f);
  await checkRealReviewGate(f,adminStart,result);
});
test('actual lost-response receipt recovery admits guarded startup without a replay',async t=>{
  const f=await fixture(t),original=f.portal.call.bind(f.portal);let posts=0;
  f.portal.call=async(name,args)=>{if(name==='review_seat_failure'){posts++;await original(name,args);throw Error('lost');}return original(name,args);};
  await assert.rejects(reviewVerifiedOperation(f));
  const adminStart=f.now(),result=await reviewVerifiedOperation(f);
  assert.equal(result.source,'receipt_recovery');assert.equal(posts,1);
  await checkRealReviewGate(f,adminStart,result);
});
test('actual pre-submit read error yields bound retry while submitted intent blocks it',async t=>{
  const f=await fixture(t),adminStart=f.now();let failure;
  f.browser.observe=async()=>{throw new OfficialPageError('temporarily unavailable','browser_unavailable');};
  try {await reviewVerifiedOperation(f);} catch(e) {failure=e;}
  assert.equal(failure?.reviewRetry?.phase,'pre_submit');
  const finish=new Date(f.clock()+1000).toISOString(),hostAt=new Date(f.clock()+2000).toISOString();
  const adminResult={command:'review-verified-operation',success:false,modelCalls:0,startedAt:adminStart,
    finishedAt:finish,reviewRetry:failure.reviewRetry};
  const input={host:reviewHost(hostAt,'blocked'),status:await readJson(f.statusFile),
    journal:await readJson(f.journalFile),adminResult,intentDigest:'absent',now:f.clock()+62_000};
  assert.equal(reviewRetryDecision(input).reason,'review_pre_submit_retry_candidate');
  assert.equal(reviewRetryDecision({...input,intentDigest:'a'.repeat(64)}).allowed,false);
  assert.equal(f.calls.includes('review_seat_failure'),false);
});
test('lost successful response recovers only from exact cloud receipt without replay',async t=>{
  const f=await fixture(t),original=f.portal.call.bind(f.portal);let writes=0;
  f.portal.call=async(name,args)=>{if(name==='review_seat_failure'){writes++;await original(name,args);throw Error('lost response');}return original(name,args);};
  await assert.rejects(reviewVerifiedOperation(f),/lost response/);
  assert.equal((await readJson(path.join(path.dirname(f.journalFile),'verified-review-intent.json'))).phase,'submitted');
  const result=await reviewVerifiedOperation(f);
  assert.equal(result.workspaceResumed,true);assert.equal(result.source,'receipt_recovery');assert.equal(writes,1);
  assert.equal((await readJson(f.statusFile)).reviewEvidence.targetId,f.requestId);
  assert.equal((await readJson(path.join(path.dirname(f.journalFile),'verified-review-intent.json'))).phase,'settled');
});
test('lost uncommitted response and absent receipt never resubmit',async t=>{
  const f=await fixture(t),original=f.portal.call.bind(f.portal);let writes=0;
  f.portal.call=async(name,args)=>{if(name==='review_seat_failure'){writes++;throw Error('uncertain');}return original(name,args);};
  await assert.rejects(reviewVerifiedOperation(f),/uncertain/);
  await assert.rejects(reviewVerifiedOperation(f),/无法确认精确复核回执/);
  assert.equal(writes,1);assert.ok(f.state.codex.globalFailureCode);
});
test('new failure, changed journal or mismatched receipt prevents local recovery',async t=>{
  for(const type of ['fault','journal','receipt']){
    const f=await fixture(t),original=f.portal.call.bind(f.portal);
    f.portal.call=async(name,args)=>{if(name==='review_seat_failure'){await original(name,args);throw Error('lost');}
      if(name==='verified_review_receipt'&&type==='receipt')return {receipt:null};return original(name,args);};
    await assert.rejects(reviewVerifiedOperation(f),/lost/);
    if(type==='fault')f.state=deferOperation(f.state,{kind:'remove',targetId:f.requestId,failureCode:'unknown',detail:'new fault'},f.now());
    if(type==='journal'){const j=await readJson(f.journalFile);j.target.targetId='req_changed';await atomicJson(f.journalFile,j);}
    await assert.rejects(reviewVerifiedOperation(f));
    assert.equal((await readJson(f.statusFile)).state,'blocked');
  }
});
test('a local status write failure resolves from exact cloud receipt',async t=>{
  const f=await fixture(t);
  await assert.rejects(reviewVerifiedOperation({...f,writeStatus:async()=>{throw Error('disk error');}}),/disk error/);
  const result=await reviewVerifiedOperation(f);assert.equal(result.workspaceResumed,true);
  assert.equal((await readJson(f.statusFile)).reviewEvidence.targetId,f.requestId);
});
test('only explicit official pre-submit read failure yields scoped retry evidence',async t=>{
  const f=await fixture(t);f.browser.observe=async()=>{throw new OfficialPageError('not ready','browser_unavailable');};
  await assert.rejects(reviewVerifiedOperation(f),e=>e.reviewRetry?.phase==='pre_submit' &&
    e.reviewRetry.targetId===f.requestId && e.reviewRetry.operationId===f.op.id &&
    e.reviewRetry.statusFailureCode==='browser_unavailable');
  assert.equal(await readJson(path.join(path.dirname(f.journalFile),'verified-review-intent.json')),null);
  f.browser.observe=async()=>{throw new Error('unknown');};
  await assert.rejects(reviewVerifiedOperation(f),e=>!e.reviewRetry);
  f.browser.observe=async()=>{f.state.codex.globalFailureCode='role_mismatch';throw new OfficialPageError('not ready','browser_unavailable');};
  await assert.rejects(reviewVerifiedOperation(f),e=>!e.reviewRetry);
});
test('malformed or null intent can never become retryable absence',async t=>{
  const f=await fixture(t),file=path.join(path.dirname(f.journalFile),'verified-review-intent.json');
  await atomicJson(file,null);
  await assert.rejects(reviewVerifiedOperation(f),/复核意图文件无效/);
  assert.equal(f.calls.length,0);
});
test('a different new incident archives a confirmed settled intent before review',async t=>{
  const f=await fixture(t);await reviewVerifiedOperation(f);
  const file=path.join(path.dirname(f.journalFile),'verified-review-intent.json'),old=await readJson(file);
  f.advance(1000);const failAt=f.now(),newFailure='codex_999_123456789';
  f.state.codex.globalFailureCode='unknown';f.state.codex.lastError='程序办理未完成；保留原租约和证据，不自动重做外部动作。';
  f.state.audit.push({id:newFailure,at:failAt,actor:ADMIN,action:'codex_workspace_blocked',requestId:f.requestId});
  f.advance(1000);const verifiedAt=f.now(),newOp='op_second_verified';
  f.state.audit.push({id:'codex_1000_123456790',at:verifiedAt,actor:ADMIN,action:'codex_verified_invite',requestId:f.requestId});
  f.state.codex.receipts.push({id:newOp,kind:'invite',email:'person@example.com',at:verifiedAt,evidence:f.snapshot.pageUrl});
  await atomicJson(f.journalFile,{phase:'settled',createdAt:failAt,target:{kind:'invite',targetId:f.requestId,email:'person@example.com'}});
  await atomicJson(f.statusFile,{state:'blocked',failureCode:'unknown',checkedAt:verifiedAt,modelCalls:0});
  const result=await reviewVerifiedOperation(f);
  assert.equal(result.workspaceResumed,true);
  assert.equal((await readJson(file)).failureId,newFailure);
  const history=path.join(path.dirname(file),'verified-review-history',`${old.failureId}-${old.operationId}.json`);
  assert.deepEqual(await readJson(history),old);
});
test('same incident or lost old receipt never archives settled intent',async t=>{
  for(const missingReceipt of [false,true]) {
    const f=await fixture(t);await reviewVerifiedOperation(f);
    const file=path.join(path.dirname(f.journalFile),'verified-review-intent.json');
    if(missingReceipt)f.state.codex.reviewReceipts=[];
    await assert.rejects(reviewVerifiedOperation(f));
    assert.equal((await readJson(file)).phase,'settled');
  }
});
test('automatic retry ticket must match the incident, target and original receipt before official read',async t=>{
  for(const field of ['failureId','targetId','operationId']){
    const f=await fixture(t),plan=f.plan();let reads=0;
    const ticket={failureId:plan.globalFailureId,targetId:f.requestId,operationId:f.op.id};
    ticket[field]=field==='failureId'?'codex_999_1':field==='targetId'?'req_other':'op_other';
    f.browser.observe=async()=>{reads++;throw Error('must not read');};
    await assert.rejects(reviewVerifiedOperation({...f,expectedRetry:ticket,expectedStopDigest:'absent'}),/不一致/);
    assert.equal(reads,0);assert.ok(f.state.codex.globalFailureCode);
  }
});
test('a new stop before intent or after intent prevents the review RPC',async t=>{
  for(const stage of ['before_intent','after_intent']){
    const f=await fixture(t),stopFile=path.join(path.dirname(f.journalFile),'stop-request.json');
    const intentFile=path.join(path.dirname(f.journalFile),'verified-review-intent.json');
    if(stage==='before_intent') {let reads=0;f.hooks.observe=async()=>{if(++reads===2)await atomicJson(stopFile,{id:'new-stop'});};}
    const writeIntent=async(file,value)=>{await atomicJson(file,value);if(stage==='after_intent')await atomicJson(stopFile,{id:'new-stop'});};
    await assert.rejects(reviewVerifiedOperation({...f,writeIntent,expectedStopDigest:'absent'}),/停机请求发生变化/);
    assert.equal(f.calls.includes('review_seat_failure'),false);
    const intent=await readJson(intentFile);assert.equal(intent?.phase??null,stage==='after_intent'?'submitted':null);
  }
});
test('automatic retries never proceed with an existing submitted intent',async t=>{
  const f=await fixture(t),file=path.join(path.dirname(f.journalFile),'verified-review-intent.json');
  await atomicJson(file,{version:1,phase:'submitted'});
  const p=f.plan(),expectedRetry={failureId:p.globalFailureId,targetId:f.requestId,operationId:f.op.id};
  await assert.rejects(reviewVerifiedOperation({...f,expectedRetry,expectedStopDigest:'absent'}),/存在复核意图/);
  assert.equal(f.calls.length,0);
});
test('CAS rejects changed global fault, lease, missing receipt, wrong target or role and stale observation',async t=>{
  for(const variant of ['new_fault','lease','receipt','target','role','capacity','stale','pre_receipt','audit','duplicate_receipt']){
    const f=await fixture(t);f.hooks.beforeReview=(args)=>{
      if(variant==='new_fault') f.state=deferOperation(f.state,{kind:'remove',targetId:f.requestId,failureCode:'unknown',detail:'程序办理未完成；保留原租约和证据，不自动重做外部动作。'},f.now());
      if(variant==='lease') f.state.codex.lease={id:'other'};
      if(variant==='receipt') f.state.codex.receipts=[];
      if(variant==='target') f.state.requests[0].email='other@example.com';
      if(variant==='role') args.observation.members[1].role='admin';
      if(variant==='capacity') f.state.config.totalSeats=5;
      if(variant==='stale') f.state.codex.observation.observedAt='2030-01-01T00:00:00Z';
      if(variant==='pre_receipt') args.observation.observedAt='2026-10-27T10:00:01.000Z';
      if(variant==='audit') f.state.audit=f.state.audit.filter(a=>a.action!=='codex_verified_invite');
      if(variant==='duplicate_receipt')f.state.codex.receipts.push({...f.state.codex.receipts[0]});
    };
    await assert.rejects(reviewVerifiedOperation(f),undefined,variant);
    assert.ok(f.state.codex.globalFailureCode,variant);
    assert.equal((await readJson(f.statusFile)).state,'blocked',variant);
  }
});
test('changed official snapshot or local record stops before server review',async t=>{
  const f=await fixture(t);let count=0;f.hooks.observe=()=>{if(++count===2)f.snapshot.members.pop()};
  await assert.rejects(reviewVerifiedOperation(f));assert.ok(!f.calls.includes('review_seat_failure'));
});
test('three expired members retain capacity; queued applicant remains queued during review',async t=>{
  const f=await fixture(t),base=f.state.requests[0];
  base.status='active';base.expiresAt='2026-10-27T09:59:00.000Z';
  for(const [i,email] of ['second@example.com','third@example.com'].entries()){
    f.state.requests.push({...structuredClone(base),id:`req_extra_${i}`,userId:`u_extra_${i}`,email,name:email});
    f.snapshot.members.push({email,role:'member',seatLabel:'高级'});
  }
  f.state.requests.push({...structuredClone(base),id:'req_queued',userId:'u_waiting',email:'waiting@example.com',
    name:'waiting',status:'queued',expiresAt:null});
  await reviewVerifiedOperation(f);
  const plan=f.plan();
  assert.equal(plan.removals.length,3);
  assert.equal(plan.invites.length,0);
  assert.equal(f.state.requests.find(r=>r.id==='req_queued').status,'queued');
});
test('concurrent renewal after snapshot is retained by the CAS retry',async t=>{
  const f=await fixture(t);let renewedAt;
  f.hooks.beforeReview=()=>{
    f.advance(1000);
    f.state=transition(f.state,{userId:'person',email:'person@example.com',isAdmin:false},
      {type:'renew',id:f.requestId,hours:3},f.now());
    renewedAt=f.state.requests[0].expiresAt;
  };
  await reviewVerifiedOperation(f);
  assert.equal(f.state.requests[0].status,'active');assert.equal(f.state.requests[0].expiresAt,renewedAt);
});
test('only fixed host command with no force flags is accepted',()=>{
  assert.ok(hostArguments(['admin','review-verified-operation']).includes('review-verified-operation'));
  assert.throws(()=>hostArguments(['admin','review-verified-operation','--force']));
});
