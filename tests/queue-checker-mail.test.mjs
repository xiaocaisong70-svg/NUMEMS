import { test } from "node:test";
import assert from "node:assert/strict";
import { codexDispatchPlan, drainDirectReminders, processDirectReminder } from "../scripts/queue-checker-mail.mjs";
import { ADMIN_EMAIL, TARGET_WORKSPACE, pendingEvents } from "../scripts/queue-checker-core.mjs";
import { GmailConnectorMailer, assertGmailSender } from "../scripts/seat-executor/gmail-mailer.mjs";

const notice = { id: "notice_123", requestId: "req", type: "expiry_30m",
  status: "pending", email: "worker@example.com",
  key: "req:expiry_30m:2026-10-20T07:00:00.000Z", title: "席位即将到期" };
const plan = changes => ({ workspaceId: TARGET_WORKSPACE, administrator: ADMIN_EMAIL,
  enabled: true, testOnly: false, busy: false, lastError: null,
  invites: [], removals: [], awaitingAcceptance: [], reminders: [notice], ...changes });
const lease = { id: "op_123", token: "lease_token", kind: "mail",
  targetId: notice.id, email: notice.email, expectedExpiry: "2026-10-20T07:00:00.000Z" };
function fakeClient({ claimedLease = lease, completeError = null, sender = ADMIN_EMAIL } = {}) {
  const calls = [];
  return { calls, async connector(_session, name) {
    calls.push({ name }); assert.equal(name, "gmail.get_profile");
    return { email: sender };
  }, async portal(_session, name, args) {
    calls.push({ name, args });
    if (name === "claim_seat_operation") return { plan: { lease: claimedLease } };
    if (name === "complete_seat_operation") {
      if (completeError) throw completeError;
      return { plan: plan({ reminders: [] }) };
    }
    throw Error("Unexpected portal call");
  } };
}

test("direct reminder claims first and records Gmail message ID without a Codex wake", async () => {
  const client = fakeClient(); let sends = 0;
  const result = await processDirectReminder({ client, session: "session", plan: plan(),
    mailer: { async send(item, expiry) {
      assert.equal(client.calls[0].name, "gmail.get_profile");
      assert.equal(client.calls[1].name, "claim_seat_operation");
      assert.equal(item.id, notice.id); assert.equal(expiry, lease.expectedExpiry);
      sends++; return "gmail_msg_12345";
    } } });
  assert.equal(result.kind, "sent"); assert.equal(sends, 1);
  assert.deepEqual(client.calls.map(call => call.name),
    ["gmail.get_profile", "claim_seat_operation", "complete_seat_operation"]);
  assert.deepEqual(client.calls[2].args, { operationId: lease.id, token: lease.token,
    outcome: "verified", providerMessageId: "gmail_msg_12345" });
  assert.deepEqual(pendingEvents(plan({ reminders: [] })), []);
});

test("ambiguous Gmail result is isolated and never retried", async () => {
  const client = fakeClient(); let sends = 0;
  const result = await processDirectReminder({ client, session: "session", plan: plan(),
    mailer: { async send() { sends++; throw Error("Gmail timed out"); } } });
  assert.equal(result.kind, "uncertain"); assert.equal(sends, 1);
  assert.equal(client.calls[2].args.outcome, "uncertain");
  assert.equal(client.calls[2].args.failureCode, "mail_delivery");
});

test("failed portal completion after Gmail receipt does not cause a second send", async () => {
  const client = fakeClient({ completeError: Error("completion result unknown") });
  let sends = 0;
  await assert.rejects(processDirectReminder({ client, session: "session", plan: plan(),
    mailer: { async send() { sends++; return "gmail_msg_12345"; } } }),
  /completion result unknown/);
  assert.equal(sends, 1);
  assert.equal(client.calls.filter(call => call.name === "claim_seat_operation").length, 1);
});

test("identity mismatch, incomplete plan and busy state cannot send", async () => {
  const client = fakeClient(); const mailer = { async send() { throw Error("must not send"); } };
  await assert.rejects(processDirectReminder({ client, session: "s", mailer,
    plan: plan({ administrator: "other@example.com" }) }), /Unexpected workspace/);
  await assert.rejects(processDirectReminder({ client, session: "s", mailer,
    plan: plan({ reminders: null }) }), /Incomplete reminder/);
  for (const changes of [{ busy: true }, { enabled: false }, { testOnly: true },
    { globalFailureCode: "login_expired" }])
    assert.equal((await processDirectReminder({ client, session: "s", mailer,
      plan: plan(changes) })).kind, "skipped");
  assert.equal(client.calls.length, 0);
});

test("mismatched lease fails closed before Gmail", async () => {
  const client = fakeClient({ claimedLease: { ...lease, email: "other@example.com" } });
  let sends = 0;
  await assert.rejects(processDirectReminder({ client, session: "s", plan: plan(),
    mailer: { async send() { sends++; } } }), /claim does not match/);
  assert.equal(sends, 0);
});

