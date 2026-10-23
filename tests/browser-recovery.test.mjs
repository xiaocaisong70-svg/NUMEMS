import test from "node:test";
import assert from "node:assert/strict";
import { createState, transition, PROTECTED_OWNER_EMAIL } from "../lib/seat-engine.ts";
import { observeWorkspace, workPlan, claimOperation, completeOperation, deferOperation,
  reviewFailure, TARGET_WORKSPACE_ID } from "../lib/codex-bridge.ts";
import { recoverBrowser, reconcileDispatchRecovery } from "../scripts/browser-recovery.mjs";
import { waitForOfficialPage } from "../scripts/seat-executor/official-readiness.mjs";

const T = Date.parse("2026-10-22T00:00:00Z"), at = n => new Date(T + n * 1000).toISOString();
const owner = { email: PROTECTED_OWNER_EMAIL, userId: "owner", isAdmin: true };
const alice = { email: "alice@example.com", role: "member" };
const obs = n => ({ workspaceId: TARGET_WORKSPACE_ID, accountEmail: owner.email,
  pageUrl: `https://admin.openai.com/workspace/${TARGET_WORKSPACE_ID}/members`,
  observedAt: at(n), complete: true, totalSeats: 4,
  members: [{ email: owner.email, role: "owner" }, alice], invites: [] });
function fixture() {
  let s = observeWorkspace(createState(at(0)), obs(0), at(0));
  s.codex.enabled = true; s.codex.testOnly = false;
  s.config.automationEnabled = true;
  s.requests.find(r => r.email === alice.email).expiresAt = at(600);
  return transition(s, owner, { type: "tick" }, at(0));
}
const request = s => s.requests.find(r => r.email === alice.email);
const blocked = () => {
  const s = fixture();
  return deferOperation(s, { kind: "invite", targetId: request(s).id,
    failureCode: "browser_unavailable" }, at(1));
};
const local = () => ({ seen: { old: { outcome: "blocked" }, done: { outcome: "done" } },
  halted: { reason: "ack_blocked", at: at(1) } });

test("browser pre-action fault blocks member claims but valid Gmail reminders stay usable", () => {
  const s = blocked(), p = workPlan(s, at(2));
  assert.equal(p.browserRecovery.eligible, true);
  assert.throws(() => claimOperation(s, "remove", request(s).id, "r", at(2)), /未解决/);
  const n = p.reminders[0];
  const claimed = claimOperation(s, "mail", n.id, "mail", at(2));
  const done = completeOperation(claimed, { operationId: claimed.codex.lease.id, token: "mail",
    outcome: "verified", providerMessageId: "gmail_receipt_123" }, at(3));
  assert.equal(done.codex.globalFailureCode, "browser_unavailable");
  assert.equal(done.notices.find(x => x.id === n.id).status, "sent");
});

test("automatic recovery requires fresh full evidence and a specifically unstarted browser failure", () => {
  const s = blocked();
  assert.throws(() => reviewFailure(s, { decision: "recover_browser", observation: obs(0) }, at(90)));
  assert.throws(() => reviewFailure(s, { decision: "recover_browser", observation: { ...obs(2), complete: false } }, at(2)));
  for (const code of ["unknown", "login_expired", "role_mismatch", "capacity_mismatch", "workspace_mismatch"]) {
    const fatal = deferOperation(fixture(), { kind: "invite", targetId: request(s).id, failureCode: code }, at(1));
    assert.throws(() => reviewFailure(fatal, { decision: "recover_browser", observation: obs(2) }, at(2)), /自动恢复/);
    assert.throws(() => deferOperation(fatal, { kind: "invite", targetId: request(s).id, failureCode: "browser_unavailable" }, at(2)), /降级/);
  }
  const done = reviewFailure(s, { decision: "recover_browser", observation: obs(2) }, at(2));
  assert.equal(done.codex.globalFailureCode, undefined);
  assert.equal(done.codex.workspaceReviewedAt, at(2));
  assert.equal(done.audit.at(-1).action, "codex_browser_recovered");
});

