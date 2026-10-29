import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {prepareFaultRescue,dispatchPreparedFaultRescue,reconcileFaultRescueDispatch,requestFaultRescueAck,
  settleFaultRescue,faultRescueFile,faultRescueGate,faultRescuePrompt} from '../scripts/agentless/fault-rescue.mjs';
import {faultRescueTurnProof,readFaultRescueTurnProof,FaultRescueClient} from '../scripts/agentless/fault-rescue-client.mjs';
import {isStoppedFaultRescueProof} from '../scripts/agentless/fault-rescue-proof.mjs';

const base=Date.parse('2026-10-28T10:00:00.000Z');
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-fault-rescue-'));
  t.after(async()=>{const rel=path.relative(os.tmpdir(),directory);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await rm(directory,{recursive:true,force:true});});
  let ms=base,begins=0,finishCalls=0,wakes=0;
  const clock=()=>new Date(ms),config={adminEmail:'owner@example.test',workspaceId:'workspace-fixture',liveActions:true,
    faultRescue:{enabled:true,scope:'read_only_reconcile',threadId:'thread-fixture',timeoutSeconds:300}};
  const plan={workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,testOnly:false,
    globalFailureCode:'browser_unavailable',globalFailureId:'fault-1',busy:false,lease:null,
    lastError:'sensitive-provider-body-not-for-prompt',removals:[{id:'req_one',email:'private@example.test'}],invites:[],awaitingAcceptance:[]};
  let ticket;
  const portal={async call(name,args){
    if(name==='refresh_seat_queue')return{mailMode:'in_app'};
    if(name==='seat_portal_status')return{plan};
    if(name==='begin_fault_rescue'){begins++;if(!ticket||ticket.failureId!==plan.globalFailureId)ticket={id:'rescue-fixture-'+begins,token:'fixture-only-token-never-print',failureId:plan.globalFailureId,phase:'pending',scope:'read_only_reconcile'};return{ticket:{...ticket},plan};}
    if(name==='fault_rescue_status')return{ticket:ticket?{...ticket,token:undefined}:null,plan};
    if(name==='finish_fault_rescue'){finishCalls++;assert.equal(args.rescueId,ticket.id);assert.equal(args.token,ticket.token);ticket={...ticket,phase:args.outcome==='uncertain'?'uncertain':'finished',outcome:args.outcome};return{ticket:{...ticket,token:undefined},plan};}
    throw new Error('Unexpected portal operation '+name);
  }};
  let proof;
  const client={async enqueue(threadId,clientId,text){wakes++;const saved=await readJson(faultRescueFile(directory));assert.equal(saved.phase,'sending');assert.equal(saved.clientId,clientId);assert.ok(!text.includes(ticket.token));return{queuedSubmission:{id:'queue-fixture'}};},
    async queued(){return[];},async observeTurnState(identity){return proof??faultRescueTurnProof({thread:{id:identity.threadId,
      turns:[{id:'turn-fixture',status:'completed',startedAt:new Date(base-1000).toISOString(),completedAt:clock().toISOString(),
        items:[{type:'userMessage',clientId:identity.clientUserMessageId}]}]}},identity,clock());}};
  const args={directory,config,portal,hostSafe:true,journalState:{phase:'settled'},clock,newId:()=> 'uuid-fixture'};
  return{directory,config,plan,portal,client,args,clock,advance(n){ms+=n;},setProof(p){proof=p;},
    get counts(){return{begins,finishCalls,wakes};},get ticket(){return ticket;},
    async prepare(){return prepareFaultRescue(args);},async dispatch(){return dispatchPreparedFaultRescue({directory,client,hostSafe:true,projectRoot:path.resolve('fixture-project'),clock});},
    async ack(outcome){const r=await readJson(faultRescueFile(directory));return requestFaultRescueAck({directory,rescueId:r.ticket.id,outcome,clock});},
    async settle(extra={}){return settleFaultRescue({directory,portal,client,hostSafe:true,clock,...extra});}};
}

