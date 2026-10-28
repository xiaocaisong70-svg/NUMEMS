import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,transition,PROTECTED_OWNER_EMAIL} from '../lib/seat-engine.ts';
import {observeWorkspace,claimOperation,completeOperation,TARGET_WORKSPACE_ID} from '../lib/codex-bridge.ts';
const detail='程序办理未完成；保留原租约和证据，不自动重做外部动作。';
function fixture(kind='invite') {
  let ms=Date.parse('2026-10-27T10:00:00Z');const now=()=>new Date(ms).toISOString();
  const email='person@example.com',owner={userId:'owner',email:PROTECTED_OWNER_EMAIL,isAdmin:true};
  const person={userId:'person',email,isAdmin:false};
  const snapshot={workspaceId:TARGET_WORKSPACE_ID,accountEmail:PROTECTED_OWNER_EMAIL,complete:true,totalSeats:4,
    observedAt:now(),pageUrl:`https://admin.openai.com/workspace/${TARGET_WORKSPACE_ID}/members`,
    members:[{email:PROTECTED_OWNER_EMAIL,role:'owner'}],invites:[]};
  let state=observeWorkspace(createState(now()),snapshot,now());
  state=transition(state,owner,{type:'configure',config:{automationEnabled:true,whitelist:[email]}},now());
  state.codex.enabled=true;state.codex.testOnly=false;state.codex.mailEnabled=false;
  state=transition(state,person,{type:'apply',name:'Person',reason:'work',hours:1},now());
  state=transition(state,owner,{type:'tick'},now());const requestId=state.requests[0].id;
  state=claimOperation(state,'invite',requestId,'invite-token',now());
  if(kind==='remove'||kind==='joined') {
    ms+=1000;snapshot.observedAt=now();snapshot.members.push({email,role:'member'});
    state=completeOperation(state,{operationId:state.codex.lease.id,token:'invite-token',outcome:'verified',observation:snapshot},now());
    ms+=1000;state=transition(state,owner,{type:'release',id:requestId},now());
    if(kind==='joined') {
      ms+=6*60_000;
      state.requests[0].removalReason='invitation_expired';snapshot.members=snapshot.members.filter(p=>p.email!==email);
      snapshot.invites=[{email,role:'member'}];snapshot.observedAt=now();state.codex.observation=structuredClone(snapshot);
    }
    state=claimOperation(state,'remove',requestId,'remove-token',now());
  }
  const op=structuredClone(state.codex.lease);ms+=1000;
  state=completeOperation(state,{operationId:op.id,token:op.token,outcome:'uncertain',failureCode:'unknown',detail},now());
  const finish=(patch={})=>{
    ms+=1000;snapshot.observedAt=now();
    snapshot.invites=[];snapshot.members=[{email:PROTECTED_OWNER_EMAIL,role:'owner'},
      ...(kind==='invite'||kind==='joined'?[{email,role:'member'}]:[])];
    return completeOperation(state,{operationId:op.id,token:op.token,outcome:kind==='joined'?'joined':'verified',
      observation:structuredClone(snapshot),...patch},now());
  };
  return {get state(){return state},set state(s){state=s},op,snapshot,email,requestId,now,finish};
}
test('original invite and removal faults clear atomically only with exact original-token completion',()=>{
  for(const kind of ['invite','remove','joined']) {
    const f=fixture(kind),origin=f.state.codex.operationFailureOrigin;
    assert.equal(origin.operationId,f.op.id);assert.equal(origin.requestId,f.requestId);
    const next=f.finish();assert.equal(next.codex.globalFailureCode,undefined,kind);
    assert.equal(next.codex.lastError,undefined,kind);assert.equal(next.codex.operationFailureOrigin,undefined);
    assert.equal(next.codex.lease,undefined);assert.equal(next.codex.receipts.filter(r=>r.id===f.op.id).length,1);
    assert.equal(next.audit.filter(a=>a.action==='codex_resolved_original_operation_fault').length,1);
    const again=completeOperation(next,{operationId:f.op.id,token:f.op.token,outcome:'verified'},f.now());
    assert.deepEqual(again,next,'receipt replay does not create another resolution');
  }
});
test('legacy faults, later incidents, wrong token and changed safety evidence do not clear a pause',()=>{
  for(const variant of ['legacy','new_failure','wrong_token','role_fault','capacity','extra_admin','duplicates','before_failure','disabled','holds']) {
    const f=fixture();
    if(variant==='legacy')delete f.state.codex.operationFailureOrigin;
    if(variant==='new_failure')f.state.audit.push({id:'codex_other_incident',at:f.now(),action:'codex_workspace_blocked',actor:PROTECTED_OWNER_EMAIL,requestId:f.requestId});
    if(variant==='role_fault')f.state.codex.globalFailureCode='role_mismatch';
    if(variant==='disabled')f.state.codex.enabled=false;
    if(variant==='holds')f.state.codex.holds=[{operation:{...f.op,id:'other'},code:'member_action',detail:'other target',at:f.now(),attempted:true}];
    const patch={};
    if(variant==='wrong_token')patch.token='wrong';
    if(['capacity','extra_admin','duplicates','before_failure'].includes(variant)) {
      patch.observation={...f.snapshot,observedAt:f.now(),members:[{email:PROTECTED_OWNER_EMAIL,role:'owner'},{email:f.email,role:'member'}],invites:[]};
      if(variant==='capacity')patch.observation.totalSeats=5;
      if(variant==='extra_admin')patch.observation.members.push({email:'manager@example.com',role:'admin'});
      if(variant==='duplicates')patch.observation.invites.push({email:f.email,role:'member'});
      if(variant==='before_failure')patch.observation.observedAt='2026-10-27T10:00:00.000Z';
    }
    if(variant==='wrong_token')assert.throws(()=>f.finish(patch));
    else {const next=f.finish(patch);assert.ok(next.codex.globalFailureCode,variant);assert.equal(next.audit.some(a=>a.action==='codex_resolved_original_operation_fault'),false,variant);}
  }
});
test('a later different failure invalidates provenance instead of being cleared by target success',()=>{
  const f=fixture();
  f.state=completeOperation(f.state,{operationId:f.op.id,token:f.op.token,outcome:'blocked',
    failureCode:'role_mismatch',detail:'different safety fault'},f.now());
  assert.equal(f.state.codex.operationFailureOrigin,undefined);
  const next=f.finish();assert.equal(next.codex.globalFailureCode,'role_mismatch');
  assert.equal(next.codex.lastError,'different safety fault');
});
test('another global fault cannot acquire original-operation provenance by overwriting its error',()=>{
  const f=fixture();delete f.state.codex.operationFailureOrigin;f.state.codex.globalFailureCode='capacity_mismatch';
  f.state=completeOperation(f.state,{operationId:f.op.id,token:f.op.token,outcome:'uncertain',
    failureCode:'unknown',detail},f.now());
  assert.equal(f.state.codex.operationFailureOrigin,undefined);
  assert.equal(f.finish().codex.globalFailureCode,'unknown');
});
