import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,transition,PROTECTED_OWNER_EMAIL} from '../lib/seat-engine.ts';
import {observeWorkspace,claimOperation,TARGET_WORKSPACE_ID} from '../lib/codex-bridge.ts';

const base=Date.parse('2026-10-27T09:00:00.000Z');
const at=s=>new Date(base+s*1000).toISOString();
const owner={userId:'owner',email:PROTECTED_OWNER_EMAIL,isAdmin:true};
const staff=i=>({userId:`s${i}`,email:`s${i}@example.com`,isAdmin:false});
const obs=(t,members=[],invites=[],seats=2)=>({workspaceId:TARGET_WORKSPACE_ID,accountEmail:owner.email,
  pageUrl:`https://admin.openai.com/workspace/${TARGET_WORKSPACE_ID}/members`,complete:true,totalSeats:seats,observedAt:at(t),
  members:[{email:owner.email,role:'owner'},...members.map(email=>({email,role:'member'}))],
  invites:invites.map(email=>({email,role:'member'}))});
function setup(seats=2){
  let s=transition(createState(at(0)),owner,{type:'configure',config:{totalSeats:seats,automationEnabled:true,
    workspaceId:TARGET_WORKSPACE_ID,whitelist:[staff(0).email,staff(1).email,staff(2).email]}},at(0));
  s=observeWorkspace(s,obs(0,[],[],seats),at(0));
  s.codex={...s.codex,enabled:true,testOnly:false,mailEnabled:false,receipts:[]};return s;
}
function apply(s,i,t=1){return transition(s,staff(i),{type:'apply',name:`Employee ${i}`,reason:'Work',hours:1},at(t));}
function active(){
  let s=apply(setup(),0);
  s=transition(s,owner,{type:'tick'},at(2));
  s=transition(s,owner,{type:'confirm_invited',id:s.requests[0].id},at(3));
  return observeWorkspace(s,obs(4,[staff(0).email]),at(4));
}

test('fresh verified absence marks externally removed active member and advances FIFO without external action',()=>{
  let s=active(); const id=s.requests[0].id;
  s=apply(s,1,5);
  s.notices.push({id:'warning',key:`${id}:expiry_30m:${s.requests[0].expiresAt}`,requestId:id,userId:staff(0).userId,
    email:staff(0).email,type:'expiry_30m',title:'warning',message:'warning',createdAt:at(5),status:'pending'});
  s=observeWorkspace(s,obs(6),at(6));
  assert.equal(s.requests[0].status,'completed');
  assert.equal(s.requests[1].status,'pending_invite');
  assert.equal(s.notices.find(n=>n.id==='warning').status,'cancelled');
  assert.ok(s.audit.some(a=>a.action==='official_external_absence_confirmed'&&a.requestId===id));
  assert.ok(!s.codex.receipts.length);
});

test('old, incomplete, invited, held and claimed states do not falsely end active membership',()=>{
  for(const mode of ['old','invited','held','claimed']) {
    let s=active();
    if(mode==='held')s.codex.holds=[{code:'member_action',attempted:true,operation:{kind:'remove',email:staff(0).email}}];
    if(mode==='claimed')s.codex.lease={kind:'remove',email:staff(0).email,requestId:s.requests[0].id};
    const evidence=mode==='old'?obs(3):mode==='invited'?obs(5,[],[staff(0).email]):obs(5);
    // The state stores the newer t=4 snapshot; do not silently accept older evidence.
    if(mode==='old')assert.throws(()=>observeWorkspace(s,evidence,at(5)),/较旧/);
    else assert.equal(observeWorkspace(s,evidence,at(5)).requests[0].status,'active',mode);
  }
  assert.throws(()=>observeWorkspace(active(),{...obs(5),complete:false},at(5)),/完整/);
});

test('passive absent snapshot cannot close a held or claimed pending-removal request',()=>{
  for(const mode of ['held','claimed']){
    let s=active(),id=s.requests[0].id;
    s=transition(s,staff(0),{type:'release',id},at(5));
    if(mode==='held')s.codex.holds=[{code:'member_action',attempted:true,operation:{kind:'remove',email:staff(0).email}}];
    else s.codex.lease={kind:'remove',email:staff(0).email,requestId:id};
    s=observeWorkspace(s,obs(6),at(6));
    assert.equal(s.requests[0].status,'pending_removal',mode);
  }
});

test('a snapshot predating a renewal cannot cancel that newer active lease',()=>{
  let s=active(),id=s.requests[0].id;
  s=transition(s,staff(0),{type:'renew',id,hours:2},at(6));
  const expiry=s.requests[0].expiresAt;
  s=observeWorkspace(s,obs(5),at(7));
  assert.equal(s.requests[0].status,'active');assert.equal(s.requests[0].expiresAt,expiry);
});

test('passive external membership cannot override a held or claimed target',()=>{
  for(const mode of ['held','claimed']){
    let s=apply(setup(),0);const id=s.requests[0].id;
    s=transition(s,owner,{type:'tick'},at(2));
    if(mode==='held')s.codex.holds=[{code:'member_action',attempted:true,operation:{kind:'invite',email:staff(0).email}}];
    else s.codex.lease={kind:'invite',email:staff(0).email,requestId:id};
    s=observeWorkspace(s,obs(3,[staff(0).email]),at(3));
    assert.equal(s.requests[0].status,'pending_invite',mode);
  }
});

test('fresh verified external join turns queued request active with explicit confirmation-time lease',()=>{
  let s=apply(setup(),0),id=s.requests[0].id;
  s=observeWorkspace(s,obs(10,[staff(0).email]),at(10));
  assert.equal(s.requests[0].status,'active');assert.equal(s.requests[0].expiresAt,at(3610));
  assert.ok(s.audit.some(a=>a.action==='official_external_join_confirmed'&&a.requestId===id));
  assert.ok(!s.codex.receipts.length);
});

test('external join competing with reserved capacity pauses globally instead of exceeding capacity silently',()=>{
  let s=setup(3);for(let i=0;i<3;i++)s=apply(s,i,i+1);
  s=transition(s,owner,{type:'tick'},at(4));
  assert.deepEqual(s.requests.map(r=>r.status),['pending_invite','pending_invite','queued']);
  s=observeWorkspace(s,obs(5,[staff(2).email],[],3),at(5));
  assert.equal(s.requests[2].status,'active');assert.equal(s.codex.globalFailureCode,'capacity_mismatch');
  assert.throws(()=>claimOperation(s,'invite',s.requests[0].id,'no-extra-seat',at(5)),/未解决错误/);
});

test('only internal reconciliation may invoke the new transitions',()=>{
  const s=active(),id=s.requests[0].id;
  assert.throws(()=>transition(s,owner,{type:'confirm_external_absence',id},at(5)),/只能由官方名单/);
  assert.throws(()=>transition(apply(setup(),0),owner,{type:'confirm_external_join',id:'missing'},at(5)),/只能由官方名单/);
});