test('disabled or healthy routine work never claims a rescue or requests inference',async t=>{
  const f=await fixture(t);f.config.faultRescue.enabled=false;assert.equal((await f.prepare()).state,'disabled');
  f.config.faultRescue.enabled=true;f.plan.globalFailureCode=null;assert.equal((await f.prepare()).state,'idle');assert.deepEqual(f.counts,{begins:0,finishCalls:0,wakes:0});
});
test('prepare persists ownership only; dispatch requires separately proved closed host and saves intent before one enqueue',async t=>{
  const f=await fixture(t);assert.equal((await f.prepare()).state,'prepared');assert.equal(f.counts.wakes,0);
  await assert.rejects(dispatchPreparedFaultRescue({directory:f.directory,client:f.client,hostSafe:false,projectRoot:path.resolve('fixture')}));
  const sent=await f.dispatch();assert.equal(sent.state,'queued');assert.equal(sent.wakeAttempts,1);assert.equal(sent.modelUsage,'reported_by_codex');
  assert.ok(!JSON.stringify(sent).includes('token'));await f.dispatch();await f.prepare();assert.equal(f.counts.wakes,1);assert.equal(f.counts.begins,1);
});
test('unknown queue outcome and process restarts never resend, including when no queue receipt is visible',async t=>{
  const f=await fixture(t);await f.prepare();f.client.enqueue=async()=>{throw new Error('ambiguous transport');};
  assert.equal((await f.dispatch()).state,'uncertain');let repeated=0;f.client.enqueue=async()=>{repeated++;};await f.dispatch();await f.prepare();
  assert.equal((await reconcileFaultRescueDispatch({directory:f.directory,client:f.client,clock:f.clock})).state,'uncertain');assert.equal(repeated,0);
});
test('interrupted dispatch can recover its exact queue receipt using the original client UUID without a new wake',async t=>{
  const f=await fixture(t);await f.prepare();const r=await readJson(faultRescueFile(f.directory));r.phase='sending';r.dispatchStartedAt=f.clock().toISOString();await atomicJson(faultRescueFile(f.directory),r);
  f.client.queued=async()=>[{id:'queue-fixture',clientUserMessageId:r.clientId}];
  assert.equal((await reconcileFaultRescueDispatch({directory:f.directory,client:f.client,clock:f.clock})).state,'queued');assert.equal(f.counts.wakes,0);
});
test('lost begin response reclaims only the same idempotent failure receipt before any dispatch',async t=>{
  const f=await fixture(t),call=f.portal.call.bind(f.portal);let failed=true;f.portal.call=async(name,args)=>{const value=await call(name,args);if(name==='begin_fault_rescue'&&failed){failed=false;throw new Error('response lost');}return value;};
  assert.equal((await f.prepare()).state,'uncertain');const original=f.ticket.id;
  assert.equal((await f.prepare()).state,'prepared');assert.equal((await readJson(faultRescueFile(f.directory))).ticket.id,original);assert.equal(f.counts.wakes,0);
});
test('fresh claimed or mismatched original journal cannot be converted into a rescue',async t=>{
  const f=await fixture(t);f.plan.lease={id:'original',status:'claimed'};await assert.rejects(f.prepare());
  f.plan.lease.status='uncertain';await assert.rejects(prepareFaultRescue({...f.args,journalState:{phase:'attempting',lease:{id:'other'}}}));
});
test('model ACK is a request, never proof that a model stopped or the workspace recovered',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();await f.ack('recovered');
  f.setProof({confirmed:false,reason:'not_found'});assert.equal((await f.settle()).reason,'agent_stop_unconfirmed');assert.equal(f.counts.finishCalls,0);
  assert.equal(faultRescueGate(await readJson(faultRescueFile(f.directory))).allowWorker,false);
});
test('only exact completed server turn proof permits backend finish; backend still validates recovery',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();await f.ack('recovered');
  const settled=await f.settle();assert.equal(settled.state,'finished');assert.equal(settled.outcome,'recovered');assert.equal(f.counts.finishCalls,1);
  assert.equal(faultRescueGate(await readJson(faultRescueFile(f.directory))).allowWorker,true);await f.settle();assert.equal(f.counts.finishCalls,1);
});
test('a completed failed/interrupted rescue without ACK ends unresolved and does not fabricate health',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();const result=await f.settle();assert.equal(result.outcome,'unresolved');assert.equal(f.plan.globalFailureCode,'browser_unavailable');
});
test('generic challenge cannot be turned into a claim of required human action',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();await f.ack('needs_human');
  const r=await f.settle({readDiagnostic:async()=>({version:1,state:'challenge',observedAt:f.clock().toISOString(),expectedUrl:'https://admin.openai.com/workspace/fixture/members'})});
  assert.equal(r.outcome,'unresolved');
});
test('explicit fresh official interaction evidence may request human handling after model stop',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();await f.ack('needs_human');
  const r=await f.settle({readDiagnostic:async()=>({version:1,stage:'page',state:'interaction_required',observedAt:f.clock().toISOString(),expectedUrl:'https://admin.openai.com/workspace/fixture/members'})});assert.equal(r.outcome,'needs_human');
});
test('ambiguous finish preserves exclusive evidence, then reconciles matching server receipt without repeating write',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();await f.ack('unresolved');const call=f.portal.call.bind(f.portal);let lost=true;
  f.portal.call=async(name,args)=>{const value=await call(name,args);if(name==='finish_fault_rescue'&&lost){lost=false;throw new Error('receipt lost');}return value;};
  assert.equal((await f.settle()).state,'uncertain');assert.equal(faultRescueGate(await readJson(faultRescueFile(f.directory))).allowWorker,false);
  assert.equal((await f.settle()).state,'finished');assert.equal(f.counts.finishCalls,1);
});
test('new failure ID alone cannot awaken repeatedly during the same continuous outage',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();await f.ack('unresolved');await f.settle();f.plan.globalFailureId='fault-2';
  assert.equal((await f.prepare()).state,'suppressed');assert.equal(f.counts.wakes,1);
  f.plan.workspaceReviewedAt=new Date(base+1000).toISOString();f.advance(2000);assert.equal((await f.prepare()).state,'suppressed');
  await atomicJson(path.join(f.directory,'browser-retry.json'),{version:2,state:'healthy',healthyAt:f.clock().toISOString(),
    officialObservedAt:f.clock().toISOString(),workspaceId:f.config.workspaceId,administrator:f.config.adminEmail});assert.equal((await f.prepare()).state,'prepared');
});
test('takeover prompt contains safe task IDs, no ticket token, raw provider text or employee email',async t=>{
  const f=await fixture(t);await f.prepare();const r=await readJson(faultRescueFile(f.directory));const prompt=faultRescuePrompt(r,path.resolve('fixture-project'));
  assert.ok(prompt.includes('req_one'));for(const value of[f.ticket.token,f.plan.lastError,'private@example.test'])assert.ok(!prompt.includes(value));assert.ok(prompt.length<4200);
});
test('timeout requests interruption at most once only for the exactly linked exclusive rescue turn, never releases ownership early',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();const r=await readJson(faultRescueFile(f.directory));f.advance(301000);let interrupted=0;
  f.setProof({kind:'codex_turn_state',confirmed:true,stopped:false,source:'app_server_thread_read',threadId:r.threadId,clientUserMessageId:r.clientId,turnId:'own-turn',linkedTurnId:'own-turn',status:'inProgress',observedAt:f.clock().toISOString(),startedAt:r.createdAt,exclusiveTurn:true});
  f.client.interruptTrackedTurn=async()=>{interrupted++;};assert.equal((await f.settle()).reason,'agent_budget_exceeded_stop_unconfirmed');await f.settle();assert.equal(interrupted,1);assert.equal(f.counts.finishCalls,0);assert.equal(faultRescueGate(await readJson(faultRescueFile(f.directory))).allowWorker,false);
});
test('a rescue steered into another active user turn is never interrupted by the fault budget',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();const r=await readJson(faultRescueFile(f.directory));f.advance(301000);let interrupted=0;
  f.setProof({kind:'codex_turn_state',confirmed:true,stopped:false,source:'app_server_thread_read',threadId:r.threadId,clientUserMessageId:r.clientId,turnId:'shared-turn',linkedTurnId:'shared-turn',status:'inProgress',observedAt:f.clock().toISOString(),startedAt:r.createdAt,exclusiveTurn:false});
  f.client.interruptTrackedTurn=async()=>{interrupted++;};await f.settle();assert.equal(interrupted,0);assert.equal(f.counts.finishCalls,0);
});

