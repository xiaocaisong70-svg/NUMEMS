import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,transition,viewState,PROTECTED_OWNER_EMAIL} from '../lib/seat-engine.ts';
import {observeWorkspace,claimOperation,completeOperation,workPlan,TARGET_WORKSPACE_ID} from '../lib/codex-bridge.ts';

const base='2026-10-28T06:00:00.000Z';
const at=n=>new Date(Date.parse(base)+n*1000).toISOString();
const owner={userId:'owner',email:PROTECTED_OWNER_EMAIL,isAdmin:true};
const staff=i=>({userId:`staff-${i}`,email:`staff-${i}@example.com`,isAdmin:false});
const person=i=>({email:staff(i).email,role:'member'});
function snapshot(n,members=[],invites=[]) {
  return {workspaceId:TARGET_WORKSPACE_ID,accountEmail:owner.email,
    pageUrl:`https://admin.openai.com/workspace/${TARGET_WORKSPACE_ID}/members`,
    complete:true,totalSeats:2,observedAt:at(n),
    members:[{email:owner.email,role:'owner'},...members],invites};
}
function setup() {
  let s=transition(createState(base),owner,{type:'configure',config:{totalSeats:2,
    automationEnabled:true,workspaceId:TARGET_WORKSPACE_ID,whitelist:[staff(0).email,staff(1).email]}},base);
  s=observeWorkspace(s,snapshot(0),base);
  s.codex.enabled=true;s.codex.testOnly=false;
  return s;
}
const apply=(s,i=0,n=0)=>transition(s,staff(i),{type:'apply',name:`Staff ${i}`,reason:'Work',hours:1},at(n));
const tick=(s,n=0)=>transition(s,owner,{type:'tick'},at(n));
const revoke=(s,n=2)=>transition(s,owner,{type:'configure',config:{whitelist:[staff(1).email]}},at(n));
function invited() {
  let s=tick(apply(setup()));
  s=claimOperation(s,'invite',s.requests[0].id,'first-invite',at(1));
  return completeOperation(s,{operationId:s.codex.lease.id,token:'first-invite',outcome:'verified',
    invitationSentAt:at(1),observation:snapshot(1,[],[person(0)])},at(1));
}

test('revoking queued authorization cancels once and never allocates the revoked email',()=>{
  let s=apply(setup());
  s=revoke(s);
  assert.equal(s.requests[0].status,'cancelled');
  assert.equal(s.requests[0].authorizationRevokedAt,at(2));
  assert.equal(s.notices.filter(n=>n.type==='authorization_revoked').length,1);
  assert.deepEqual(tick(s,3),s);
  assert.equal(workPlan(s,at(3)).invites.length,0);
  assert.throws(()=>apply(s,0,4),/白名单|授权员工/);
});

test('revocation invalidates a prepared invite but conserves capacity until fresh official absence',()=>{
  let s=tick(apply(setup()));
  s=apply(s,1,1);
  const revokedId=s.requests[0].id;
  s=revoke(s);
  assert.equal(s.requests[0].status,'pending_removal');
  assert.equal(s.requests[0].removalReason,'whitelist_revoked');
  assert.equal(s.requests[1].status,'queued');
  assert.equal(viewState(s,owner,at(2)).aggregate.availableSeats,0);
  assert.equal(workPlan(s,at(2)).invites.length,0);
  assert.throws(()=>claimOperation(s,'invite',revokedId,'stale-invite',at(2)),/状态/);
  assert.throws(()=>claimOperation(s,'remove',revokedId,'old-snapshot',at(2)),/撤销后的/);
  const old=observeWorkspace(s,snapshot(1),at(2));
  assert.equal(old.requests[0].status,'pending_removal');
  s=observeWorkspace(s,snapshot(3),at(3));
  assert.equal(s.requests[0].status,'completed');
  assert.equal(s.requests[1].status,'pending_invite');
  assert.deepEqual(workPlan(s,at(3)).invites.map(r=>r.email),[staff(1).email]);
});

test('workPlan and claim independently reject stale pre-V12 pending grants without relying on configure',()=>{
  const s=tick(apply(setup()));
  s.config.whitelist=[staff(1).email];
  assert.equal(workPlan(s,at(1)).invites.length,0);
  assert.throws(()=>claimOperation(s,'invite',s.requests[0].id,'stale-plan',at(1)),/白名单授权已撤销/);
  const repaired=tick(s,2);
  assert.equal(repaired.requests[0].status,'pending_removal');
  assert.equal(repaired.requests[0].removalReason,'whitelist_revoked');
});