test("a verified pre-action browser pause does not suppress an unrelated direct reminder", async () => {
  const client = fakeClient(); let sent = 0;
  const result = await processDirectReminder({ client, session: "s", plan: plan({
    globalFailureCode: "browser_unavailable", lastError: "verification pending",
    browserRecovery: { eligible: true }, lease: null,
  }), mailer: { async send() { sent++; return "gmail_browser_pause_123"; } } });
  assert.equal(result.kind, "sent"); assert.equal(sent, 1);
  const skipped = await processDirectReminder({ client: fakeClient(), session: "s", plan: plan({
    globalFailureCode: "browser_unavailable", lastError: "unverified classification",
  }), mailer: { async send() { throw Error("must not send"); } } });
  assert.equal(skipped.kind, "skipped");
});

test("wrong connected Gmail account stops before the portal claim", async () => {
  const client = fakeClient({ sender: "other@example.com" }); let sends = 0;
  await assert.rejects(processDirectReminder({ client, session: "s", plan: plan(),
    mailer: { async send() { sends++; } } }), /发件账号不是指定管理员邮箱/);
  assert.equal(sends, 0);
  assert.deepEqual(client.calls.map(c => c.name), ["gmail.get_profile"]);
  assert.equal(assertGmailSender({ email: " XIAOCAISONG70@GMAIL.COM " }), ADMIN_EMAIL);
});

test("malformed reminder is rejected before claiming a lease", async () => {
  const invalid = [{ id: "x" }, { title: "" }, { title: "提醒\nBcc: attacker@example.com" },
    { title: "A".repeat(121) }, { type: "other" }, { status: "sent" },
    { requestId: "other" }, { key: "req:expiry_30m:invalid" }];
  for (const changes of invalid) {
    const client = fakeClient();
    await assert.rejects(processDirectReminder({ client, session: "s",
      plan: plan({ reminders: [{ ...notice, ...changes }] }),
      mailer: { async send() { throw Error("must not send"); } } }), /Invalid reminder/);
    assert.equal(client.calls.length, 0);
  }
});

test("opt-in mode excludes only mail from Codex wakeups", () => {
  const mixed = plan({ invites: [{ id: "request_123" }], removals: [{ id: "request_456" }] });
  assert.deepEqual(pendingEvents(codexDispatchPlan(mixed, false)).map(e => e.kind),
    ["remove", "invite", "mail"]);
  assert.deepEqual(pendingEvents(codexDispatchPlan(mixed, true)).map(e => e.kind),
    ["remove", "invite"]);
  assert.equal(mixed.reminders.length, 1, "original plan remains intact");
});

function reminderFor(index) {
  const requestId = `request_${index}`;
  return { ...notice, id: `notice_${index}`, requestId,
    email: `worker${index}@example.com`,
    key: `${requestId}:expiry_30m:2026-10-20T07:00:00.000Z` };
}
function batchClient(initial, { unchanged = false, claimError = null } = {}) {
  let current = plan({ reminders: initial }); let claimedId;
  const calls = [];
  return { calls, async connector(_session, name) {
    calls.push({ name }); assert.equal(name, "gmail.get_profile");
    return { email: ADMIN_EMAIL };
  }, async portal(_session, name, args) {
    calls.push({ name, args });
    if (name === "claim_seat_operation") {
      if (claimError) throw claimError;
      const item = current.reminders.find(n => n.id === args.targetId);
      claimedId = item.id;
      return { plan: { lease: { ...lease, targetId: item.id, email: item.email } } };
    }
    if (name === "complete_seat_operation") {
      if (!unchanged) current = plan({ reminders: current.reminders.filter(n => n.id !== claimedId) });
      return { plan: current };
    }
    if (name === "seat_portal_status") return { plan: current };
    throw Error("Unexpected portal call");
  } };
}

test("bounded batch re-reads portal plan after each reminder and drains three", async () => {
  const client = batchClient([reminderFor(1), reminderFor(2), reminderFor(3)]);
  const sent = [];
  const result = await drainDirectReminders({ client, session: "s",
    plan: plan({ reminders: [reminderFor(1), reminderFor(2), reminderFor(3)] }),
    mailer: { async send(item) { sent.push(item.id); return `gmail_${item.id}`; } } });
  assert.deepEqual(sent, ["notice_1", "notice_2", "notice_3"]);
  assert.equal(result.sent, 3); assert.equal(result.uncertain, 0);
  assert.equal(result.plan.reminders.length, 0);
  assert.equal(client.calls.filter(c => c.name === "seat_portal_status").length, 3);
});