test('server turn proof links exact userMessage.clientId and never treats queue absence or thread status as completion',()=>{
  const id={threadId:'thread-fixture',clientUserMessageId:'client-fixture',queuedId:'queue-fixture'};
  const response={thread:{id:id.threadId,status:{type:'notLoaded'},turns:[]}};
  assert.equal(faultRescueTurnProof(response,id).confirmed,false);
  response.thread.turns=[{id:'turn-fixture',status:'completed',startedAt:1793181600,completedAt:1793181610,items:[{type:'userMessage',clientId:id.clientUserMessageId,content:'not inspected'}]}];
  const p=faultRescueTurnProof(response,id);assert.equal(p.stopped,true);assert.equal(p.exclusiveTurn,true);
  response.thread.turns.push({...response.thread.turns[0],id:'duplicate'});assert.equal(faultRescueTurnProof(response,id).confirmed,false);
});
test('a completed child does not release the active root turn and missing parent evidence stays unconfirmed',()=>{
  const id={threadId:'thread-fixture',clientUserMessageId:'client-fixture'};
  const child={id:'child-turn',rootTurnId:'root-turn',status:'completed',items:[{type:'userMessage',clientId:id.clientUserMessageId}]};
  const r={thread:{id:id.threadId,turns:[child]}};assert.equal(faultRescueTurnProof(r,id).confirmed,false);
  r.thread.turns.push({id:'root-turn',status:'inProgress',items:[]});const p=faultRescueTurnProof(r,id);assert.equal(p.stopped,false);assert.equal(p.exclusiveTurn,false);
  child.status='inProgress';r.thread.turns[1].status='completed';assert.equal(faultRescueTurnProof(r,id).stopped,false);
});

