import { createHash } from "node:crypto";
import { settleAcknowledgement, applyAcknowledgement as applyFailureAck } from "./queue-failures.mjs";

export const TARGET_WORKSPACE = "cd01c344-8ff9-41fd-a750-f7b30af9a7c9";
export const ADMIN_EMAIL = "xiaocaisong70@gmail.com";
export const SCHEDULE_ID = "local:queue-checker:NUMEMS-Seat-Queue";
const minute = 60_000;
const validId = value => typeof value === "string" && /^[a-zA-Z0-9_:.-]{1,250}$/.test(value);
const event = (kind, id, cycle = "") => ({ kind, id,
  key: createHash("sha256").update(JSON.stringify([kind, id, cycle])).digest("hex") });

// This projection intentionally excludes checkedAt, revisions, historic notices,
// email addresses, free-form reasons, receipts and operation lease tokens.
export function pendingEvents(plan, nowMs = Date.now()) {
  if (!plan || plan.workspaceId !== TARGET_WORKSPACE || plan.administrator !== ADMIN_EMAIL)
    throw new Error("Unexpected workspace or administrator; external dispatch stopped.");
  for (const key of ["invites", "removals", "awaitingAcceptance", "reminders"])
    if (!Array.isArray(plan[key])) throw new Error("Incomplete work plan.");
  if (typeof plan.enabled !== "boolean" || typeof plan.busy !== "boolean")
    throw new Error("Invalid executor state.");
  if (!plan.enabled || plan.testOnly || plan.busy || plan.lastError || plan.globalFailureCode) return [];
  const events = [];
  for (const [kind, requests] of [["invite", plan.invites], ["remove", plan.removals]])
    for (const r of requests) {
      if (!validId(r.id)) throw new Error("Invalid request ID.");
      events.push(event(kind, r.id, r.operationId ?? ""));
    }
  for (const notice of plan.reminders) {
    if (!validId(notice.id) || typeof notice.key !== "string") throw new Error("Invalid notice.");
    events.push(event("mail", notice.id, notice.key));
  }
  for (const r of plan.awaitingAcceptance) {
    if (!validId(r.id)) throw new Error("Invalid invitation ID.");
    const since = nowMs - Date.parse(r.invitedAt);
    const deadline = r.joinDeadlineAt ? Date.parse(r.joinDeadlineAt) : Date.parse(r.invitedAt) + 5 * minute;
    if (!Number.isFinite(since) || since < 0 || nowMs >= deadline) continue;
    if (r.acceptanceRequestedAt && (!r.acceptanceCheckedAt || r.acceptanceRequestedAt > r.acceptanceCheckedAt)) {
      events.push(event("acceptance", r.id, `hint:${r.acceptanceRequestedAt}`));
      continue;
    }
    // At most two fallback checks in the five-minute window; no empty polling
    // wakes. A user acceptance hint can wake the checker sooner.
    if (since < 2 * minute) continue;
    const slot = since >= 4 * minute ? 1 : 0;
    events.push(event("acceptance", r.id, `${r.invitedAt}:${slot}`));
  }
  const priority = { remove: 0, invite: 1, mail: 2, acceptance: 3 };
  return events.sort((a, b) => priority[a.kind] - priority[b.kind] || a.key.localeCompare(b.key));
}

export function prepareWake(state, plan, nowMs = Date.now()) {
  const events = pendingEvents(plan, nowMs);
  if (state.halted) return { kind: "halted", events: [] };
  if (state.active) {
    if (nowMs - Date.parse(state.active.createdAt) > 30 * minute)
      return { kind: "stalled", events: [] };
    return { kind: "waiting", events: [] };
  }
  const fresh = events.filter(item => !state.seen?.[item.key] || state.seen[item.key].outcome === "isolated");
  return { kind: fresh.length ? "wake" : "idle", events: fresh };
}

export function acknowledgementOutcome(active, ack, plan, nowMs = Date.now()) {
  return settleAcknowledgement(active, ack, plan, pendingEvents(plan, nowMs), { ignoreAcceptance: true }).outcome;
}
export function applyAcknowledgement(state, ack, plan, nowMs = Date.now()) {
  return applyFailureAck(state, ack, plan, pendingEvents(plan, nowMs), { ignoreAcceptance: true, now: nowMs });
}

export function wakeMessage(id, events, projectPath) {
  const ids = events.map(({ kind, id }) => `${kind}:${id}`).join(", ");
  return `NUMEMS 按需待办 [${id}]\n这是用户已授权的普通程序检测到的待办事件：${ids}。这些ID仅作定位，不替代实时状态。\n遵循 ${projectPath}\\AUTOMATION.md，先 process_seat_queue 再 seat_portal_status，重新核实当前有效计划。故障须先通过complete_seat_operation或defer_seat_operation登记failureCode：邮件mail_delivery、已确认单一成员member_action、单次审批approval_required只隔离目标；登录/工作空间/容量/角色/未知异常整体暂停。官方页初次安全验证先自然等待就绪，未claim且未开始动作的暂时不可用才登记browser_unavailable，由普通程序只读复核恢复；已claim或结果不明禁止降级。读取最新计划，跳过blockedOperations继续其它回收，禁止重试隔离项。只处理已批准的员工申请、30分钟提醒和到期回收。已批准的普通成员邀请无需再自行询问“确认发送”，实时核对通过后直接发送；若实际操作被系统审批拦截才登记approval_required。保留既有 observe→claim→官方浏览器/Gmail→核实→complete 流程及所有审批；不加购、不改席位类型、不处理Owner/管理员、不创建测试、不改截止时间或访问名单。未接受的邀请只核对一次，不等待、不循环轮询。\n处理后执行 node "${projectPath}\\scripts\\queue-checker.mjs" --ack ${id} --outcome done；若登录失效、审批拒绝、操作结果不明或未完成，请报告原因，改用 --outcome blocked 或 uncertain。ack仅结束本次唤醒，不代替真实办理回执。不要重启每分钟Codex自动化。`;
}