test("a claimed/uncertain external action can never become automatically retryable", () => {
  const s = fixture(), n = workPlan(s, at(0)).reminders[0];
  const claimed = claimOperation(s, "mail", n.id, "mail", at(1));
  assert.throws(() => reviewFailure(claimed, { decision: "recover_browser", observation: obs(2) }, at(2)), /未完成/);
  const memberState = transition(fixture(), owner, { type: "tick" }, at(601));
  const c = claimOperation(observeWorkspace(memberState, obs(601), at(601)), "remove", request(memberState).id, "member", at(601));
  assert.throws(() => completeOperation(c, { operationId: c.codex.lease.id, token: "member",
    outcome: "blocked", failureCode: "browser_unavailable" }, at(602)), /已取得/);
});

test("a newer cloud review unlocks only blocked local dispatch and preserves completed deduplication", () => {
  const s = local(), p = workPlan(reviewFailure(blocked(), { decision: "recover_browser", observation: obs(3) }, at(3)), at(3));
  assert.equal(reconcileDispatchRecovery(s, p, T + 3000), true);
  assert.equal(s.halted, undefined); assert.equal(s.seen.old, undefined); assert.ok(s.seen.done);
  for (const reason of ["ack_uncertain", "queue_result_unknown", "wake_not_acknowledged"]) {
    const q = local(); q.halted.reason = reason;
    assert.equal(reconcileDispatchRecovery(q, p, T + 3000), false);
  }
  for (const change of [{ workspaceReviewedAt: at(0) }, { workspaceReviewedAt: null }, { busy: true },
    { lease: {} }, { lastError: "error" }, { globalFailureCode: "unknown" }])
    assert.equal(reconcileDispatchRecovery(local(), { ...p, ...change }, T + 3000), false);
});

test("ordinary recovery backs off, never claims external work, then resumes on verified cloud proof", async () => {
  const state = local(), initial = blocked(); let current = 2, reads = 0; const calls = [];
  const client = { async portal(_session, name, args) {
    calls.push(name); assert.equal(name, "review_seat_failure");
    return workPlan(reviewFailure(initial, args, at(current)), at(current));
  } };
  const failed = await recoverBrowser({ client, session: "s", state, plan: workPlan(initial, at(2)),
    clock: () => new Date(T + current * 1000), observe: async () => { reads++; throw Error("challenge"); } });
  assert.equal(failed.kind, "waiting"); assert.equal(reads, 1); assert.equal(calls.length, 0);
  current = 10;
  await recoverBrowser({ client, session: "s", state, plan: failed.plan, clock: () => new Date(T + current * 1000),
    observe: async () => { reads++; throw Error("must not inspect during backoff"); } });
  assert.equal(reads, 1);
  current = 63;
  const done = await recoverBrowser({ client, session: "s", state, plan: failed.plan,
    clock: () => new Date(T + current * 1000), observe: async () => { reads++; return obs(current); } });
  assert.equal(done.kind, "recovered"); assert.equal(state.halted, undefined);
  assert.deepEqual(calls, ["review_seat_failure"]); assert.equal(reads, 2);
});

test("temporary verification is allowed to finish; login and workspace errors stop immediately", async () => {
  const url = obs(0).pageUrl; let count = 0, elapsed = 0;
  await waitForOfficialPage({ now: () => elapsed, pause: async ms => { elapsed += ms; },
    inspect: async () => ({ url, expectedUrl: url, body: ++count < 3 ? "正在进行安全验证" : "My Workspace", ready: count >= 3 }) });
  assert.equal(count, 3); assert.equal(elapsed, 2000);
  for (const [actual, code] of [["https://auth.openai.com/log-in", "login_expired"], [url.replace(TARGET_WORKSPACE_ID, "other"), "workspace_mismatch"]])
    await assert.rejects(waitForOfficialPage({ inspect: async () => ({ url: actual, expectedUrl: url, body: "", ready: false }),
      pause: async () => { throw Error("must not wait"); } }), e => e.failureCode === code);
  elapsed = 0;
  await assert.rejects(waitForOfficialPage({ now: () => elapsed, pause: async ms => { elapsed += ms; }, timeoutMs: 2000,
    inspect: async () => ({ url, expectedUrl: url, body: "安全验证", ready: false }) }), e => e.failureCode === "browser_unavailable");
  assert.equal(elapsed, 2000);
});