test('actual interrupted/null App Server projection never releases a still executing rescue',()=>{
  const id={threadId:'thread-fixture',clientUserMessageId:'numems-fault:actual-regression',queuedId:'queue-fixture'};
  const turn={id:'turn-rescue',rootTurnId:'turn-rescue',status:'interrupted',startedAt:1793193605,
    completedAt:null,itemsView:'summary',items:[{type:'userMessage',id:'msg-rescue',clientId:id.clientUserMessageId}]};
  const response={thread:{id:id.threadId,status:{type:'notLoaded'},turns:[turn]}};
  let p=faultRescueTurnProof(response,id,new Date('2026-10-28T13:21:20.147Z'));
  assert.equal(p.confirmed,true);assert.equal(p.stopped,false);assert.equal(p.completedAt,null);
  assert.equal(p.terminalEvidence,'status_and_completed_at');assert.equal(p.terminalChain[0].ended,false);
  // The exact same turn later acquired a real completion receipt at 13:25:54.
  turn.status='completed';turn.completedAt=1793193954;
  p=faultRescueTurnProof(response,id,new Date('2026-10-28T13:26:00Z'));
  assert.equal(p.stopped,true);assert.equal(p.completedAt,'2026-10-28T13:25:54.000Z');
});

test('all terminal enum values require valid ordered completion receipts on every linked turn',()=>{
  const id={threadId:'thread-fixture',clientUserMessageId:'client-fixture'};
  const ended={id:'ended-root',status:'completed',startedAt:1793181600,completedAt:1793181610,items:[]};
  for(const status of ['completed','interrupted','failed'])for(const completedAt of [null,undefined,'invalid',1793181599,1793189999]) {
    const child={id:'child',rootTurnId:'ended-root',status,startedAt:1793181600,completedAt,
      items:[{type:'userMessage',clientId:id.clientUserMessageId}]};
    const p=faultRescueTurnProof({thread:{id:id.threadId,turns:[child,ended]}},id,new Date('2026-10-28T10:01:00Z'));
    assert.equal(p.confirmed,true);assert.equal(p.stopped,false,status+' '+String(completedAt));
  }
  for(const status of ['completed','interrupted','failed']) {
    const child={id:'child',rootTurnId:'ended-root',status,startedAt:1793181600,completedAt:1793181610,
      items:[{type:'userMessage',clientId:id.clientUserMessageId}]};
    const response={thread:{id:id.threadId,turns:[child,{...ended,completedAt:null}]}};
    assert.equal(faultRescueTurnProof(response,id,new Date('2026-10-28T10:01:00Z')).stopped,false);
    response.thread.turns[1]=ended;
    assert.equal(faultRescueTurnProof(response,id,new Date('2026-10-28T10:01:00Z')).stopped,true);
  }
});

