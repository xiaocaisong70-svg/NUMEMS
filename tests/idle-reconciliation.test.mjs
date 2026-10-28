import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,transition,PROTECTED_OWNER_EMAIL} from '../lib/seat-engine.ts';
import {observeWorkspace,claimOperation,completeOperation,workPlan,TARGET_WORKSPACE_ID} from '../lib/codex-bridge.ts';
import {applyIdleObservation,recordIdleFailure} from '../lib/official-idle-state.ts';
import {reconcileIdle} from '../scripts/agentless/idle-reconcile.mjs';
import {runBatch} from '../scripts/agentless/core.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';
import {InventoryMismatchError} from '../scripts/seat-executor/browser.mjs';

const base=Date.parse('2026-10-28T06:00:00.000Z');
const at=n=>new Date(base+n*1000).toISOString();
const owner={userId:'owner',email:PROTECTED_OWNER_EMAIL,isAdmin:true};
const staff={userId:'staff',email:'idle-fixture@example.com',isAdmin:false};
const person={email:staff.email,role:'member'};
function evidence(n,members=[],invites=[]) {
  return {workspaceId:TARGET_WORKSPACE_ID,accountEmail:owner.email,
    pageUrl:`https://admin.openai.com/workspace/${TARGET_WORKSPACE_ID}/members`,
    complete:true,totalSeats:4,observedAt:at(n),
    members:[{email:owner.email,role:'owner'},...members],invites};
}
function initial() {
  let s=transition(createState(at(0)),owner,{type:'configure',config:{workspaceId:TARGET_WORKSPACE_ID,
    automationEnabled:true,whitelist:[staff.email]}},at(0));
  s=observeWorkspace(s,evidence(0),at(0));
  s.codex={...s.codex,enabled:true,testOnly:false,mailEnabled:false,receipts:[]};
  return s;
}
function fixture() {
  let s=initial(),seconds=120,record=null;
  const calls=[],saved=[],health=[];
  const config=validateConfig({liveActions:true,legacyCheckerDisabled:true,mailMode:'in_app'});
  const raw=()=>({...evidence(seconds),workspaceName:'My Workspace',seatLabel:'高级',
    members:[{email:owner.email,role:'owner',seatLabel:'高级'}],invites:[]});
  const portal={async call(name,args={}) {
    calls.push({name,args:structuredClone(args)});
    if(name==='observe_idle_workspace')s=applyIdleObservation(s,args,at(seconds));
    else if(name==='record_idle_observation_failure')s=recordIdleFailure(s,args,at(seconds));
    else assert.equal(name,'seat_portal_status','idle reconciliation must not call member/claim/mail operations');
    return {plan:workPlan(s,at(seconds))};
  }};
  let reads=0;
  const browser={async observe(){reads++;return raw();},
    async invite(){assert.fail('idle must never invite');},async remove(){assert.fail('idle must never remove');}};
  const run=(extra={})=>reconcileIdle({portal,browser,config,record,
    clock:()=>new Date(at(seconds)),save:async value=>{record=structuredClone(value);saved.push(record);},
    onHealthy:async value=>health.push(value),...extra});
  return {portal,browser,config,calls,saved,health,raw,run,get reads(){return reads;},
    get state(){return s;},set state(value){s=value;},
    get seconds(){return seconds;},set seconds(value){seconds=value;},
    get record(){return record;},set record(value){record=value;}};
}

test('idle read starts exactly at 120 seconds and uses latest local or official evidence as cadence anchor',async()=>{
  const f=fixture();f.seconds=119.999;
  assert.deepEqual(await f.run(),{state:'waiting',nextAt:at(120)});
  assert.equal(f.reads,0);
  f.seconds=120;
  assert.deepEqual(await f.run(),{state:'verified',observedAt:at(120)});
  assert.equal(f.reads,1);assert.equal(f.health.length,1);
  assert.deepEqual(f.calls.filter(c=>c.name!=='seat_portal_status').map(c=>c.name),['observe_idle_workspace']);
  assert.equal(f.state.codex.observation.observedAt,at(120));
  assert.deepEqual(f.saved.map(s=>s.state),['observing','verified']);
  f.seconds=239.999;assert.equal((await f.run()).state,'waiting');assert.equal(f.reads,1);
  f.seconds=240;assert.equal((await f.run()).state,'verified');assert.equal(f.reads,2);
  const g=fixture();g.record={attemptedAt:at(50),state:'observing'};g.seconds=169;
  assert.equal((await g.run()).nextAt,at(170));assert.equal(g.reads,0);
});

