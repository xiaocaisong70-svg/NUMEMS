import test from 'node:test';
import assert from 'node:assert/strict';
import {assertObservationSetup,refreshOfficialObservation,summarizeTestView} from '../scripts/agentless/admin.mjs';
import {hostArguments} from '../scripts/agentless/host.mjs';
import {validateConfig,ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';
import {createState} from '../lib/seat-engine.ts';
import {observeWorkspace,prepareTest,workPlan} from '../lib/codex-bridge.ts';
import {applyReminderPolicy} from '../lib/reminder-policy.ts';

const config=validateConfig();
const now='2026-10-23T12:00:00.000Z';
const plan=()=>({workspaceId:WORKSPACE,administrator:ADMIN,enabled:false,testOnly:true,
  busy:false,lease:null,lastError:null,globalFailureCode:null,blockedOperations:[]});
function fixture() {
  let state=applyReminderPolicy(createState(now),'in_app');
  const calls=[];
  const snapshot={workspaceId:WORKSPACE,accountEmail:ADMIN,complete:true,totalSeats:4,
    observedAt:now,pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,
    members:[{email:ADMIN,role:'owner'}],invites:[]};
  const browser={async observe(){calls.push('browser.observe');return structuredClone(snapshot);},
    invite(){assert.fail('admin initialization must never invite');},
    remove(){assert.fail('admin initialization must never remove');}};
  const portal={async call(name,args={}){
    calls.push(name);
    if(name==='observe_workspace')state=observeWorkspace(state,args.observation,now);
    else if(name==='prepare_test_request')state=prepareTest(state,now);
    else assert.equal(name,'seat_portal_status','no claim/completion or other member write is permitted');
    return {plan:workPlan(state,now)};
  }};
  return {portal,browser,config,calls,snapshot,get state(){return state;},set state(value){state=value;}};
}

test('prepare-test refreshes real evidence and bootstraps before creating the server-restricted test',async()=>{
  const f=fixture();
  const result=await refreshOfficialObservation({...f,prepareTest:true});
  assert.equal(f.state.config.inventoryVerified,true);
  assert.equal(f.state.config.workspaceId,WORKSPACE);
  assert.deepEqual(f.calls,['seat_portal_status','browser.observe','seat_portal_status','observe_workspace','prepare_test_request']);
  assert.equal(result.plan.enabled,true);assert.equal(result.plan.testOnly,true);
  assert.equal(f.state.requests.length,1);
  assert.equal(f.state.requests[0].email,'hit_wangning@outlook.com');
  assert.equal(f.state.requests[0].isTest,true);assert.equal(f.state.requests[0].status,'pending_invite');
  assert.equal(f.state.codex.inviteVerifiedAt,undefined);
  assert.equal(f.state.codex.removalVerifiedAt,undefined);
});

test('observe refreshes inventory without creating a test or enabling the worker',async()=>{
  const f=fixture();
  await refreshOfficialObservation(f);
  assert.equal(f.state.config.inventoryVerified,true);
  assert.equal(f.state.requests.length,0);
  assert.equal(f.state.codex.enabled,false);
  assert.deepEqual(f.calls,['seat_portal_status','browser.observe','seat_portal_status','observe_workspace']);
});

test('prepare-test replaces stale observation with current official evidence',async()=>{
  const f=fixture();
  f.state=observeWorkspace(f.state,{...f.snapshot,observedAt:'2026-10-23T11:58:00.000Z'},'2026-10-23T11:58:00.000Z');
  assert.throws(()=>prepareTest(f.state,now),/已过期/);
  await refreshOfficialObservation({...f,prepareTest:true});
  assert.equal(f.state.codex.observation.observedAt,now);
});

test('setup refuses unresolved local or cloud records before reading official pages',async()=>{
  for(const patch of [{busy:true},{lease:{token:'do-not-print'}},{lastError:'uncertain'},
    {globalFailureCode:'unknown'},{blockedOperations:[{operation:{id:'held'}}]},
    {workspaceId:'other-workspace'},{administrator:'other@example.com'},{testOnly:false}]) {
    const calls=[];
    await assert.rejects(refreshOfficialObservation({config,prepareTest:true,
      portal:{async call(){calls.push('status');return {plan:{...plan(),...patch}};}},
      browser:{observe(){calls.push('official');assert.fail('must reject before official access');}},
    }));
    assert.deepEqual(calls,['status']);
  }
  assert.throws(()=>assertObservationSetup(plan(),config,{journalState:{phase:'claiming'}}),/未结案/);
  assert.doesNotThrow(()=>assertObservationSetup({...plan(),workspaceId:''},config));
  assert.doesNotThrow(()=>assertObservationSetup({...plan(),testOnly:false},config));
});

test('new remote lease while official snapshot loads prevents evidence/test writes',async()=>{
  const calls=[];let reads=0;
  await assert.rejects(refreshOfficialObservation({config,prepareTest:true,
    portal:{async call(name){calls.push(name);return {plan:{...plan(),...(++reads===2?{busy:true}:{})}};}},
    browser:{async observe(){return fixture().snapshot;}},
  }),/未完成租约/);
  assert.deepEqual(calls,['seat_portal_status','seat_portal_status']);
});

test('server still rejects stale evidence, wrong Owner and existing test membership',async()=>{
  for(const mutate of [
    f=>{f.snapshot.observedAt='2026-10-23T11:58:00.000Z';},
    f=>{f.snapshot.members[0].role='member';},
    f=>{f.snapshot.members.push({email:'hit_wangning@outlook.com',role:'member'});},
  ]) {
    const f=fixture();mutate(f);
    await assert.rejects(refreshOfficialObservation({...f,prepareTest:true}));
    assert.equal(f.state.codex.enabled,false);
    assert.equal(f.state.codex.inviteVerifiedAt,undefined);
  }
});

test('test-status summary includes active state but excludes secrets and other employees',()=>{
  const payload={access:'allowed',user:{email:ADMIN,isAdmin:true},view:{
    config:{token:'private-config'},audit:[{detail:'private-audit'}],
    requests:[{id:'req_test',email:'HIT_wangning@outlook.com',isTest:true,status:'active',
      expiresAt:'2026-10-23T13:00:00.000Z',userId:'private-user',reason:'private-reason',token:'private-lease'},
      {id:'req_other',email:'other@example.com',isTest:true,status:'active'},
      {id:'req_not_test',email:'hit_wangning@outlook.com',isTest:false,status:'completed'}],
    notices:[{requestId:'req_test',email:'hit_wangning@outlook.com',type:'expiry_30m',status:'pending',
      createdAt:now,message:'private-message',providerMessageId:'private-message-id'},
      {requestId:'req_other',email:'other@example.com',type:'active',status:'pending'}],
  }};
  const summary=summarizeTestView(payload,config);
  assert.deepEqual(summary.testRequests,['req_test']);
  assert.equal(summary.testDetails[0].status,'active');
  assert.equal(summary.testDetails[0].expiresAt,'2026-10-23T13:00:00.000Z');
  assert.equal(summary.testNotices.length,1);
  assert.doesNotMatch(JSON.stringify(summary),/private-|other@example|req_other|req_not_test|token|userId|reason|message/i);
  for(const change of [{access:'signin_required'},{user:{email:'other@example.com',isAdmin:true}},
    {user:{email:ADMIN,isAdmin:false}},{view:{requests:[]}}])
    assert.throws(()=>summarizeTestView({...payload,...change},config));
});

test('isolated admin observe is whitelisted without arbitrary arguments',()=>{
  assert.ok(hostArguments(['admin','observe']).includes('observe'));
  assert.throws(()=>hostArguments(['admin','observe','req_any']));
  assert.throws(()=>hostArguments(['admin','observe;anything']));
});