test('an active continuation descendant prevents release of the original completed client-bearing turn',()=>{
  const id={threadId:'thread-fixture',clientUserMessageId:'client-fixture'};
  const root={id:'root-turn',rootTurnId:'root-turn',status:'completed',startedAt:1793181600,completedAt:1793181610,
    items:[{type:'userMessage',clientId:id.clientUserMessageId}]};
  const child={id:'continuation-turn',rootTurnId:'root-turn',status:'inProgress',startedAt:1793181611,completedAt:null,items:[]};
  const response={thread:{id:id.threadId,turns:[child,root]}};
  let p=faultRescueTurnProof(response,id,new Date('2026-10-28T10:01:00Z'));
  assert.equal(p.stopped,false);assert.equal(p.terminalFamily.length,2);
  child.status='completed';child.completedAt=1793181620;
  p=faultRescueTurnProof(response,id,new Date('2026-10-28T10:01:00Z'));
  assert.equal(p.stopped,true);assert.equal(isStoppedFaultRescueProof(p,id,{now:new Date('2026-10-28T10:01:00Z')}),true);
  p.terminalFamily[0].completedAt=null;
  assert.equal(isStoppedFaultRescueProof(p,id,{now:new Date('2026-10-28T10:01:00Z')}),false);
});

test('pure stop validator rejects legacy persisted interrupted/null proof and forged family evidence',()=>{
  const id={threadId:'thread-fixture',clientUserMessageId:'client-fixture',queuedId:'queue-fixture'},now=new Date('2026-10-28T10:01:00Z');
  const turn={id:'root-turn',status:'interrupted',startedAt:1793181600,completedAt:1793181610,
    items:[{type:'userMessage',clientId:id.clientUserMessageId}]};
  const p=faultRescueTurnProof({thread:{id:id.threadId,turns:[turn]}},id,now);
  assert.equal(isStoppedFaultRescueProof(p,id,{now}),true);
  const legacy={...p,terminalEvidence:undefined,terminalChain:undefined,terminalFamily:undefined,completedAt:null};
  assert.equal(isStoppedFaultRescueProof(legacy,id,{now}),false);
  assert.equal(isStoppedFaultRescueProof({...p,readMethod:'thread/turns/list'},id,{now}),false);
  assert.equal(isStoppedFaultRescueProof({...p,readMethod:'thread/turns/list',headRevalidated:true},id,{now}),true);
  assert.equal(isStoppedFaultRescueProof(p,{...id,queuedId:'foreign'},{now}),false);
});
test('exceptional client cannot call old portal tools, create a model thread or grant approval',async()=>{
  const client=Object.create(FaultRescueClient.prototype);
  for(const method of ['mcpServer/tool/call','thread/start','turn/start','account/login/start'])
    assert.throws(()=>client.request(method,{}),/limited/);
  assert.throws(()=>client.request('thread/read',{threadId:'thread-fixture',includeTurns:true}),/limited/);
  assert.throws(()=>client.request('thread/turns/list',{threadId:'thread-fixture',itemsView:'full'}),/limited/);
  await assert.rejects(client.portal('thread-fixture','invite',{}),/limited/);
  await assert.rejects(client.interruptTrackedTurn({threadId:'thread-fixture',clientUserMessageId:'client-fixture'},
    {confirmed:true,stopped:false,exclusiveTurn:true,threadId:'thread-fixture',clientUserMessageId:'client-fixture',turnId:'turn-fixture'}));
});
test('invalid local scope or ticket evidence cannot dispatch even after metadata preparation',async t=>{
  const f=await fixture(t);f.config.faultRescue.scope='member_actions';await assert.rejects(f.prepare());
  f.config.faultRescue.scope='read_only_reconcile';await f.prepare();
  const r=await readJson(faultRescueFile(f.directory));r.ticket.token='short';await atomicJson(faultRescueFile(f.directory),r);
  await assert.rejects(f.dispatch());assert.equal(f.counts.wakes,0);
});
test('fresh ordinary-channel failure overrides a model recovery claim; uncertain metadata result remains fenced once',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();await f.ack('recovered');
  assert.equal((await f.settle({verifiedRecovery:false})).outcome,'unresolved');
  const g=await fixture(t);await g.prepare();await g.dispatch();await g.ack('uncertain');
  const call=g.portal.call.bind(g.portal);g.portal.call=async(name,args)=>{const v=await call(name,args);if(name==='finish_fault_rescue')delete v.ticket.outcome;return v;};
  assert.equal((await g.settle()).state,'uncertain');assert.equal(faultRescueGate(await readJson(faultRescueFile(g.directory))).allowWorker,false);
  await g.settle();assert.equal(g.counts.finishCalls,1);
});
test('fresh independent kernel health permits recovery even when the completed model omitted ACK or remained uncertain',async t=>{
  for(const ack of [null,'unresolved','uncertain']) {
    const f=await fixture(t);await f.prepare();await f.dispatch();if(ack)await f.ack(ack);
    assert.equal((await f.settle({verifiedRecovery:true})).outcome,'recovered');
  }
});
test('fresh kernel interaction proof drives human outcome without ACK but never converts unknown original action',async t=>{
  const d={version:1,stage:'page',state:'interaction_required',observedAt:new Date(base).toISOString(),expectedUrl:'https://admin.openai.com/workspace/fixture/members'};
  const f=await fixture(t);await f.prepare();await f.dispatch();
  assert.equal((await f.settle({verifiedRecovery:false,readDiagnostic:async()=>d})).outcome,'needs_human');
  const g=await fixture(t);g.plan.globalFailureCode='unknown';await g.prepare();await g.dispatch();
  assert.equal((await g.settle({verifiedRecovery:false,readDiagnostic:async()=>d})).outcome,'unresolved');
});
test('fresh login during the original browser fault requests login without rewriting an unknown action',async t=>{
  const d={version:1,stage:'page',state:'login',observedAt:new Date(base).toISOString(),expectedUrl:'https://admin.openai.com/workspace/fixture/members'};
  for(const code of ['browser_unavailable','login_expired','unknown']) {
    const f=await fixture(t);f.plan.globalFailureCode=code;await f.prepare();await f.dispatch();
    assert.equal((await f.settle({verifiedRecovery:false,readDiagnostic:async()=>d})).outcome,code==='unknown'?'unresolved':'needs_human');
  }
});