test('future or malformed cadence evidence is rejected before any official read',async()=>{
  for(const source of ['localFuture','localInvalid','cloudFuture','cloudInvalid']) {
    const f=fixture();
    if(source==='localFuture')f.record={attemptedAt:at(121)};
    if(source==='localInvalid')f.record={attemptedAt:'invalid'};
    if(source==='cloudFuture')f.state.codex.observation.observedAt=at(121);
    if(source==='cloudInvalid')f.state.codex.observation.observedAt='invalid';
    await assert.rejects(f.run(),/时间证据无效/);assert.equal(f.reads,0);assert.equal(f.health.length,0);
    assert.equal(f.calls.some(c=>c.name!=='seat_portal_status'),false);
  }
});

test('dry-run, legacy conflict, unsettled local journal or initial stop prevents even portal reads',async()=>{
  for(const journalState of [{phase:'claiming'},{phase:'claimed',lease:{id:'original'}},
    {phase:'settled',lease:{id:'original'}},{phase:'settled',receipt:{operationId:'original'}}]) {
    const f=fixture();assert.equal((await f.run({journalState})).reason,'local_guard');
    assert.equal(f.calls.length,0);assert.equal(f.reads,0);
  }
  for(const extra of [{config:{...fixture().config,liveActions:false}},
    {config:{...fixture().config,legacyCheckerDisabled:false}},{shouldStop:async()=>true}]) {
    const f=fixture();assert.equal((await f.run(extra)).reason,'local_guard');assert.equal(f.calls.length,0);
  }
  const healthy=fixture();assert.equal((await healthy.run({journalState:{phase:'settled',lease:null,receipt:null}})).state,'verified');
});

test('cloud lease, busy flag, identity mismatch, disabled/test mode and any global fault prevent official reads',async()=>{
  const variants=[p=>({...p,busy:true}),p=>({...p,lease:{id:'other-op'}}),p=>({...p,workspaceId:'other'}),
    p=>({...p,administrator:'other@example.com'}),p=>({...p,enabled:false}),p=>({...p,testOnly:true}),
    p=>({...p,globalFailureCode:'unknown'}),p=>({...p,lastError:'retained fault'})];
  for(const change of variants) {
    const f=fixture();f.portal.call=async name=>{assert.equal(name,'seat_portal_status');return {plan:change(workPlan(f.state,at(120)))};};
    assert.equal((await f.run()).reason,'cloud_guard');assert.equal(f.reads,0);assert.equal(f.health.length,0);
  }
});

test('the full official snapshot is validated before stripping raw identity, roles or seat type fields',async()=>{
  const variants=[s=>({...s,workspaceName:'Other Workspace'}),s=>({...s,workspaceId:'other'}),
    s=>({...s,accountEmail:'other@example.com'}),s=>({...s,totalSeats:5}),s=>({...s,seatLabel:'basic'}),
    s=>({...s,complete:false}),s=>({...s,pageUrl:'https://example.com/members'}),
    s=>({...s,observedAt:at(59.999)}),s=>({...s,observedAt:at(126)}),
    s=>({...s,members:[{...s.members[0],role:'member'}]}),
    s=>({...s,members:[...s.members,{email:staff.email,role:'robot',seatLabel:'高级'}]}),
    s=>({...s,members:[...s.members,{email:staff.email,role:'member',seatLabel:'basic'}]}),
    s=>({...s,invites:[{email:staff.email,role:'owner',seatLabel:'高级'}]}),
    s=>({...s,invites:[{...s.members[0]}]})];
  for(const change of variants) {
    const f=fixture();f.browser.observe=async()=>change(f.raw());
    await assert.rejects(f.run());assert.equal(f.calls.some(c=>c.name==='observe_idle_workspace'),false);
    assert.equal(f.calls.filter(c=>c.name==='record_idle_observation_failure').length,1);
    assert.equal(f.state.codex.globalFailureCode,'unknown');assert.equal(f.health.length,0);
  }
});