test("uncertain first send is isolated; a different valid reminder can continue", async () => {
  const reminders = [reminderFor(1), reminderFor(2)];
  const client = batchClient(reminders); let sends = 0;
  const result = await drainDirectReminders({ client, session: "s",
    plan: plan({ reminders }), mailer: { async send() {
      if (++sends === 1) throw Error("delivery unknown");
      return "gmail_second_message";
    } } });
  assert.equal(sends, 2); assert.equal(result.sent, 1); assert.equal(result.uncertain, 1);
  assert.deepEqual(client.calls.filter(c => c.name === "complete_seat_operation")
    .map(c => c.args.outcome), ["uncertain", "verified"]);
});

test("unknown claim and unchanged plan stop a batch without a blind retry", async () => {
  const reminders = [reminderFor(1), reminderFor(2)];
  const unknown = batchClient(reminders, { claimError: Error("claim response unknown") });
  let sends = 0;
  await assert.rejects(drainDirectReminders({ client: unknown, session: "s",
    plan: plan({ reminders }), mailer: { async send() { sends++; } } }), /claim response unknown/);
  assert.equal(sends, 0);
  const unchanged = batchClient(reminders, { unchanged: true });
  await assert.rejects(drainDirectReminders({ client: unchanged, session: "s",
    plan: plan({ reminders }), mailer: { async send() { sends++; return "gmail_message_id"; } } }),
  /automatic retry stopped/);
  assert.equal(sends, 1);
});

test("batch size is capped even when the site still has pending reminders", async () => {
  const reminders = [reminderFor(1), reminderFor(2), reminderFor(3)];
  const client = batchClient(reminders); let sends = 0;
  const result = await drainDirectReminders({ client, session: "s", plan: plan({ reminders }), limit: 2,
    mailer: { async send() { sends++; return "gmail_message_id"; } } });
  assert.equal(sends, 2); assert.equal(result.plan.reminders.length, 1);
  await assert.rejects(drainDirectReminders({ client, session: "s", plan: plan({ reminders }), limit: 4,
    mailer: { async send() { throw Error("must not send"); } } }), /Invalid reminder batch limit/);
});

test("an old mail wake excludes its notice but not unrelated reminders", async () => {
  const reminders = [reminderFor(1), reminderFor(2)];
  const client = batchClient(reminders); const sent = [];
  const result = await drainDirectReminders({ client, session: "s", plan: plan({ reminders }),
    blockedNoticeIds: ["notice_1"], mailer: { async send(item) {
      sent.push(item.id); return "gmail_message_id";
    } } });
  assert.deepEqual(sent, ["notice_2"]);
  assert.equal(result.plan.reminders[0].id, "notice_1");
  assert.equal(client.calls.filter(c => c.name === "claim_seat_operation").length, 1);
});

test("sender is rechecked in the same mail transport session before send", async () => {
  const calls = [], transport = {
    on() {}, async initialize() {}, async createToolSession() { return "mailer-session"; },
    async connector(session, name) {
      calls.push([session, name]);
      if (name === "gmail.get_profile") return { email: "other@example.com" };
      throw Error("must not send");
    }, async close() {},
  };
  const mailer = new GmailConnectorMailer({ codexCli: "fake", siteUrl: "https://numems-seat-portal.workspace-026021.chatgpt.site/" },
    { clientFactory: () => transport, cliResolver: async cli => cli });
  await assert.rejects(mailer.send(notice, lease.expectedExpiry), /发件账号不是指定管理员邮箱/);
  assert.deepEqual(calls, [["mailer-session", "gmail.get_profile"]]);
});

test("Gmail transport uses a resolved CLI after desktop app rotation", async () => {
  const calls = [];
  const transport = {
    on() {}, async initialize() {}, async createToolSession() { return "mailer-session"; },
    async connector(_session, name, args) {
      calls.push(name);
      if (name === "gmail.get_profile") return { email: ADMIN_EMAIL };
      if (name === "gmail.send_email") {
        assert.equal(args.to, notice.email);
        assert.match(args.subject, /NUMEMS:notice_123/);
        return { id: "gmail_rotated_123" };
      }
      throw Error("Unexpected connector call");
    }, async close() {},
  };
  const mailer = new GmailConnectorMailer({ codexCli: "C:\\old\\codex.exe",
    siteUrl: "https://numems-seat-portal.workspace-026021.chatgpt.site/" }, {
    cliResolver: async configured => {
      assert.equal(configured, "C:\\old\\codex.exe");
      return "C:\\current\\codex.exe";
    },
    clientFactory: cli => {
      assert.equal(cli, "C:\\current\\codex.exe");
      return transport;
    },
  });
  assert.equal(await mailer.send(notice, lease.expectedExpiry), "gmail_rotated_123");
  assert.deepEqual(calls, ["gmail.get_profile", "gmail.send_email"]);
});
