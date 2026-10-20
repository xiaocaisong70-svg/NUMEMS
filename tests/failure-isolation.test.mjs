import test from "node:test";
import assert from "node:assert/strict";
import { createState, transition, PROTECTED_OWNER_EMAIL } from "../lib/seat-engine.ts";
import { observeWorkspace, workPlan, claimOperation, completeOperation, deferOperation,
  reviewFailure, TARGET_WORKSPACE_ID } from "../lib/codex-bridge.ts";
import { pendingEvents, prepareWake, applyAcknowledgement } from "../scripts/queue-checker-core.mjs";
const T = Date.parse("2026-10-20T12:00:00Z"), at = n => new Date(T + n * 1000).toISOString();
const owner = { userId: "owner", email: PROTECTED_OWNER_EMAIL, isAdmin: true };
const a = { email: "alice@example.com", role: "member" }, b = { email: "bob@example.com", role: "member" };
const obs = (n = 0, members = [a, b]) => ({
  workspaceId: TARGET_WORKSPACE_ID, accountEmail: owner.email, complete: true, totalSeats: 4,
  pageUrl: `https://admin.openai.com/workspace/${TARGET_WORKSPACE_ID}/members`,
  observedAt: at(n), members: [{ email: owner.email, role: "owner" }, ...members], invites: [],
});
function fixture(bothExpired = false) {
  let s = observeWorkspace(createState(at(0)), obs(), at(0));
  s.codex.enabled = true; s.codex.testOnly = false;
  s.config.automationEnabled = true;
  s.requests.find(r => r.email === a.email).expiresAt = at(bothExpired ? -1 : 600);
  s.requests.find(r => r.email === b.email).expiresAt = at(-1);
  return transition(s, owner, { type: "tick" }, at(0));
}
const req = (s, address) => s.requests.find(r => r.email === address);
function failedMail(s = fixture()) {
  const id = workPlan(s, at(0)).reminders[0].id;
  s = claimOperation(s, "mail", id, "mail-token", at(0));
  return completeOperation(s, { operationId: s.codex.lease.id, token: "mail-token",
    outcome: "uncertain", failureCode: "mail_delivery", detail: "Send result unknown" }, at(1));
}

test("unknown mail delivery is isolated; unrelated overdue member can still be removed", () => {
  const s = failedMail();
  assert.equal(s.codex.lease, undefined);
  assert.equal(s.codex.lastError, undefined);
  assert.equal(s.codex.holds.length, 1);
  assert.equal(workPlan(s, at(1)).reminders.length, 0);
  assert.throws(() => claimOperation(s, "mail", s.codex.holds[0].operation.targetId, "duplicate", at(1)), /隔离/);
  const claimed = claimOperation(s, "remove", req(s, b.email).id, "remove-b", at(1));
  const done = completeOperation(claimed, { operationId: claimed.codex.lease.id, token: "remove-b",
    outcome: "verified", observation: obs(2, [a]) }, at(2));
  assert.equal(req(done, b.email).status, "completed");
  assert.equal(done.codex.holds.length, 1, "Other success must not erase the email evidence");
});

test("mail isolation does not block even the same employee's eventual expiry recovery", () => {
  let s = failedMail();
  s = observeWorkspace(s, obs(601), at(601));
  assert.equal(req(s, a.email).status, "pending_removal");
  assert.equal(claimOperation(s, "remove", req(s, a.email).id, "remove-a", at(601)).codex.lease.kind, "remove");
});

test("one member's uncertain operation preserves its capacity and locks only that member", () => {
  let s = fixture(true);
  s = claimOperation(s, "remove", req(s, a.email).id, "remove-a", at(0));
  s = completeOperation(s, { operationId: s.codex.lease.id, token: "remove-a",
    outcome: "uncertain", failureCode: "member_action" }, at(1));
  assert.equal(req(s, a.email).status, "pending_removal");
  assert.equal(workPlan(s, at(1)).removals.length, 1);
  assert.throws(() => claimOperation(s, "remove", req(s, a.email).id, "again", at(1)), /隔离/);
  assert.equal(claimOperation(s, "remove", req(s, b.email).id, "remove-b", at(1)).codex.lease.email, b.email);
});

