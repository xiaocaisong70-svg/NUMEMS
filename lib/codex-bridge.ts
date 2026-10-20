import { PROTECTED_OWNER_EMAIL, AUTHORIZED_TEST_EMAIL, transition, type State, type Actor } from "./seat-engine.ts";

export const TARGET_WORKSPACE_ID = "cd01c344-8ff9-41fd-a750-f7b30af9a7c9";
export const TEST_EMAIL = AUTHORIZED_TEST_EMAIL;
export type Person = { email: string; role: "member" | "admin" | "owner" };
export type Observation = {
  workspaceId: string; accountEmail: string; pageUrl: string; observedAt: string;
  complete: boolean; totalSeats: number; members: Person[]; invites: Person[];
};
export type Lease = {
  id: string; token: string; kind: "invite" | "remove" | "mail"; targetId: string;
  email: string; requestId: string; claimedAt: string; expiresAt: string;
  expectedExpiry?: string; status: "claimed" | "uncertain";
  originalPresence?: "member" | "invite" | "absent";
};
export type BridgeState = State & {
  codex?: {
    enabled: boolean; testOnly: boolean; mailEnabled: boolean;
    inviteVerifiedAt?: string; removalVerifiedAt?: string; invitationRevokedAt?: string; mailVerifiedAt?: string;
    lastRunAt?: string; lastError?: string; lease?: Lease; observation?: Observation;
    scheduleId?: string;
    receipts: { id: string; kind: string; email: string; at: string; evidence: string }[];
  };
};
const systemActor: Actor = { userId: "system:codex", email: PROTECTED_OWNER_EMAIL, isAdmin: true };
const norm = (value: string) => value.trim().toLowerCase();
const minute = 60_000;
function time(value: string) { const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error("时间无效。"); return n; }
function bridge(state: BridgeState) {
  state.codex ??= { enabled: false, testOnly: true, mailEnabled: true, receipts: [] };
  return state.codex;
}
function record(state: BridgeState, action: string, now: string, requestId?: string) {
  state.revision++;
  state.audit.push({ id: "codex_" + state.revision + "_" + time(now), at: now,
    actor: PROTECTED_OWNER_EMAIL, action, ...(requestId ? { requestId } : {}) });
  state.audit = state.audit.slice(-1000);
}
export function validateObservation(snapshot: Observation, now: string) {
  if (!snapshot || snapshot.workspaceId !== TARGET_WORKSPACE_ID ||
      norm(snapshot.accountEmail) !== PROTECTED_OWNER_EMAIL || snapshot.complete !== true)
    throw new Error("必须核对目标工作空间、管理员账号和完整成员／邀请列表。");
  const url = new URL(snapshot.pageUrl);
  if (url.protocol !== "https:" || url.hostname !== "admin.openai.com" ||
      url.pathname !== "/workspace/" + TARGET_WORKSPACE_ID + "/members")
    throw new Error("成员证据必须来自目标工作空间的官方成员页。");
  if (Math.abs(time(now) - time(snapshot.observedAt)) > minute)
    throw new Error("成员证据已过期，请重新读取官方页面。");
  if (!Number.isInteger(snapshot.totalSeats) || snapshot.totalSeats < 2 ||
      !Array.isArray(snapshot.members) || !Array.isArray(snapshot.invites))
    throw new Error("席位或成员快照格式无效。");
  const roles = ["member", "admin", "owner"];
  for (const p of [...snapshot.members, ...snapshot.invites]) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) || !roles.includes(p.role))
      throw new Error("快照邮箱或角色无效。");
  }
  if (!snapshot.members.some(p => norm(p.email) === PROTECTED_OWNER_EMAIL && p.role === "owner"))
    throw new Error("目标管理员未显示为 Owner，已停止办理。");
  return structuredClone(snapshot);
}
export function observeWorkspace(input: BridgeState, snapshot: Observation, now: string): BridgeState {
  const checked = validateObservation(snapshot, now);
  let next = structuredClone(input);
  if (next.config.workspaceId && next.config.workspaceId !== checked.workspaceId)
    throw new Error("门户绑定的工作空间不匹配。");
  if (!next.config.inventoryVerified) {
    const owners = new Set(checked.members.filter(p => p.role === "owner").map(p => norm(p.email)));
    next = transition(next, systemActor, { type: "configure", config: {
      workspaceId: checked.workspaceId, totalSeats: checked.totalSeats,
      reservedSeats: Math.max(next.config.reservedSeats, owners.size),
    } }, now) as BridgeState;
    next = transition(next, systemActor, { type: "sync_inventory",
      members: [...checked.members, ...checked.invites.map(p => ({ ...p, role: "pending_invite" }))],
    }, now) as BridgeState;
  }
  bridge(next).observation = checked; bridge(next).lastRunAt = now;
  const known = new Set(next.requests.filter(r => !["completed", "cancelled"].includes(r.status)).map(r => r.email));
  for (const p of [...checked.members, ...checked.invites]) {
    const address = norm(p.email);
    if (p.role === "owner") {
      if (!next.config.protectedEmails.includes(address)) {
        next.config.protectedEmails.push(address);
        next.config.automationEnabled = false;
        bridge(next).enabled = false;
        bridge(next).lastError = "检测到新增Owner，请重新核对保留席位。";
      }
      continue;
    }
    if (!known.has(address)) {
      next.requests.push({ id: "observed_" + time(now) + "_" + next.requests.length,
        userId: "inventory:" + address, email: address, name: address.split("@")[0],
        reason: "从官方完整快照补录的现有成员或邀请，未设置自动到期。",
        hours: 0, status: "active", createdAt: now, updatedAt: now, expiresAt: null });
      known.add(address);
    }
  }
  // Fresh full snapshots reconcile accepted invitations and already absent users.
  for (const old of [...next.requests]) {
    const member = checked.members.find(p => norm(p.email) === old.email);
    const invited = checked.invites.some(p => norm(p.email) === old.email);
    if (member && member.role !== "member" &&
        ["pending_invite", "invited", "pending_removal"].includes(old.status)) {
      bridge(next).lastError = "目标用户具有管理角色，已停止自动办理。";
      bridge(next).enabled = false;
      continue;
    }
    if (old.status === "pending_invite" && (member || invited)) {
      next = transition(next, systemActor, { type: "confirm_invited", id: old.id }, now) as BridgeState;
    }
    const current = next.requests.find(r => r.id === old.id)!;
    if (current.status === "invited" && member && current.invitedAt &&
        time(current.invitedAt) + next.config.acceptHours * 3_600_000 > time(now)) {
      next = transition(next, systemActor, { type: "confirm_active", id: old.id }, now) as BridgeState;
    }
    if (current.status === "pending_removal" && !member && !invited) {
      next = transition(next, systemActor, { type: "confirm_removed", id: old.id }, now) as BridgeState;
    }
  }
  next = transition(next, systemActor, { type: "tick" }, now) as BridgeState;
  record(next, "codex_observe_workspace", now);
  return next;
}
export function prepareTest(input: BridgeState, now: string): BridgeState {
  let next = structuredClone(input);
  const b = bridge(next);
  if (!b.observation || !next.config.inventoryVerified) throw new Error("请先核对官方成员列表。");
  const prior = next.requests.find(r => r.email === TEST_EMAIL && !["completed", "cancelled"].includes(r.status));
  if (prior?.isTest) return next;
  if (prior) throw new Error("该邮箱已有真实申请，不能覆盖为测试。");
  const snapshot = validateObservation(b.observation, now);
  if ([...snapshot.members, ...snapshot.invites].some(p => norm(p.email) === TEST_EMAIL))
    throw new Error("测试邮箱已在工作空间或邀请中，不能当作新的测试对象。");
  b.enabled = true; b.testOnly = true;
  next = transition(next, systemActor, { type: "configure", config: {
    whitelist: [...new Set([...next.config.whitelist, TEST_EMAIL])], automationEnabled: true,
  } }, now) as BridgeState;
  next = transition(next, { userId: "test:" + TEST_EMAIL, email: TEST_EMAIL, isAdmin: false },
    { type: "apply", name: "自动化验收测试", reason: "管理员授权的邀请与回收测试",
      hours: 1, requestKey: "pilot-" + time(now) }, now) as BridgeState;
  next.requests.find(r => r.email === TEST_EMAIL && r.status === "queued")!.isTest = true;
  next = transition(next, systemActor, { type: "tick" }, now) as BridgeState;
  record(next, "codex_prepare_test", now);
  return next;
}
export function setBridgeMode(input: BridgeState, enabled: boolean, now: string): BridgeState {
  const next = structuredClone(input); const b = bridge(next);
  if (enabled && (!b.inviteVerifiedAt || !b.removalVerifiedAt || !b.mailVerifiedAt))
    throw new Error("需要先验证真实邀请、回收和邮件发送。");
  b.enabled = enabled; b.testOnly = !enabled;
  record(next, enabled ? "codex_enable_live" : "codex_pause", now);
  return next;
}
export function recordSchedule(input: BridgeState, scheduleId: string, now: string): BridgeState {
  const next = structuredClone(input); const b = bridge(next);
  if (typeof scheduleId !== "string" || scheduleId.length > 200) throw new Error("调度标识无效。");
  if (scheduleId && (!b.enabled || b.testOnly)) throw new Error("需先通过验收并启用正式执行器。");
  b.scheduleId = scheduleId; record(next, "codex_record_schedule", now); return next;
}
export function setTestDeadline(input: BridgeState, requestId: string,
    stage: "reminder" | "expire", now: string): BridgeState {
  const next = structuredClone(input); const b = bridge(next);
  const r = next.requests.find(r => r.id === requestId && r.isTest && r.email === TEST_EMAIL);
  if (!b.testOnly || b.lease || !r || r.status !== "active") throw new Error("只能调整已加入的授权测试席位，且不能有未完成办理。");
  if (!["reminder", "expire"].includes(stage)) throw new Error("测试阶段无效。");
  r.expiresAt = new Date(time(now) + (stage === "reminder" ? 30 * minute : -1000)).toISOString();
  r.updatedAt = now;
  record(next, "codex_test_" + stage, now, r.id);
  return transition(next, systemActor, { type: "tick" }, now) as BridgeState;
}
export function workPlan(input: BridgeState, now: string) {
  const b = input.codex;
  const allowed = (email: string) => b?.enabled && (!b.testOnly || email === TEST_EMAIL);
  return {
    workspaceId: input.config.workspaceId, administrator: PROTECTED_OWNER_EMAIL,
    enabled: b?.enabled ?? false, testOnly: b?.testOnly ?? true,
    lastError: b?.lastError ?? null, busy: Boolean(b?.lease), lease: b?.lease ?? null,
    scheduleId: b?.scheduleId ?? null, lastRunAt: b?.lastRunAt ?? null,
    invites: input.requests.filter(r => r.status === "pending_invite" && allowed(r.email)),
    removals: input.requests.filter(r => r.status === "pending_removal" && allowed(r.email)),
    awaitingAcceptance: input.requests.filter(r => r.status === "invited" && allowed(r.email)),
    reminders: input.notices.filter(n => {
      const r = input.requests.find(r => r.id === n.requestId);
      return n.type === "expiry_30m" && n.status === "pending" && allowed(n.email) &&
        r?.status === "active" && Boolean(r.expiresAt) && n.key.endsWith(":" + r.expiresAt) &&
        time(r.expiresAt!) > time(now) && time(r.expiresAt!) - time(now) <= 30 * minute;
    }),
    receipts: b?.receipts.slice(-10) ?? [], checkedAt: now,
  };
}
export function claimOperation(input: BridgeState, kind: Lease["kind"], targetId: string,
    token: string, now: string): BridgeState {
  const next = structuredClone(input); const b = bridge(next);
  if (!b.enabled) throw new Error("Codex 执行器尚未启用。");
  if (b.lease) throw new Error("已有办理未结束；结果不明时必须先核对，不能重试。");
  let email: string, requestId: string, expectedExpiry: string | undefined;
  let originalPresence: Lease["originalPresence"];
  if (kind === "mail") {
    const n = next.notices.find(n => n.id === targetId);
    const r = n && next.requests.find(r => r.id === n.requestId);
    if (!n || !r || n.type !== "expiry_30m" || n.status !== "pending" ||
        r.status !== "active" || !r.expiresAt || !n.key.endsWith(":" + r.expiresAt) ||
        time(r.expiresAt) <= time(now) || time(r.expiresAt) - time(now) > 30 * minute)
      throw new Error("提醒已失效或当前不应发送。");
    email = n.email; requestId = r.id; expectedExpiry = r.expiresAt;
  } else {
    const r = next.requests.find(r => r.id === targetId);
    if (!r || r.status !== (kind === "invite" ? "pending_invite" : "pending_removal"))
      throw new Error("申请状态已变化，不能执行此操作。");
    if (!b.observation) throw new Error("缺少官方成员证据。");
    const s = validateObservation(b.observation, now);
    const member = s.members.find(p => norm(p.email) === r.email);
    const invitation = s.invites.find(p => norm(p.email) === r.email);
    originalPresence = member ? "member" : invitation ? "invite" : "absent";
    if ((member && member.role !== "member") || (invitation && invitation.role !== "member"))
      throw new Error("禁止自动移除管理员或 Owner。");
    if (kind === "invite") {
      if ([...s.members, ...s.invites].some(p => norm(p.email) === r.email))
        throw new Error("目标邮箱已存在，请重新同步状态。");
      const occupied = new Set([...s.members, ...s.invites].map(p => norm(p.email))).size;
      if (occupied >= s.totalSeats || input.config.totalSeats > s.totalSeats)
        throw new Error("实际可用席位不足，禁止自动增购。");
    }
    email = r.email; requestId = r.id;
  }
  if (next.config.protectedEmails.includes(email) || email === PROTECTED_OWNER_EMAIL)
    throw new Error("Owner 保留账号受保护。");
  if (b.testOnly && email !== TEST_EMAIL) throw new Error("测试模式只能处理指定测试邮箱。");
  b.lease = { id: "op_" + token, token, kind, targetId, email, requestId, claimedAt: now,
    expiresAt: new Date(time(now) + 2 * minute).toISOString(), status: "claimed", expectedExpiry, originalPresence };
  b.lastRunAt = now;
  record(next, "codex_claim_" + kind, now, requestId);
  return next;
}
export function completeOperation(input: BridgeState, args: {
    operationId: string; token: string; outcome: "verified" | "uncertain" | "blocked";
    observation?: Observation; providerMessageId?: string; detail?: string;
  }, now: string): BridgeState {
  let next = structuredClone(input); let b = bridge(next);
  const op = b.lease;
  if (!op && args.outcome === "verified" && b.receipts.some(r => r.id === args.operationId)) return next;
  if (!op || op.id !== args.operationId || op.token !== args.token) throw new Error("执行回执不匹配。");
  if (args.outcome !== "verified") {
    op.status = "uncertain"; b.lastError = (args.detail ?? "操作结果不明，请先核对真实状态。").slice(0, 500);
    record(next, "codex_operation_uncertain", now, op.requestId); return next;
  }
  let evidence: string;
  if (op.kind === "mail") {
    if (!args.providerMessageId || !/^[a-zA-Z0-9_-]{5,200}$/.test(args.providerMessageId))
      throw new Error("需要 Gmail 返回的消息 ID。");
    const notice = next.notices.find(n => n.id === op.targetId);
    if (!notice) throw new Error("提醒记录不存在。");
    notice.status = "sent"; notice.sentAt = now; evidence = args.providerMessageId;
    b.mailVerifiedAt = now;
  } else {
    const s = validateObservation(args.observation!, now);
    if (time(s.observedAt) < time(op.claimedAt)) throw new Error("必须提供操作后的官方成员证据。");
    const member = s.members.find(p => norm(p.email) === op.email);
    const invitation = s.invites.find(p => norm(p.email) === op.email);
    const invited = Boolean(invitation);
    if ((member && member.role !== "member") || (invitation && invitation.role !== "member"))
      throw new Error("实际目标角色异常，禁止确认办理成功。");
    if (op.kind === "invite" && !member && !invited) throw new Error("没有核实到实际邀请。");
    if (op.kind === "remove" && (member || invited)) throw new Error("目标邮箱仍在成员或邀请列表中。");
    next = observeWorkspace(next, s, now); b = bridge(next);
    if (op.kind === "invite") b.inviteVerifiedAt = now;
    else if (op.originalPresence === "member") b.removalVerifiedAt = now;
    else b.invitationRevokedAt = now;
    evidence = s.pageUrl;
  }
  b.receipts.push({ id: op.id, kind: op.kind, email: op.email, at: now, evidence });
  b.receipts = b.receipts.slice(-500); delete b.lease; delete b.lastError;
  record(next, "codex_verified_" + op.kind, now, op.requestId);
  return next;
}
