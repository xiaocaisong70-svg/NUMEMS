import test from "node:test";
import assert from "node:assert/strict";
import { createState, transition, viewState, PROTECTED_OWNER_EMAIL, upgradeState } from "../lib/seat-engine.ts";
import { TARGET_WORKSPACE_ID, TEST_EMAIL, observeWorkspace, prepareTest, claimOperation,
  completeOperation, workPlan, setTestDeadline, setBridgeMode } from "../lib/codex-bridge.ts";
const NOW = "2026-10-20T06:00:00.000Z";
const at = seconds => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const owner = { userId:"owner", email:PROTECTED_OWNER_EMAIL, isAdmin:true };
const member = { email:TEST_EMAIL, role:"member" };
function snapshot(seconds = 0, members = [], invites = []) {
  return { workspaceId:TARGET_WORKSPACE_ID, accountEmail:PROTECTED_OWNER_EMAIL,
    pageUrl:"https://admin.openai.com/workspace/" + TARGET_WORKSPACE_ID + "/members",
    observedAt:at(seconds), complete:true, totalSeats:2,
    members:[{email:PROTECTED_OWNER_EMAIL, role:"owner"}, ...members], invites };
}
const initial = () => observeWorkspace(createState(NOW), snapshot(), NOW);
const pilot = () => prepareTest(initial(), NOW);
function invited() {
  let s = pilot(); const id = s.requests[0].id;
  s = claimOperation(s, "invite", id, "invite-1", NOW);
  return completeOperation(s, { operationId:s.codex.lease.id, token:"invite-1", outcome:"verified",
    observation:snapshot(1, [], [member]) }, at(1));
}
function active() { return observeWorkspace(invited(), snapshot(2, [member]), at(2)); }

test("verified test employee can see and renew their admin-created pilot only", () => {
  const s = active(); const id = s.requests[0].id;
  const employee = { userId: "actual-sites-user-id", email: TEST_EMAIL, isAdmin: false };
  assert.equal(viewState(s, employee).requests[0].id, id);
  assert.ok(viewState(s, employee).notices.length > 0);
  const renewed = transition(s, employee, { type: "renew", id, hours: 3 }, at(3));
  assert.equal(renewed.requests[0].expiresAt, at(10803));
  const outsider = { ...employee, email: "outsider@example.com" };
  assert.equal(viewState(s, outsider).requests.length, 0);
  assert.equal(viewState(s, outsider).notices.length, 0);
  assert.throws(() => transition(s, outsider, { type: "renew", id, hours: 3 }, at(3)), /未找到/);
  const ordinary = structuredClone(s);
  ordinary.requests[0].userId = "another-real-account";
  assert.equal(viewState(ordinary, employee).requests.length, 0);
});