test('pre-action read failures register targetless global health faults without any claimed or external action',async()=>{
  for(const classification of ['browser_unavailable','login_expired','workspace_mismatch','capacity_mismatch','role_mismatch','unknown','inventory']) {
    const f=fixture();const error=classification==='inventory'
      ?new InventoryMismatchError({total:4,assigned:3,available:1},1,0)
      :Object.assign(new Error('controlled official read failure'),{failureCode:classification});
    f.browser.observe=async()=>{throw error;};
    await assert.rejects(f.run(),e=>e===error);
    const write=f.calls.find(c=>c.name==='record_idle_observation_failure');
    assert.deepEqual(Object.keys(write.args).sort(),['expectedObservedAt','failureCode']);
    assert.equal(write.args.expectedObservedAt,at(0));
    assert.equal(f.state.codex.globalFailureCode,classification==='inventory'?'browser_unavailable':classification);
    assert.equal(f.state.codex.lease,undefined);assert.equal(f.state.codex.holds,undefined);
    assert.equal(f.state.requests.length,0);assert.equal(f.state.codex.receipts.length,0);
    assert.equal(f.health.length,0);assert.equal(f.record.state,'blocked');
  }
});

test('idle backend CAS guards never overwrite a newer lease, unknown fault, failure origin or official evidence',()=>{
  const variants=[s=>{s.codex.lease={id:'original-op',token:'retained-original'};},
    s=>{s.codex.globalFailureCode='unknown';s.codex.lastError='retained original result';},
    s=>{s.codex.operationFailureOrigin={operationId:'original-op'};},
    s=>{s.codex.observation=evidence(119);},s=>{s.codex.enabled=false;},
    s=>{s.codex.testOnly=true;},s=>{s.config.inventoryVerified=false;},
    s=>{s.config.workspaceId='other';},s=>{s.config.protectedEmails=[];}];
  for(const change of variants) {
    const s=initial();change(s);const before=structuredClone(s);
    assert.throws(()=>applyIdleObservation(s,{observation:evidence(120),expectedObservedAt:at(0)},at(120)));
    assert.throws(()=>recordIdleFailure(s,{failureCode:'browser_unavailable',expectedObservedAt:at(0)},at(120)));
    assert.deepEqual(s,before);
  }
  for(const args of [{observation:evidence(120),expectedObservedAt:'invalid'},
    {observation:evidence(120),expectedObservedAt:at(0),targetId:'never-accept-target'}])
    assert.throws(()=>applyIdleObservation(initial(),args,at(120)),/参数/);
  assert.throws(()=>recordIdleFailure(initial(),{failureCode:'mail_delivery',expectedObservedAt:at(0)},at(120)),/参数/);
});

test('a cloud claim arriving during the official read prevents the idle write and any false health recovery',async()=>{
  const f=fixture();f.browser.observe=async()=>{
    f.state.codex.lease={id:'concurrent-op',token:'retained'};return f.raw();
  };
  assert.deepEqual(await f.run(),{state:'skipped',reason:'state_changed'});
  assert.equal(f.calls.some(c=>c.name==='observe_idle_workspace'),false);assert.equal(f.health.length,0);
  assert.equal(f.state.codex.observation.observedAt,at(0));assert.equal(f.state.codex.lease.id,'concurrent-op');
});

