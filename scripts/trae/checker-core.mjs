// 纯逻辑层：不打开浏览器、不发信、不写文件，便于测试。
// 复用原项目已验证的事件指纹、唤醒窗口和故障结算规则。
import { randomUUID } from "node:crypto";
import { pendingEvents, prepareWake } from "../queue-checker-core.mjs";
import { applyAcknowledgement } from "../queue-failures.mjs";

// 门户据此把调度模式显示为 on-demand；前缀与旧的 queue-checker 一样表示“普通程序、零模型调用”。
export const TRAE_SCHEDULE_ID = "local:trae-cn:NUMEMS-Seat-Queue";
export const TASK_NAME = "NUMEMS-Seat-Queue";

export function assertRelayMode(jobs) {
  if (!jobs || typeof jobs.mailMode !== "string")
    throw new Error("门户未返回邮件通道模式；执行器停止。");
  if (jobs.mailMode !== "relay")
    throw new Error("门户邮件通道不是 relay。TRAE 执行器不使用 Codex，请先在云端配置并验收 HTTPS 邮件中继。");
}

// 邮件由云端 relay 在 process_seat_queue 内投递；本执行器不发送任何邮件。
export function withoutMail(plan) {
  return { ...plan, reminders: [] };
}

function withoutHeldMembers(plan) {
  const holds = (plan.blockedOperations ?? []).map(item => item.operation ?? item)
    .filter(operation => operation?.kind !== "mail");
  if (!holds.length) return plan;
  const isHeld = item => holds.some(operation =>
    (operation.email && item.email && operation.email.trim().toLowerCase() === item.email.trim().toLowerCase()) ||
    (operation.targetId && operation.targetId === item.id));
  return {
    ...plan,
    invites: (plan.invites ?? []).filter(item => !isHeld(item)),
    removals: (plan.removals ?? []).filter(item => !isHeld(item)),
    awaitingAcceptance: (plan.awaitingAcceptance ?? []).filter(item => !isHeld(item)),
  };
}

export function decision(state, plan, nowMs = Date.now()) {
  if (state.halted) return { kind: "halted", events: [] };
  if (plan?.lastError || plan?.globalFailureCode)
    return { kind: "halted", events: [], reason: plan.lastError ?? plan.globalFailureCode };
  if (plan?.busy) return { kind: "waiting", events: [] };
  return prepareWake(state, withoutHeldMembers(withoutMail(plan)), nowMs);
}

export function beginRun(state, events, nowMs = Date.now()) {
  const id = randomUUID();
  state.active = {
    id,
    keys: events.map(item => item.key),
    events,
    createdAt: new Date(nowMs).toISOString(),
    phase: "pending",
  };
  return id;
}

export function collectItems(plan, events) {
  const ids = kind => new Set(events.filter(item => item.kind === kind).map(item => item.id));
  return {
    invites: (plan.invites ?? []).filter(item => ids("invite").has(item.id)),
    removals: (plan.removals ?? []).filter(item => ids("remove").has(item.id)),
    awaitingAcceptance: (plan.awaitingAcceptance ?? []).filter(item => ids("acceptance").has(item.id)),
  };
}

export function settle(state, ack, plan, nowMs = Date.now()) {
  const target = withoutMail(plan);
  const eligible = withoutHeldMembers(target);
  return applyAcknowledgement(state, ack, target, pendingEvents(eligible, nowMs),
    { ignoreAcceptance: true, now: nowMs });
}
