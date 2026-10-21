import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceDue, processOnce } from "../scripts/seat-executor/core.mjs";
import { PortalClient } from "../scripts/seat-executor/portal-client.mjs";

const config = { liveActions: true, legacyCheckerDisabled: true,
  workspaceId: "cd01c344-8ff9-41fd-a750-f7b30af9a7c9",
  adminEmail: "xiaocaisong70@gmail.com" };
const address = "member@example.com";
const snapshot = (members, invites) => ({
  workspaceId: config.workspaceId, accountEmail: config.adminEmail,
  pageUrl: `https://admin.openai.com/workspace/${config.workspaceId}/members`,
  observedAt: new Date().toISOString(), complete: true, totalSeats: 4,
  members: [{ email: config.adminEmail, role: "owner" }, ...members.map(email => ({ email, role: "member" }))],
  invites: invites.map(email => ({ email, role: "member" })),
});
const plan = (kind, removalReason) => ({
  workspaceId: config.workspaceId, administrator: config.adminEmail,
  enabled: true, testOnly: false, busy: false, lease: null,
  lastError: null, globalFailureCode: null,
  invites: kind === "invite" ? [{ id: "req1", email: address }] : [],
  removals: kind === "remove" ? [{ id: "req1", email: address, removalReason }] : [],
  reminders: [], awaitingAcceptance: [],
});
function portalFor(current, originalPresence, calls) {
  const lease = { id: "op1", token: "secret", kind: current.removals.length ? "remove" : "invite",
    email: address, originalPresence };
  return { async call(name, args = {}) {
    calls.push({ name, args });
    if (name === "process_seat_queue" || name === "observe_workspace") return {};
    if (name === "seat_portal_status") return { plan: current };
    if (name === "claim_seat_operation") return { plan: { ...current, lease } };
    if (name === "complete_seat_operation") return { plan: current };
    throw new Error(`Unexpected portal call: ${name}`);
  } };
}

test("acceptance checks stop at the five-minute deadline, even with an employee hint", () => {
  const sent = Date.parse("2026-10-20T00:00:00Z");
  const request = { invitedAt: new Date(sent).toISOString(),
    joinDeadlineAt: new Date(sent + 5 * 60_000).toISOString(),
    acceptanceRequestedAt: new Date(sent + 60_000).toISOString() };
  assert.equal(acceptanceDue(request, sent + 30_000), false);
  assert.equal(acceptanceDue(request, sent + 90_000), true);
  assert.equal(acceptanceDue(request, sent + 5 * 60_000), false);
  assert.equal(acceptanceDue(request, sent + 6 * 60_000), false);
  assert.equal(acceptanceDue(request, sent - 1), false);
});

test("an active legacy checker blocks before the new worker invokes any portal mutation", async () => {
  const calls = [];
  await assert.rejects(processOnce({
    config: { ...config, legacyCheckerDisabled: false },
    portal: { async call(name) { calls.push(name); return {}; } },
  }), /旧按需检查器/);
  assert.deepEqual(calls, []);
});

test("a cloud relay and local Gmail connector mismatch stops before claiming work", async () => {
  const calls = [];
  await assert.rejects(processOnce({
    config: { ...config, mailMode: "gmail_connector" },
    portal: { async call(name) { calls.push(name); return { mailMode: "relay" }; } },
  }), /邮件通道不一致/);
  assert.deepEqual(calls, ["process_seat_queue"]);
});

test("a due removal takes priority over an unrelated reminder", async () => {
  const calls = [], actualPlan = plan("remove", "lease_expired");
  actualPlan.reminders.push({ id: "notice1", email: "other@example.com" });
  const before = snapshot([address], []), after = snapshot([], []);
  let observations = 0, sent = 0, removed = 0;
  const browser = { async observe() { return ++observations === 1 ? before : after; },
    async remove(email) { removed++; this.onExternalAction("remove", email); } };
  const result = await processOnce({ config, portal: portalFor(actualPlan, "member", calls), browser,
    mailer: { async send() { sent++; return "message_id"; } } });
  assert.equal(result.mode, "remove_verified");
  assert.equal(removed, 1);
  assert.equal(sent, 0);
  assert.deepEqual(calls.filter(c => c.name === "claim_seat_operation").map(c => c.args.kind), ["remove"]);
  assert.equal(calls.find(c => c.name === "complete_seat_operation").args.outcome, "verified");
});