test('a claim racing after the final preflight is atomically rejected by the dedicated idle write',async()=>{
  const f=fixture(),call=f.portal.call;
  f.portal.call=async(name,args)=>{
    if(name==='observe_idle_workspace')f.state.codex.lease={id:'last-moment-claim',token:'retained'};
    return call(name,args);
  };
  await assert.rejects(f.run(),/未结案/);
  assert.equal(f.state.codex.observation.observedAt,at(0));assert.equal(f.state.codex.lease.id,'last-moment-claim');
  assert.equal(f.health.length,0);
});

test('cancellation during observation stops cleanly without fault registration, cloud write or health reset',async()=>{
  for(const thrown of [false,true]) {
    const f=fixture();let stopping=false;
    f.browser.observe=async({shouldStop})=>{
      stopping=true;assert.equal(await shouldStop(),true);
      if(thrown)throw Object.assign(new Error('cancelled'),{code:'OFFICIAL_READ_CANCELLED'});
      return f.raw();
    };
    assert.deepEqual(await f.run({shouldStop:async()=>stopping}),{state:'stopped'});
    assert.equal(f.calls.some(c=>c.name!=='seat_portal_status'),false);assert.equal(f.health.length,0);
    assert.equal(f.state.codex.globalFailureCode,undefined);
  }
});

test('a successful observation RPC cannot reset health if its readback is stale, leased or globally blocked',async()=>{
  for(const variant of ['stale','leased','fault']) {
    const f=fixture(),call=f.portal.call;let submitted=false;
    f.portal.call=async(name,args)=>{
      if(name==='observe_idle_workspace'&&variant==='stale'){submitted=true;return {plan:workPlan(f.state,at(120))};}
      const value=await call(name,args);
      if(name==='observe_idle_workspace')submitted=true;
      if(name==='seat_portal_status'&&submitted) {
        if(variant==='leased')value.plan.lease={id:'postwrite-claim'};
        if(variant==='fault')value.plan.globalFailureCode='unknown';
      }
      return value;
    };
    await assert.rejects(f.run(),/健康检查/);assert.equal(f.health.length,0);assert.equal(f.record.state,'blocked');
  }
});

test('whitelist revocation during an invitation-only removal claim protects a joined employee in the executor',async()=>{
  let s=initial();s=transition(s,staff,{type:'apply',name:'Staff',reason:'Work',hours:1},at(1));
  s=transition(s,owner,{type:'tick'},at(1));
  s=claimOperation(s,'invite',s.requests[0].id,'initial-invite',at(2));
  s=completeOperation(s,{operationId:s.codex.lease.id,token:'initial-invite',outcome:'verified',
    invitationSentAt:at(2),observation:evidence(3,[],[person])},at(3));
  s=transition(s,owner,{type:'configure',config:{whitelist:[]}},at(4));
  let joined=false,reads=0;const calls=[],clicks=[];
  const portal={async call(name,args={}) {
    calls.push({name,args:structuredClone(args)});
    if(name==='process_seat_queue'){s=transition(s,owner,{type:'tick'},at(5));return {mailMode:'in_app'};}
    if(name==='observe_workspace')s=observeWorkspace(s,args.observation,at(5));
    if(name==='claim_seat_operation')s=claimOperation(s,args.kind,args.targetId,'revoke-only',at(5));
    if(name==='complete_seat_operation')s=completeOperation(s,args,at(5));
    return {plan:workPlan(s,at(5))};
  }};
  const browser={async observe(){if(++reads===2)joined=true;return evidence(5,joined?[person]:[],joined?[]:[person]);},
    async remove(){clicks.push('remove');},async invite(){clicks.push('invite');}};
  const result=await runBatch({portal,browser,config:validateConfig({liveActions:true,legacyCheckerDisabled:true,mailMode:'in_app'}),
    maxItems:1,clock:()=>new Date(at(5))});
  assert.deepEqual(clicks,[]);assert.equal(s.requests[0].status,'active');assert.equal(s.codex.lease,undefined);
  assert.equal(result.actions[0].outcome,'joined');
  assert.equal(calls.find(c=>c.name==='complete_seat_operation').args.outcome,'joined');
});