test('sent invitation revocation claims invitation only, protects a concurrent join and preserves seats',()=>{
  let s=revoke(invited());
  const id=s.requests[0].id;
  s=observeWorkspace(s,snapshot(3,[],[person(0)]),at(3));
  s=claimOperation(s,'remove',id,'revoke-sent',at(3));
  const op=s.codex.lease;
  assert.equal(op.originalPresence,'invite');
  s=completeOperation(s,{operationId:op.id,token:op.token,outcome:'joined',
    observation:snapshot(4,[person(0)])},at(4));
  assert.equal(s.requests[0].status,'active');
  assert.equal(s.requests[0].expiresAt,at(3604));
  assert.equal(s.requests[0].removalReason,undefined);
  assert.equal(s.codex.lease,undefined);
  assert.equal(workPlan(s,at(4)).removals.length,0);
  assert.equal(viewState(s,owner,at(4)).aggregate.availableSeats,0);
});

test('a current member is protected before a whitelist-revocation claim and retains normal expiry',()=>{
  let s=revoke(invited());
  // A forged/stale plan must not bypass the claim-time member check.
  s.codex.observation=snapshot(3,[person(0)]);
  assert.throws(()=>claimOperation(s,'remove',s.requests[0].id,'never-remove-member',at(3)),/已加入/);
  s=observeWorkspace(s,snapshot(3,[person(0)]),at(3));
  const expiry=s.requests[0].expiresAt;
  assert.equal(s.requests[0].status,'active');
  assert.equal(workPlan(s,at(3)).removals.length,0);
  s=revoke(s,4);
  assert.equal(s.requests[0].status,'active');
  assert.equal(s.requests[0].expiresAt,expiry);
  s=tick(s,3603);
  assert.equal(s.requests[0].removalReason,'lease_expired');
});

test('revoking an already claimed invitation keeps its original lease, records actual send, then revokes the invitation',()=>{
  let s=tick(apply(setup()));
  s=claimOperation(s,'invite',s.requests[0].id,'original-inflight',at(1));
  const op=structuredClone(s.codex.lease);
  s=revoke(s,2);
  assert.deepEqual(s.codex.lease,op);
  assert.equal(s.requests[0].status,'pending_removal');
  assert.throws(()=>claimOperation(s,'remove',s.requests[0].id,'parallel-revoke',at(2)),/未结束/);
  assert.throws(()=>completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',
    observation:snapshot(3)},at(3)),/实际邀请/);
  s=completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',invitationSentAt:at(2.5),
    observation:snapshot(3,[],[person(0)])},at(3));
  assert.equal(s.codex.lease,undefined);
  assert.equal(s.requests[0].status,'pending_removal');
  assert.equal(s.requests[0].invitedAt,at(2.5));
  assert.equal(workPlan(s,at(3)).removals[0].removalReason,'whitelist_revoked');
  assert.equal(s.codex.receipts.at(-1).id,op.id);
});

test('a claim-authorized invite accepted during revocation completes from original evidence without kicking the member',()=>{
  let s=tick(apply(setup()));
  s=claimOperation(s,'invite',s.requests[0].id,'invite-joined',at(1));
  const op=s.codex.lease;
  s=revoke(s,2);
  s=completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',invitationSentAt:at(2.5),
    observation:snapshot(3,[person(0)])},at(3));
  assert.equal(s.requests[0].status,'active');
  assert.equal(s.requests[0].expiresAt,at(3603));
  assert.equal(s.codex.lease,undefined);
  assert.equal(workPlan(s,at(3)).removals.length,0);
});

test('revocation preserves held/uncertain invitation evidence and cannot bypass Owner protections',()=>{
  let s=tick(apply(setup()));
  s=claimOperation(s,'invite',s.requests[0].id,'unknown-invite',at(1));
  const op=s.codex.lease;
  s=completeOperation(s,{operationId:op.id,token:op.token,outcome:'uncertain',failureCode:'member_action'},at(1.5));
  const hold=structuredClone(s.codex.holds[0]);
  s=revoke(s);
  assert.deepEqual(s.codex.holds[0],hold);
  assert.equal(workPlan(s,at(2)).removals.length,0);
  assert.throws(()=>claimOperation(s,'remove',s.requests[0].id,'bypass-hold',at(2)),/撤销后的|隔离/);
  s=observeWorkspace(s,snapshot(3,[],[{email:staff(0).email,role:'admin'}]),at(3));
  assert.throws(()=>claimOperation(s,'remove',s.requests[0].id,'bypass-role',at(3)),/管理员|错误/);
});

test('re-adding the same email does not resurrect a cancelled request or erase the required official check',()=>{
  let s=revoke(tick(apply(setup())));
  s=transition(s,owner,{type:'configure',config:{whitelist:[staff(0).email,staff(1).email]}},at(3));
  assert.equal(s.requests[0].status,'pending_removal');
  assert.equal(workPlan(s,at(3)).invites.length,0);
  s=observeWorkspace(s,snapshot(4),at(4));
  s=tick(apply(s,0,5),5);
  assert.equal(s.requests[0].status,'completed');
  assert.equal(s.requests[1].status,'pending_invite');
  assert.notEqual(s.requests[0].id,s.requests[1].id);
  assert.equal(workPlan(s,at(5)).officialObservedAt,at(4));
});