const identity={threadId:'thread-fixture',clientUserMessageId:'client-fixture'};
const summaryTurn=(id,clientId=identity.clientUserMessageId,patch={})=>({id,status:'completed',rootTurnId:id,
  startedAt:1793181600,completedAt:1793181610,itemsView:'summary',
  items:[{type:'userMessage',id:'message-'+id,clientId,content:['private-body-never-retained']},
    {type:'commandExecution',aggregatedOutput:'private-tool-result-never-retained'}],...patch});
function paginatedRequest(pages,calls) {
  let index=0;return async(method,args)=>{
    calls.push({method,args});
    if(method==='thread/read') {assert.equal(args.includeTurns,false);return{thread:{id:identity.threadId,turns:[]}};}
    assert.equal(method,'thread/turns/list');assert.equal(args.itemsView,'summary');assert.equal(args.sortDirection,'desc');
    return !args.cursor&&index>0?pages[0]:pages[index++]??{data:[],nextCursor:null};
  };
}
test('long-thread lifecycle uses official bounded summary pagination and retains no tool or message bodies',async()=>{
  const calls=[],request=paginatedRequest([{data:[summaryTurn('turn-fixture')],nextCursor:'older'}],calls);
  const proof=await readFaultRescueTurnProof(request,identity);
  assert.equal(proof.confirmed,true);assert.equal(proof.stopped,true);assert.equal(proof.exclusiveTurn,false);
  assert.equal(proof.readMethod,'thread/turns/list');assert.equal(proof.pagesRead,1);assert.equal(calls.length,3);
  assert.equal(proof.headRevalidated,true);assert.equal(isStoppedFaultRescueProof(proof,identity),true);
  assert.ok(!JSON.stringify(proof).includes('private-'));assert.ok(calls.every(c=>c.args.includeTurns!==true));
});
test('paginated metadata follows the exact root chain without treating a terminal parent as a terminal child',async()=>{
  const calls=[],child=summaryTurn('child-turn',identity.clientUserMessageId,{rootTurnId:'root-turn',status:'inProgress'}),root=summaryTurn('root-turn','other-client');
  const request=paginatedRequest([{data:[child],nextCursor:'older'},{data:[root],nextCursor:null}],calls);
  const proof=await readFaultRescueTurnProof(request,identity,{pageSize:1});
  assert.equal(proof.confirmed,true);assert.equal(proof.stopped,false);assert.equal(proof.turnId,'root-turn');assert.equal(proof.pagesRead,2);
});

