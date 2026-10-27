import test from "node:test";
import assert from "node:assert/strict";
import { createState, upgradeState, transition, viewState, PROTECTED_OWNER_EMAIL } from "../lib/seat-engine.ts";
import { queueForecast } from "../lib/queue-estimate.ts";
import { remainingSeconds, serverClock, countdownText } from "../lib/portal-time.ts";
import { observeWorkspace, claimOperation, completeOperation, workPlan, TARGET_WORKSPACE_ID } from "../lib/codex-bridge.ts";
import { pendingEvents, ADMIN_EMAIL, TARGET_WORKSPACE } from "../scripts/queue-checker-core.mjs";
const base = "2026-10-20T12:00:00.000Z";
const at = seconds => new Date(Date.parse(base) + seconds * 1000).toISOString();
const owner = { userId: "owner", email: PROTECTED_OWNER_EMAIL, isAdmin: true };
const staff = i => ({ userId: `user-${i}`, email: `employee${i}@example.com`, isAdmin: false });
function setup(seats = 2) {
  let s = transition(createState(base), owner, { type: "configure", config: {
    totalSeats: seats, automationEnabled: true, workspaceId: TARGET_WORKSPACE_ID,
    whitelist: Array.from({ length: 10 }, (_, i) => staff(i).email) } }, base);
  s = transition(s, owner, { type: "sync_inventory", members: [{ email: owner.email, role: "owner" }] }, base);
  s.codex = { enabled: true, testOnly: false, mailEnabled: true, receipts: [] };
  return s;
}
const tick = (s, t = 0) => transition(s, owner, { type: "tick" }, at(t));
function apply(s, i = 0, t = 0, hours = 1) {
  return transition(s, staff(i), { type: "apply", name: `Employee ${i}`, reason: "Fixture", hours }, at(t));
}
function invited() {
  let s = tick(apply(setup()));
  s = transition(s, owner, { type: "confirm_invited", id: s.requests[0].id, sentAt: at(10) }, at(12));
  return s;
}
function observation(t, members = [], invites = [], totalSeats = 2) {
  return { complete: true, workspaceId: TARGET_WORKSPACE_ID, accountEmail: owner.email,
    pageUrl: `https://admin.openai.com/workspace/${TARGET_WORKSPACE_ID}/members`, observedAt: at(t), totalSeats,
    members: [{ email: owner.email, role: "owner" }, ...members.map(email => ({ email, role: "member" }))],
    invites: invites.map(email => ({ email, role: "member" })) };
}
test("five minutes starts at actual recorded send, not application or receipt verification", () => {
  const s = invited(), r = s.requests[0];
  assert.equal(r.invitedAt, at(10)); assert.equal(r.joinDeadlineAt, at(310)); assert.equal(r.expiresAt, undefined);
  assert.equal(tick(s, 309.999).requests[0].status, "invited");
  assert.equal(tick(s, 310).requests[0].status, "pending_removal");
  assert.equal(tick(s, 310).requests[0].removalReason, "invitation_expired");
});
test("duplicate confirmation, refresh and migration do not reset the deadline", () => {
  const s = invited(), r = s.requests[0];
  const duplicate = transition(s, owner, { type:"confirm_invited", id:r.id, sentAt:at(40) }, at(40));
  assert.deepEqual(duplicate, s);
  assert.equal(upgradeState(duplicate).requests[0].joinDeadlineAt, at(310));
  assert.equal(viewState(s, staff(0), at(100)).requests[0].joinDeadlineAt, at(310));
});
test("legacy waiting invitations adopt five minutes but active usage deadlines are preserved", () => {
  const s = invited(); s.config.acceptHours = 24; delete s.config.acceptMinutes; delete s.requests[0].joinDeadlineAt;
  const active = { ...s.requests[0], id:"active", status:"active", expiresAt:at(7200) };
  s.requests.push(active);
  const upgraded = upgradeState(s);
  assert.equal(upgraded.config.acceptMinutes,5);
  assert.equal(upgraded.requests[0].joinDeadlineAt,at(310));
  assert.equal(upgraded.requests[1].expiresAt,at(7200));
  assert.throws(() => transition(s, owner, {type:"configure",config:{acceptHours:24}},base),/固定/);
});
test("timeout reserves capacity until a fresh official absence and then assigns next FIFO request", () => {
  let s = apply(invited(),1,15); s = apply(s,2,16);
  s = tick(s,310);
  assert.deepEqual(s.requests.map(r=>r.status),["pending_removal","queued","queued"]);
  assert.equal(viewState(s,owner,at(310)).aggregate.availableSeats,0);
  s = observeWorkspace(s,observation(311,[],[staff(0).email]),at(311));
  assert.equal(s.requests[1].status,"queued");
  s = claimOperation(s,"remove",s.requests[0].id,"revoke",at(311));
  s = completeOperation(s,{operationId:s.codex.lease.id,token:"revoke",outcome:"verified",observation:observation(312)},at(312));
  assert.deepEqual(s.requests.map(r=>r.status),["completed","pending_invite","queued"]);
  assert.equal(s.requests.filter(r=>r.status==="pending_invite").length,1);
  assert.equal(tick(s,313).notices.filter(n=>n.type==="invitation_expired").length,1);
});
test("membership snapshot taken before deadline activates even if processed after deadline", () => {
  let s = apply(invited(),1,15);
  // The complete official snapshot predates the deadline, while processing
  // occurs after it.
  s = observeWorkspace(s,observation(309,[staff(0).email]),at(311));
  assert.equal(s.requests[0].status,"active");
  assert.equal(s.requests[0].expiresAt,at(3909));
  assert.equal(s.requests[1].status,"queued");
  assert.throws(()=>claimOperation(s,"remove",s.requests[0].id,"stale-removal",at(311)),/状态/);
});
test("first membership sighting after deadline protects the member and retains FIFO capacity", () => {
  let s=apply(invited(),1,15);
  s=observeWorkspace(s,observation(305,[],[staff(0).email]),at(305));
  s=observeWorkspace(s,observation(311,[staff(0).email]),at(311));
  const r=s.requests[0];
  assert.equal(r.status,"active");
  assert.equal(r.joinTimingEvidence.firstMemberSeenAt,at(311));
  assert.equal(r.joinTimingEvidence.lastPendingSeenAt,at(305));
  assert.equal(r.expiresAt,at(3911));
  assert.equal(s.requests[1].status,"queued");
  assert.equal(viewState(s,owner,at(311)).aggregate.availableSeats,0);
  assert.equal(workPlan(s,at(311)).removals.length,0);
  assert.throws(()=>claimOperation(s,"remove",r.id,"unsafe",at(312)),/状态/);
});
test("after-deadline member is retained without claiming the click was within five minutes", () => {
  let s=observeWorkspace(invited(),observation(311,[staff(0).email]),at(311));
  assert.equal(s.requests[0].status,"active");
  assert.equal(s.requests[0].expiresAt,at(3911));
  assert.equal(workPlan(s,at(311)).removals.length,0);
  assert.equal(s.requests[0].joinTimingEvidence.firstMemberSeenAt,at(311));
});
test("an expired invitation cannot be claimed from a pre-deadline snapshot", () => {
  let s=observeWorkspace(invited(),observation(305,[],[staff(0).email]),at(305));
  s=tick(s,310);
  assert.throws(()=>claimOperation(s,"remove",s.requests[0].id,"stale",at(311)),/截止后/);
  s=observeWorkspace(s,observation(311,[],[staff(0).email]),at(311));
  assert.equal(claimOperation(s,"remove",s.requests[0].id,"fresh",at(311)).codex.lease.originalPresence,"invite");
});
test("joining during an invitation revocation ends that lease without removing the member", () => {
  let s=apply(invited(),1,15);
  s=observeWorkspace(s,observation(311,[],[staff(0).email]),at(311));
  s=claimOperation(s,"remove",s.requests[0].id,"race",at(311));
  const args={operationId:s.codex.lease.id,token:"race",outcome:"joined",observation:observation(312,[staff(0).email])};
  s=completeOperation(s,args,at(312));
  assert.equal(s.requests[0].status,"active");
  assert.equal(s.requests[1].status,"queued");
  assert.equal(s.codex.lease,undefined);
  assert.equal(s.codex.receipts.at(-1).kind,"joined_during_revocation");
  assert.equal(s.codex.removalVerifiedAt,undefined);
  assert.deepEqual(completeOperation(s,args,at(313)),s);
});
test("explicit early release is not undone just because the employee still appears in official membership", () => {
  let s = observeWorkspace(invited(),observation(20,[staff(0).email]),at(20));
  const id=s.requests[0].id;
  s=transition(s,staff(0),{type:"release",id},at(21));
  const once=structuredClone(s);
  assert.deepEqual(transition(s,staff(0),{type:"release",id},at(22)),once);
  s=observeWorkspace(s,observation(23,[staff(0).email]),at(23));
  assert.equal(s.requests[0].status,"pending_removal");assert.equal(s.requests[0].removalReason,"release");
  assert.throws(()=>transition(s,staff(1),{type:"release",id},at(24)),/未找到/);
  assert.throws(()=>transition(s,staff(0),{type:"renew",id,hours:3},at(24)),/正在使用/);
});
test("acceptance hint is authenticated, idempotent, bounded and cannot grant membership or extra time", () => {
  let s=invited(),id=s.requests[0].id;
  s=transition(s,staff(0),{type:"request_acceptance_check",id},at(20));
  assert.equal(s.requests[0].status,"invited");assert.equal(s.requests[0].joinDeadlineAt,at(310));
  assert.deepEqual(transition(s,staff(0),{type:"request_acceptance_check",id},at(21)),s);
  assert.throws(()=>transition(s,staff(1),{type:"request_acceptance_check",id},at(21)),/未找到/);
  assert.throws(()=>transition(s,staff(0),{type:"request_acceptance_check",id},at(310)),/结束/);
  const p={workspaceId:TARGET_WORKSPACE,administrator:ADMIN_EMAIL,enabled:true,testOnly:false,busy:false,lastError:null,invites:[],removals:[],reminders:[],awaitingAcceptance:s.requests};
  assert.equal(pendingEvents(p,Date.parse(at(21)))[0].kind,"acceptance");
  assert.deepEqual(pendingEvents(p,Date.parse(at(310))),[]);
});
test("three rotating slots are simulated independently in FIFO order, including equal-time requests", () => {
  let s=setup(4);
  for(let i=0;i<3;i++){s=apply(s,i);s=tick(s);const r=s.requests[i];r.status="active";r.expiresAt=at((i+1)*1800);}
  for(let i=3;i<7;i++)s=apply(s,i,1);
  const estimates=queueForecast(s,base).byRequest;
  assert.deepEqual(s.requests.slice(3).map(r=>estimates[r.id].latestAt),[at(1800),at(3600),at(5400),at(5700)]);
  const employee=viewState(s,staff(4),base),admin=viewState(s,owner,base);
  assert.equal(employee.queuePosition,2);
  assert.deepEqual(employee.aggregate,admin.aggregate);
  assert.deepEqual(employee.waitEstimate,admin.queueEstimates[s.requests[4].id]);
  assert.equal(JSON.stringify(employee).includes(staff(0).email),false);
});
test("waiting for invitation acceptance gives an estimate range rather than a guaranteed five-minute release", () => {
  const s=apply(invited(),1,15);
  const e=queueForecast(s,at(20)).byRequest[s.requests[1].id];
  assert.equal(e.earliestAt,at(310));assert.equal(e.latestAt,at(3910));
});
test("fixed, pending, isolated, unverified and paused capacity never produce a false available time", () => {
  for(const status of ["active","pending_invite","pending_removal"]){
    let s=tick(apply(setup()));s.requests[0].status=status;s=apply(s,1);
    assert.equal(queueForecast(s,base).byRequest[s.requests[1].id].status,"uncertain");
  }
  let s=apply(invited(),1);
  s.codex.holds=[{operation:{kind:"remove",email:staff(0).email}}];
  assert.equal(queueForecast(s,base).byRequest[s.requests[1].id].status,"uncertain");
  s.codex.holds=[{operation:{kind:"mail",email:staff(0).email}}];
  assert.equal(queueForecast(s,base).byRequest[s.requests[1].id].status,"estimated");
  s.codex.lastError="login expired";
  assert.equal(queueForecast(s,base).nextApplicant.status,"paused");
  s=setup(4);s.config.inventoryVerified=false;
  assert.equal(queueForecast(s,base).nextApplicant.status,"paused");
});
test("release, renew and confirmed recovery recompute waits from the same server snapshot", () => {
  let s=observeWorkspace(invited(),observation(20,[staff(0).email]),at(20)),id=s.requests[0].id;
  s=transition(s,staff(0),{type:"renew",id,hours:2},at(21));
  s=apply(s,1,22);
  assert.equal(queueForecast(s,at(22)).byRequest[s.requests[1].id].latestAt,at(7221));
  s=transition(s,staff(0),{type:"release",id},at(23));
  assert.equal(queueForecast(s,at(23)).byRequest[s.requests[1].id].status,"uncertain");
  s=observeWorkspace(s,observation(24),at(24));
  assert.equal(s.requests[1].status,"pending_invite");
});
test("countdown uses server UTC plus monotonic elapsed time, clamps zero and survives device wall-clock differences", () => {
  const clock=serverClock(base,100,5100);
  assert.equal(clock,Date.parse(at(5)));
  assert.equal(countdownText(remainingSeconds(at(300),clock)),"04:55");
  assert.equal(remainingSeconds(at(300),Date.parse(at(300))),0);
  assert.equal(remainingSeconds(at(300),Date.parse(at(999))),0);
  assert.equal(serverClock(base,100,0),Date.parse(base));
});
test("verified invitation receipt honors exact send time and rejects impossible timestamps", () => {
  let s=observeWorkspace(tick(apply(setup())),observation(1),at(1));
  s=claimOperation(s,"invite",s.requests[0].id,"sent",at(1));
  const args={operationId:s.codex.lease.id,token:"sent",outcome:"verified",observation:observation(20,[],[staff(0).email])};
  assert.throws(()=>completeOperation(s,{...args,invitationSentAt:at(0)},at(20)),/时间/);
  assert.throws(()=>completeOperation(s,{...args,invitationSentAt:at(21)},at(20)),/时间/);
  s=completeOperation(s,{...args,invitationSentAt:at(7)},at(20));
  assert.equal(s.requests[0].joinDeadlineAt,at(307));
});
test("an invite receipt can confirm a member seen after send before the receipt transaction commits", () => {
  let s=observeWorkspace(tick(apply(setup())),observation(1),at(1));
  s=claimOperation(s,"invite",s.requests[0].id,"receipt-race",at(1));
  const args={operationId:s.codex.lease.id,token:"receipt-race",outcome:"verified",
    observation:observation(20,[staff(0).email]),invitationSentAt:at(7)};
  // confirm_invited's updatedAt is t=21, but the member was validly observed
  // at t=20 after the claim/send. This is not a stale passive observation.
  s=completeOperation(s,args,at(21));
  assert.equal(s.requests[0].status,'active');assert.equal(s.requests[0].expiresAt,at(3620));
  assert.equal(s.codex.lease,undefined);
});
