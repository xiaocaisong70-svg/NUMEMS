import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRelayMode, beginRun, collectItems, decision, settle, withoutMail, TRAE_SCHEDULE_ID } from "../scripts/trae/checker-core.mjs";
import { TARGET_WORKSPACE, ADMIN_EMAIL } from "../scripts/queue-checker-core.mjs";

const now = Date.parse("2026-10-21T12:00:00Z");
const base = overrides => ({ workspaceId: TARGET_WORKSPACE, administrator: ADMIN_EMAIL,
  enabled: true, testOnly: false, busy: false, lastError: null, globalFailureCode: null,
  faultIsolationVersion: 1, blockedOperations: [], invites: [], removals: [], reminders: [],
  awaitingAcceptance: [], scheduleId: null, ...overrides });

test("邮件必须由云端 relay 投递，codex 模式直接拒绝", () => {
  assert.doesNotThrow(() => assertRelayMode({ mailMode: "relay" }));
  assert.throws(() => assertRelayMode({ mailMode: "codex" }), /relay/);
  assert.throws(() => assertRelayMode({}), /邮件通道/);
});

test("空队列不产生 TRAE 待办，也不创建运行", () => {
  const d = decision({ seen: {} }, base(), now);
  assert.equal(d.kind, "idle");
  assert.deepEqual(d.events, []);
});

test("邀请事件生成运行并保留精确目标", () => {
  const plan = base({ invites: [{ id: "req_1", email: "a@example.com", operationId: "invite_1" }] });
  const d = decision({ seen: {} }, plan, now);
  assert.equal(d.kind, "wake");
  const state = { seen: {} };
  const runId = beginRun(state, d.events, now);
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.equal(state.active.keys.length, 1);
  const items = collectItems(plan, d.events);
  assert.equal(items.invites.length, 1);
  assert.equal(items.invites[0].id, "req_1");
  assert.equal(items.removals.length, 0);
});

test("邮件事件不进入 TRAE 待办，成员事件不受邮件通道影响", () => {
  const plan = base({
    mailChannelError: "relay 配置无效",
    reminders: [{ id: "n_1", key: "r:expiry_30m:2026-10-21T12:20:00.000Z", type: "expiry_30m" }],
    supports: [],
  });
  assert.equal(decision({ seen: {} }, plan, now).kind, "idle");
  assert.deepEqual(withoutMail(plan).reminders, []);
  const withInvite = { ...plan, invites: [{ id: "req_2" }] };
  assert.equal(decision({ seen: {} }, withInvite, now).kind, "wake");
});

test("完成并核实后确认运行，同一事件不会再次派发", () => {
  const plan = base({ invites: [{ id: "req_1" }] });
  const state = { seen: {} };
  const d = decision(state, plan, now);
  const runId = beginRun(state, d.events, now);
  const done = base();
  const result = settle(state, { id: runId, outcome: "done", at: new Date(now + 1000).toISOString() }, done, now + 1000);
  assert.equal(result.outcome, "done");
  assert.equal(state.seen[d.events[0].key].outcome, "done");
  assert.equal(state.active, undefined);
  assert.equal(decision(state, plan, now + 2000).kind, "idle");
});

test("云端登记的目标隔离只重排未完成的同目标事件", () => {
  const plan = base({ invites: [{ id: "req_1", email: "held@example.com" }] });
  const state = { seen: {} };
  const d = decision(state, plan, now);
  const runId = beginRun(state, d.events, now);
  const heldPlan = { ...plan,
    blockedOperations: [{ operation: { kind: "invite", targetId: "req_1", email: "held@example.com" } }],
  };
  const result = settle(state, { id: runId, outcome: "blocked", at: new Date(now + 1000).toISOString() }, heldPlan, now + 1000);
  assert.equal(result.outcome, "isolated");
  assert.equal(state.seen[d.events[0].key].outcome, "isolated");
  assert.equal(decision(state, heldPlan, now + 2000).kind, "idle");
});

test("目标隔离按邮箱同时屏蔽接受核对，但无关员工仍可排队处理", () => {
  const plan = base({
    invites: [
      { id: "req_1", email: "held@example.com" },
      { id: "req_2", email: "next@example.com" },
    ],
    awaitingAcceptance: [{ id: "req_3", email: "held@example.com", invitedAt: new Date(now - 3 * 60_000).toISOString() }],
    blockedOperations: [{ operation: { kind: "invite", targetId: "old_req", email: "HELD@example.com" } }],
  });
  const d = decision({ seen: {} }, plan, now);
  assert.equal(d.kind, "wake");
  assert.deepEqual(d.events.map(event => event.id), ["req_2"]);
});

test("全局异常明确暂停，已有租约明确等待", () => {
  assert.equal(decision({ seen: {} }, base({ globalFailureCode: "capacity_mismatch" }), now).kind, "halted");
  assert.equal(decision({ seen: {} }, base({ busy: true }), now).kind, "waiting");
});

test("未确认超时后暂停，不重复派发", () => {
  const plan = base({ invites: [{ id: "req_1" }] });
  const state = { seen: {} };
  const d = decision(state, plan, now);
  beginRun(state, d.events, now);
  assert.equal(decision(state, plan, now + 31 * 60_000).kind, "stalled");
  assert.equal(decision({ seen: {}, halted: { reason: "x" } }, plan, now).kind, "halted");
});

test("调度标识沿用普通程序前缀，避免被误认为心跳模型", () => {
  assert.equal(TRAE_SCHEDULE_ID, "local:trae-cn:NUMEMS-Seat-Queue");
});