test("approval denial is kept on that target; it is never silently retried", () => {
  const s = fixture(true);
  const blocked = deferOperation(s, { kind: "remove", targetId: req(s, a.email).id,
    failureCode: "approval_required" }, at(1));
  assert.equal(workPlan(blocked, at(1)).removals.length, 1);
  const again = deferOperation(blocked, { kind: "remove", targetId: req(s, a.email).id,
    failureCode: "approval_required" }, at(2));
  assert.equal(again.codex.holds.length, 1);
  assert.equal(workPlan(again, at(9999)).removals.length, 1, "Time cannot unlock approval");
});

test("login, identity, capacity, role and unclassified faults still stop all claims", () => {
  for (const code of ["login_expired", "workspace_mismatch", "capacity_mismatch", "role_mismatch", "unknown"]) {
    let s = fixture(true);
    s = deferOperation(s, { kind: "remove", targetId: req(s, a.email).id, failureCode: code }, at(1));
    assert.ok(s.codex.lastError);
    assert.equal(s.codex.globalFailureCode, code);
    assert.deepEqual(pendingEvents(workPlan(s, at(1)), T + 1000), []);
    assert.throws(() => claimOperation(s, "remove", req(s, b.email).id, "b", at(1)), /未解决/);
  }
});

test("failure classification cannot label a member action as a mail failure", () => {
  const s = fixture(true);
  assert.throws(() => deferOperation(s, { kind: "remove", targetId: req(s, a.email).id,
    failureCode: "mail_delivery" }, at(1)));
  assert.throws(() => deferOperation(s, { kind: "remove", targetId: "missing",
    failureCode: "member_action" }, at(1)));
});

test("a retained mail lease can be completed later from its real message ID", () => {
  const s = failedMail(), op = s.codex.holds[0].operation;
  assert.throws(() => completeOperation(s, { operationId: op.id, token: "wrong", outcome: "verified",
    providerMessageId: "message_123" }, at(2)));
  const done = completeOperation(s, { operationId: op.id, token: op.token, outcome: "verified",
    providerMessageId: "message_123" }, at(2));
  assert.equal(done.codex.holds.length, 0);
  assert.equal(done.notices.find(n => n.id === op.targetId).status, "sent");
  assert.equal(done.codex.receipts.at(-1).evidence, "message_123");
  assert.deepEqual(completeOperation(done, { operationId: op.id, token: op.token, outcome: "verified" }, at(3)), done);
});

test("a held receipt cannot clear another workspace incident or an active lease", () => {
  let s = failedMail(), op = s.codex.holds[0].operation;
  s = deferOperation(s, { kind: "remove", targetId: req(s, b.email).id,
    failureCode: "login_expired" }, at(1));
  const done = completeOperation(s, { operationId: op.id, token: op.token, outcome: "verified",
    providerMessageId: "message_123" }, at(2));
  assert.equal(done.codex.globalFailureCode, "login_expired");
  assert.ok(done.codex.lastError);
  const busy = claimOperation(failedMail(), "remove", req(s, b.email).id, "remove-b", at(1));
  assert.throws(() => completeOperation(busy, { operationId: op.id, token: op.token, outcome: "verified",
    providerMessageId: "message_123" }, at(2)), /正在办理/);
});

test("recovery requires fresh official evidence and cannot retry an attempted send", () => {
  const mail = failedMail();
  assert.throws(() => reviewFailure(mail, { decision: "retry_not_started",
    operationId: mail.codex.holds[0].operation.id }, at(2)), /未开始/);
  let s = fixture(true);
  s = deferOperation(s, { kind: "remove", targetId: req(s, a.email).id, failureCode: "login_expired" }, at(1));
  assert.throws(() => reviewFailure(s, { decision: "resume_workspace" }, at(2)));
  assert.throws(() => reviewFailure(s, { decision: "resume_workspace", observation: obs(0) }, at(100)));
  const reviewed = reviewFailure(s, { decision: "resume_workspace", observation: obs(2) }, at(2));
  assert.equal(reviewed.codex.lastError, undefined);
});