test('summary projection interrupted/null remains fenced until the same exact turn has a completedAt receipt',async t=>{
  const f=await fixture(t);await f.prepare();await f.dispatch();
  const r=await readJson(faultRescueFile(f.directory)),identity={threadId:r.threadId,clientUserMessageId:r.clientId,queuedId:r.queuedId};
  const turn={id:'real-projection-turn',rootTurnId:'real-projection-turn',status:'interrupted',startedAt:base/1000-1,
    completedAt:null,itemsView:'summary',items:[{type:'userMessage',id:'real-projection-item',clientId:r.clientId}]};
  const request=async(method)=>method==='thread/read'?{thread:{id:r.threadId,turns:[],status:{type:'notLoaded'}}}:{data:[turn],nextCursor:null};
  f.client.observeTurnState=async()=>readFaultRescueTurnProof(request,identity,{clock:f.clock});
  assert.equal((await f.settle()).reason,'agent_stop_unconfirmed');assert.equal(f.counts.finishCalls,0);
  assert.equal(faultRescueGate(await readJson(faultRescueFile(f.directory))).allowWorker,false);
  turn.completedAt=base/1000;turn.status='completed';
  assert.equal((await f.settle()).state,'finished');assert.equal(f.counts.finishCalls,1);
});

test('newer active same-root descendant is included before the older original message is found',async()=>{
  const child=summaryTurn('continuation','continuation-client',{rootTurnId:'root-turn',status:'interrupted',completedAt:null});
  const root=summaryTurn('root-turn');
  const proof=await readFaultRescueTurnProof(paginatedRequest([{data:[child],nextCursor:'older'},{data:[root],nextCursor:null}],[]),identity,{pageSize:1});
  assert.equal(proof.confirmed,true);assert.equal(proof.stopped,false);assert.equal(proof.terminalFamily.length,2);
});

test('a changed newest summary page invalidates tentative terminal evidence before any release',async()=>{
  let lists=0;
  const request=async(method)=>method==='thread/read'?{thread:{id:identity.threadId,turns:[]}}:
    ++lists===1?{data:[summaryTurn('root-turn')],nextCursor:null}:
      {data:[summaryTurn('new-continuation','other',{rootTurnId:'root-turn',status:'inProgress',completedAt:null}),summaryTurn('root-turn')],nextCursor:null};
  const proof=await readFaultRescueTurnProof(request,identity);
  assert.equal(proof.confirmed,true);assert.equal(proof.stopped,false);assert.equal(proof.reason,'turn_head_changed');
  assert.equal(isStoppedFaultRescueProof(proof,identity),false);
});
test('finite pagination, absent client and unavailable root preserve unconfirmed ownership',async()=>{
  const absent=paginatedRequest([{data:[summaryTurn('one','other')],nextCursor:'a'},{data:[summaryTurn('two','other')],nextCursor:'b'}],[]);
  assert.equal((await readFaultRescueTurnProof(absent,identity,{pageSize:1,maxPages:2})).reason,'turn_search_budget_exceeded');
  const missing=paginatedRequest([{data:[summaryTurn('child',identity.clientUserMessageId,{rootTurnId:'missing-root'})],nextCursor:null}],[]);
  assert.equal((await readFaultRescueTurnProof(missing,identity)).reason,'root_turn_not_found');
});
test('repeated cursors, duplicate turns, full item views and invalid metadata cannot prove model closure',async()=>{
  const cases=[
    [{data:[summaryTurn('one','other')],nextCursor:'a'},{data:[summaryTurn('two','other')],nextCursor:'a'}],
    [{data:[summaryTurn('one','other')],nextCursor:'a'},{data:[summaryTurn('one')],nextCursor:null}],
    [{data:[summaryTurn('one',identity.clientUserMessageId,{itemsView:'full'})],nextCursor:null}],
  ];
  for(const pages of cases)assert.equal((await readFaultRescueTurnProof(paginatedRequest(pages,[]),identity,{pageSize:1})).confirmed,false);
  assert.equal((await readFaultRescueTurnProof(async()=>({thread:{id:identity.threadId,turns:[{}]}}),identity)).reason,'thread_metadata_invalid');
});