test("wrong workspace, account, URL, incomplete or stale evidence is rejected", () => {
  for (const change of [
    {workspaceId:"wrong"}, {accountEmail:"outsider@example.com"}, {complete:false},
    {pageUrl:"https://unrelated.example/members"}, {observedAt:at(-61)},
    {members:[]},
  ]) assert.throws(() => observeWorkspace(createState(NOW), {...snapshot(), ...change}, NOW));
});
test("pilot records a real request and serializes member operations", () => {
  const s = pilot();
  assert.equal(s.requests[0].email, TEST_EMAIL);
  assert.equal(s.requests[0].hours, 1); assert.equal(s.requests[0].isTest, true);
  assert.equal(s.requests[0].status, "pending_invite");
  const claimed = claimOperation(s, "invite", s.requests[0].id, "one", NOW);
  assert.throws(() => claimOperation(claimed, "invite", s.requests[0].id, "two", NOW), /未结束/);
  const unknown = completeOperation(claimed, {operationId:claimed.codex.lease.id, token:"one",
    outcome:"uncertain", detail:"Browser timed out"}, at(3));
  assert.equal(unknown.codex.lease.status, "uncertain");
  assert.throws(() => claimOperation(unknown, "invite", s.requests[0].id, "two", at(200)), /未结束/);
});
test("live actual capacity and pending invitations prevent duplicate grants", () => {
  let s = pilot(); const id = s.requests[0].id;
  s.codex.observation = snapshot(0, [{email:"other@example.com", role:"member"}]);
  assert.throws(() => claimOperation(s, "invite", id, "one", NOW), /增购/);
  s.codex.observation = snapshot(0, [], [member]);
  assert.throws(() => claimOperation(s, "invite", id, "one", NOW), /已存在/);
});
test("verified invitation requires post-action proof and correct lease", () => {
  let s = pilot(); s = claimOperation(s, "invite", s.requests[0].id, "one", at(0));
  const base = {operationId:s.codex.lease.id, token:"one", outcome:"verified"};
  assert.throws(() => completeOperation(s, {...base, token:"wrong", observation:snapshot(1, [], [member])}, at(1)), /不匹配/);
  assert.throws(() => completeOperation(s, {...base, observation:snapshot(1)}, at(1)), /实际邀请/);
  assert.throws(() => completeOperation(s, {...base, observation:snapshot(-1, [], [member])}, at(1)), /操作后/);
  const done = completeOperation(s, {...base, observation:snapshot(1, [], [member])}, at(1));
  assert.equal(done.requests[0].status, "invited"); assert.equal(done.codex.lease, undefined);
  assert.deepEqual(completeOperation(done, base, at(2)), done);
});
test("acceptance starts one-hour lease, 30-minute mail is unique and needs Gmail receipt", () => {
  let s = active(); const id = s.requests[0].id;
  assert.equal(s.requests[0].expiresAt, at(3602));
  s = setTestDeadline(s, id, "reminder", at(3));
  const plan = workPlan(s, at(3));
  assert.equal(plan.reminders.length, 1);
  s = claimOperation(s, "mail", plan.reminders[0].id, "mail-one", at(3));
  const base = {operationId:s.codex.lease.id, token:"mail-one", outcome:"verified"};
  assert.throws(() => completeOperation(s, base, at(4)), /Gmail/);
  s = completeOperation(s, {...base, providerMessageId:"gmail_message_123"}, at(4));
  assert.equal(s.notices.find(n => n.type === "expiry_30m").status, "sent");
  assert.equal(workPlan(s, at(4)).reminders.length, 0);
  assert.ok(s.codex.mailVerifiedAt);
});
test("actual membership removal is verified before freeing capacity", () => {
  let s = active(); const id = s.requests[0].id;
  s = setTestDeadline(s, id, "expire", at(4));
  assert.equal(s.requests[0].status, "pending_removal");
  s = observeWorkspace(s, snapshot(5, [member]), at(5));
  s = claimOperation(s, "remove", id, "remove-one", at(5));
  const base = {operationId:s.codex.lease.id, token:"remove-one", outcome:"verified"};
  assert.throws(() => completeOperation(s, {...base, observation:snapshot(6, [member])}, at(6)), /仍在/);
  s = completeOperation(s, {...base, observation:snapshot(6)}, at(6));
  assert.equal(s.requests[0].status, "completed"); assert.ok(s.codex.removalVerifiedAt);
  assert.equal(s.codex.lease, undefined);
});
test("revoking a pending invitation does not claim a real-member removal test", () => {
  let s = invited(); const id = s.requests[0].id;
  s = transition(s, owner, {type:"release", id}, at(2));
  s = observeWorkspace(s, snapshot(3, [], [member]), at(3));
  s = claimOperation(s, "remove", id, "revoke", at(3));
  s = completeOperation(s, {operationId:s.codex.lease.id, token:"revoke", outcome:"verified",
    observation:snapshot(4)}, at(4));
  assert.ok(s.codex.invitationRevokedAt); assert.equal(s.codex.removalVerifiedAt, undefined);
  assert.throws(() => setBridgeMode(s, true, at(5)), /验证/);
});
test("renewed reminders cannot be claimed using an old expiry", () => {
  let s = active(); const id = s.requests[0].id;
  s = setTestDeadline(s, id, "reminder", at(3)); const noticeId = workPlan(s, at(3)).reminders[0].id;
  s = transition(s, {userId:"test:" + TEST_EMAIL, email:TEST_EMAIL, isAdmin:false},
    {type:"renew", id, hours:3}, at(4));
  assert.throws(() => claimOperation(s, "mail", noticeId, "mail", at(4)), /失效/);
});
test("new Owners halt the worker and cannot enter removal", () => {
  let s = pilot();
  s = observeWorkspace(s, snapshot(2, [{email:"second-owner@example.com", role:"owner"}]), at(2));
  assert.equal(s.codex.enabled, false); assert.equal(s.config.automationEnabled, false);
  assert.ok(s.config.protectedEmails.includes("second-owner@example.com"));
});

test("an invitation promoted to admin cannot be automatically revoked", () => {
  let s = invited(); const id = s.requests[0].id;
  s = transition(s, owner, { type: "release", id }, at(2));
  s = observeWorkspace(s, snapshot(3, [], [{ email: TEST_EMAIL, role: "admin" }]), at(3));
  assert.throws(() => claimOperation(s, "remove", id, "protected-invite", at(3)), /管理员/);
});

test("expired or released leases do not leave stale email work", () => {
  let s = active(); const id = s.requests[0].id;
  s = setTestDeadline(s, id, "reminder", at(3));
  assert.equal(workPlan(s, at(1803)).reminders.length, 0);
  const expired = transition(s, owner, { type: "tick" }, at(1803));
  assert.equal(expired.notices.find(n => n.type === "expiry_30m").status, "cancelled");
  const released = transition(s, owner, { type: "release", id }, at(4));
  assert.equal(workPlan(released, at(4)).reminders.length, 0);
  assert.equal(released.notices.find(n => n.type === "expiry_30m").status, "cancelled");
});
test("test clock cannot change ordinary employee leases", () => {
  let s = active(); s.requests[0].isTest = false;
  assert.throws(() => setTestDeadline(s, s.requests[0].id, "expire", at(3)), /授权测试/);
});
test("legacy JSON upgrades units while honoring already accepted deadlines", () => {
  const s = createState(NOW); delete s.config.leaseHours; s.config.leaseDays = 7;
  s.requests.push({id:"legacy", userId:"a", email:"a@example.com", name:"a", reason:"old",
    days:7, status:"active", createdAt:NOW, updatedAt:NOW, expiresAt:at(36000)});
  const upgraded = upgradeState(s);
  assert.equal(upgraded.config.leaseHours, 3); assert.equal(upgraded.requests[0].hours, 3);
  assert.equal(upgraded.requests[0].expiresAt, at(36000)); assert.equal("days" in upgraded.requests[0], false);
});