test("after a revocation attempt throws, fresh membership protects the employee who joined", async () => {
  const calls = [], actualPlan = plan("remove", "invitation_expired");
  const before = snapshot([], [address]), after = snapshot([address], []);
  let observations = 0;
  const browser = { async observe() { return ++observations === 1 ? before : after; },
    async remove(email) { this.onExternalAction("remove", email); throw new Error("UI changed"); } };
  const result = await processOnce({ config, portal: portalFor(actualPlan, "invite", calls), browser });
  assert.equal(result.mode, "joined_during_revocation");
  const completion = calls.find(c => c.name === "complete_seat_operation").args;
  assert.equal(completion.outcome, "joined");
  assert.deepEqual(completion.observation.members.find(p => p.email === address),
    { email: address, role: "member" });
  assert.equal(completion.observation.invites.length, 0);
});

test("a failed UI wait is reconciled from fresh official absence without repeating removal", async () => {
  const calls = [], actualPlan = plan("remove", "lease_expired");
  const before = snapshot([address], []), after = snapshot([], []);
  let observations = 0, attempts = 0;
  const browser = { async observe() { return ++observations === 1 ? before : after; },
    async remove(email) { attempts++; this.onExternalAction("remove", email); throw new Error("dialog wait timed out"); } };
  const result = await processOnce({ config, portal: portalFor(actualPlan, "member", calls), browser });
  assert.equal(result.mode, "remove_verified");
  assert.equal(attempts, 1);
  const completion = calls.find(c => c.name === "complete_seat_operation").args;
  assert.equal(completion.outcome, "verified");
  assert.equal(completion.observation.members.some(p => p.email === address), false);
});

test("a joined result is never inferred for a normal lease removal", async () => {
  const calls = [], actualPlan = plan("remove", "lease_expired");
  const before = snapshot([address], []), after = snapshot([address], []);
  let observations = 0;
  const browser = { async observe() { return ++observations === 1 ? before : after; },
    async remove(email) { this.onExternalAction("remove", email); throw new Error("UI changed"); } };
  await assert.rejects(processOnce({ config, portal: portalFor(actualPlan, "member", calls), browser }), /UI changed/);
  const completion = calls.find(c => c.name === "complete_seat_operation").args;
  assert.equal(completion.outcome, "uncertain");
  assert.equal(completion.failureCode, "unknown");
});

test("portal client rejects an unauthenticated owner before posting an action", async () => {
  let evaluated = 0;
  const page = { url: () => "https://numems-seat-portal.workspace-026021.chatgpt.site/",
    async evaluate() { evaluated++; return { status: 200, body: { access: "allowed",
      user: { email: "someone-else@example.com" } } }; } };
  const client = new PortalClient({ async newPage() { return page; } }, {
    siteUrl: "https://numems-seat-portal.workspace-026021.chatgpt.site/",
    adminEmail: config.adminEmail,
  });
  await assert.rejects(client.call("claim_seat_operation", { kind: "remove", targetId: "req1" }), /身份不符/);
  assert.equal(evaluated, 1);
});

test("portal client does not retry an ambiguous operation response", async () => {
  let postAttempts = 0;
  const page = { url: () => "https://numems-seat-portal.workspace-026021.chatgpt.site/",
    async evaluate(_callback, requestBody) {
      if (!requestBody) return { status: 200, body: { access: "allowed",
        user: { email: config.adminEmail } } };
      postAttempts++;
      throw new Error("network interruption");
    } };
  const client = new PortalClient({ async newPage() { return page; } }, {
    siteUrl: "https://numems-seat-portal.workspace-026021.chatgpt.site/",
    adminEmail: config.adminEmail,
  });
  await assert.rejects(client.call("claim_seat_operation", { kind: "remove", targetId: "req1" }), /network interruption/);
  assert.equal(postAttempts, 1);
});