test("capacity mismatch is a global incident even with otherwise complete evidence", () => {
  const s = observeWorkspace(fixture(), { ...obs(1), totalSeats: 3 }, at(1));
  assert.equal(s.codex.globalFailureCode, "capacity_mismatch");
  assert.equal(s.config.totalSeats, 4);
});

test("partial batch failure keeps unprocessed recovery events eligible for the next wake", () => {
  const before = fixture(), initialPlan = workPlan(before, at(0));
  const events = pendingEvents(initialPlan, T);
  const state = { seen: {}, active: { id: "wake", events, keys: events.map(e => e.key), createdAt: at(0) } };
  const after = workPlan(failedMail(before), at(1));
  const decision = applyAcknowledgement(state, { id: "wake", outcome: "blocked", at: at(1) }, after, T + 1000);
  assert.equal(decision.outcome, "isolated");
  assert.equal(state.halted, undefined);
  const next = prepareWake(state, after, T + 1000);
  assert.equal(next.kind, "wake");
  assert.deepEqual(next.events.map(e => e.kind), ["remove"]);
});

test("an unknown or global failure is not turned into isolation just by sending ack", () => {
  const s = fixture(), p = workPlan(s, at(0)), events = pendingEvents(p, T);
  for (const change of [{}, { busy: true }, { lastError: "login expired" }]) {
    const state = { seen: {}, active: { id: "wake", events, keys: events.map(e => e.key), createdAt: at(0) } };
    applyAcknowledgement(state, { id: "wake", outcome: "uncertain", at: at(1) }, { ...p, ...change }, T + 1000);
    assert.ok(state.halted);
  }
});

test("historical blocked ack without recorded target events remains fail-closed", () => {
  const s = fixture(), p = workPlan(failedMail(s), at(1));
  const state = { seen: {}, active: { id: "wake", keys: ["old-key"], createdAt: at(0) } };
  applyAcknowledgement(state, { id: "wake", outcome: "blocked", at: at(1) }, p, T + 1000);
  assert.equal(state.halted.reason, "ack_blocked");
});

test("mail-channel configuration failure does not halt a mixed recovery batch", () => {
  const s = fixture(), p = workPlan(s, at(0)), events = pendingEvents(p, T);
  const state = { seen: {}, active: { id: "wake", events, keys: events.map(e => e.key), createdAt: at(0) } };
  s.codex.mailChannelError = "Mail relay configuration invalid";
  const after = workPlan(s, at(1));
  applyAcknowledgement(state, { id: "wake", outcome: "blocked", at: at(1) }, after, T + 1000);
  assert.equal(state.halted, undefined);
  assert.equal(prepareWake(state, after, T + 1000).events[0].kind, "remove");
  assert.throws(() => claimOperation(s, "mail", p.reminders[0].id, "mail", at(1)), /通道已暂停/);
});

test("a member isolation also settles an acceptance check for the same request", () => {
  const plan = { workspaceId: TARGET_WORKSPACE_ID, administrator: owner.email,
    enabled: true, testOnly: false, busy: false, lastError: null, faultIsolationVersion: 1,
    invites: [], removals: [{id:"request_b"}], reminders: [], awaitingAcceptance: [],
    blockedOperations: [{ operation: { kind: "invite", targetId: "request_a" } }] };
  const event = { kind: "acceptance", id: "request_a", key: "key-a" };
  const state = { seen: {}, active: { id: "wake", events: [event], keys: [event.key], createdAt: at(0) } };
  applyAcknowledgement(state, { id: "wake", outcome: "blocked", at: at(1) }, plan, T + 1000);
  assert.equal(state.halted, undefined);
  assert.equal(prepareWake(state, plan, T + 1000).events[0].kind, "remove");
});
