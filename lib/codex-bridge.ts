import { PROTECTED_OWNER_EMAIL, AUTHORIZED_TEST_EMAIL, transition, type State, type Actor } from "./seat-engine.ts";
import { invitationDeadline } from "./queue-estimate.ts";
import { publicFaultRescue, publicRecoveryProgress, rescueBlocksClaims, type FaultRescueTicket, type RecoveryProgress } from './recovery-control.ts';

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
export const FAILURE_CODES = ["mail_delivery", "member_action", "approval_required",
  "browser_unavailable", "login_expired", "workspace_mismatch", "capacity_mismatch", "role_mismatch", "unknown"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export type OperationHold = {
  operation: Lease; code: FailureCode; detail: string; at: string; attempted: boolean;
};
type OperationFailureOrigin = {
  failureId: string; operationId: string; requestId: string;
  kind: "invite" | "remove"; email: string; claimedAt: string; failedAt: string;
};
export type BridgeState = State & {
  codex?: {
    enabled: boolean; testOnly: boolean; mailEnabled: boolean;
    inviteVerifiedAt?: string; removalVerifiedAt?: string; invitationRevokedAt?: string; mailVerifiedAt?: string;
    lastRunAt?: string; lastError?: string; lease?: Lease; observation?: Observation;
    scheduleId?: string;
    holds?: OperationHold[]; globalFailureCode?: FailureCode; mailChannelError?: string;
    browserUnavailableAt?: string; workspaceReviewedAt?: string;
    operationFailureOrigin?: OperationFailureOrigin;
    recoveryProgress?: RecoveryProgress; faultRescue?: FaultRescueTicket;
    receipts: { id: string; kind: string; email: string; at: string; evidence: string }[];
    reviewReceipts?: { failureId: string; targetId: string; operationId: string; workspaceId: string; observedAt: string; reviewedAt: string }[];
  };
};
const systemActor: Actor = { userId: "system:codex", email: PROTECTED_OWNER_EMAIL, isAdmin: true };
const norm = (value: string) => value.trim().toLowerCase();
const minute = 60_000;
const PRECLAIM_INVENTORY_ERROR = "官方完整名单核对失败；未开始成员写入。";
const POSTCLAIM_UNCERTAIN_ERROR = "程序办理未完成；保留原租约和证据，不自动重做外部动作。";
function latestWorkspaceFailureId(state: BridgeState) {
  return [...state.audit].reverse().find(a => a.action === "codex_workspace_blocked")?.id ?? null;
}
function sameOperation(origin: OperationFailureOrigin | undefined, op: Lease) {
  return Boolean(origin && origin.operationId === op.id && origin.requestId === op.requestId &&
    origin.kind === op.kind && origin.email === op.email && origin.claimedAt === op.claimedAt);
}
function resolvedOperationOrigin(state: BridgeState, op: Lease, snapshot: Observation) {
  const b = bridge(state), origin = b.operationFailureOrigin;
  const entries = [...snapshot.members, ...snapshot.invites];
  if (!origin || !sameOperation(origin, op) || origin.failureId !== latestWorkspaceFailureId(state) ||
      b.lease?.id !== op.id || op.status !== "uncertain" || b.globalFailureCode !== "unknown" ||
      b.lastError !== POSTCLAIM_UNCERTAIN_ERROR || b.enabled !== true || b.testOnly !== false ||
      (b.holds?.length ?? 0) !== 0 || b.mailChannelError ||
      !state.config.inventoryVerified || state.config.workspaceId !== TARGET_WORKSPACE_ID ||
      snapshot.totalSeats !== state.config.totalSeats || entries.length > snapshot.totalSeats ||
      new Set(entries.map(p => norm(p.email))).size !== entries.length ||
      snapshot.members.some(p => norm(p.email) === PROTECTED_OWNER_EMAIL ? p.role !== "owner" : p.role !== "member") ||
      snapshot.invites.some(p => p.role !== "member" || norm(p.email) === PROTECTED_OWNER_EMAIL) ||
      norm(op.email) === PROTECTED_OWNER_EMAIL || state.config.protectedEmails.includes(norm(op.email)) ||
      time(snapshot.observedAt) < time(origin.failedAt) || time(origin.failedAt) < time(op.claimedAt)) return null;
  return structuredClone(origin);
}
function finishOperationFault(state: BridgeState, origin: OperationFailureOrigin | null, now: string) {
  if (!origin) return;
  const b = bridge(state), current = b.operationFailureOrigin;
  // observeWorkspace can discover a new role/capacity fault. Do not clear it.
  if (!current || JSON.stringify(current) !== JSON.stringify(origin) ||
      origin.failureId !== latestWorkspaceFailureId(state) || b.globalFailureCode !== "unknown" ||
      b.lastError !== POSTCLAIM_UNCERTAIN_ERROR || b.lease || (b.holds?.length ?? 0) !== 0 ||
      b.mailChannelError || b.enabled !== true || b.testOnly !== false) return;
  delete b.globalFailureCode; delete b.lastError; delete b.operationFailureOrigin;
  record(state, "codex_resolved_original_operation_fault", now, origin.requestId);
}
function time(value: string) { const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error("时间无效。"); return n; }
function bridge(state: BridgeState) {
  state.codex ??= { enabled: false, testOnly: true, mailEnabled: true, receipts: [] };
  return state.codex;
}
function failureCode(code: unknown, kind: Lease["kind"]): FailureCode {
  const value = code ?? (kind === "mail" ? "mail_delivery" : "unknown");
  if (!FAILURE_CODES.includes(value as FailureCode)) throw new Error("故障分类无效。");
  if (value === "mail_delivery" && kind !== "mail") throw new Error("邮件故障不能用于成员操作。");
  if (value === "member_action" && kind === "mail") throw new Error("成员故障不能用于邮件操作。");
  if (value === "browser_unavailable" && kind === "mail") throw new Error("浏览器故障不能用于邮件操作。");
  return value as FailureCode;
}
function isIsolated(code: FailureCode) {
  return ["mail_delivery", "member_action", "approval_required"].includes(code);
}
function targetHeld(input: BridgeState, kind: Lease["kind"] | "acceptance", targetId: string, email: string) {
  return input.codex?.holds?.some(h => h.operation.kind === "mail"
    ? kind === "mail" && h.operation.targetId === targetId
    : kind !== "mail" && h.operation.email === email) ?? false;
}
function record(state: BridgeState, action: string, now: string, requestId?: string) {
  state.revision++;
  state.audit.push({ id: "codex_" + state.revision + "_" + time(now), at: now,
    actor: PROTECTED_OWNER_EMAIL, action, ...(requestId ? { requestId } : {}) });
  // Archive after the complete CAS transform, never discard events here.
}
export function validateObservation(snapshot: Observation, now: string) {
  if (!snapshot || snapshot.workspaceId !== TARGET_WORKSPACE_ID ||
      norm(snapshot.accountEmail) !== PROTECTED_OWNER_EMAIL || snapshot.complete !== true)
    throw new Error("必须核对目标工作空间、管理员账号和完整成员／邀请列表。");
  const url = new URL(snapshot.pageUrl);
  if (url.protocol !== "https:" || url.hostname !== "admin.openai.com" ||
      url.pathname !== "/workspace/" + TARGET_WORKSPACE_ID + "/members")
    throw new Error("成员证据必须来自目标工作空间的官方成员页。");
  if (time(snapshot.observedAt) > time(now) || time(now) - time(snapshot.observedAt) > minute)
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
export function observeWorkspace(input: BridgeState, snapshot: Observation, now: string, verifiedOperationId?: string): BridgeState {
  const checked = validateObservation(snapshot, now);
  if (input.codex?.observation && time(checked.observedAt) < time(input.codex.observation.observedAt))
    throw new Error("不能用较旧的成员证据覆盖更新的核对结果。");
  let next = structuredClone(input);
  const previousObservation = next.codex?.observation;
  if (next.config.workspaceId && next.config.workspaceId !== checked.workspaceId)
    throw new Error("门户绑定的工作空间不匹配。");
  if (next.config.inventoryVerified && checked.totalSeats !== next.config.totalSeats) {
    const b = bridge(next);
    b.lastError = "已购容量与门户配置不一致，需管理员核对后恢复。";
    b.globalFailureCode = "capacity_mismatch";
    delete b.operationFailureOrigin;
    record(next, "codex_capacity_mismatch", now);
    return next;
  }
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
  // A complete membership snapshot taken before the deadline is positive
  // evidence even if this transaction is processed a little later.
  for (const request of next.requests.filter(r => r.status === "invited")) {
    const original = input.requests.find(r => r.id === request.id);
    const verified = Boolean(verifiedOperationId && [next.codex?.lease, ...(next.codex?.holds ?? []).map(h => h.operation)]
      .some(op => op?.id === verifiedOperationId && op.kind === "invite" && op.email === request.email));
    if ((!targetHeld(next, "acceptance", request.id, request.email) &&
         !(next.codex?.lease && next.codex.lease.email === request.email) || verified) &&
        original && (time(checked.observedAt) >= time(original.updatedAt) || verified) &&
        invitationDeadline(request) && time(checked.observedAt) < time(invitationDeadline(request)!) &&
        checked.members.some(p => norm(p.email) === request.email && p.role === "member"))
      next = transition(next, systemActor, { type: "confirm_active", id: request.id }, checked.observedAt) as BridgeState;
  }
  // Set the timeout state before resolving the final official membership check.
  next = transition(next, systemActor, { type: "tick" }, now) as BridgeState;
  // Fresh full snapshots reconcile accepted invitations and already absent users.
  for (const old of [...next.requests]) {
    const member = checked.members.find(p => norm(p.email) === old.email);
    const invited = checked.invites.some(p => norm(p.email) === old.email);
    const original = input.requests.find(r => r.id === old.id);
    // A snapshot obtained before the last user/administrator update cannot
    // resolve that update. A held or claimed target is reconciled only by its
    // original operation receipt, never by this passive observation.
    const freshForRequest = Boolean(original && time(checked.observedAt) >= time(original.updatedAt));
    const safelyUnclaimed = !targetHeld(next, "acceptance", old.id, old.email) &&
      !(next.codex?.lease && next.codex.lease.email === old.email);
    const verifiedInvite = Boolean(verifiedOperationId && [next.codex?.lease, ...(next.codex?.holds ?? []).map(h => h.operation)]
      .some(op => op?.id === verifiedOperationId && op.kind === "invite" && op.email === old.email));
    const verifiedRemoval = Boolean(verifiedOperationId && [next.codex?.lease, ...(next.codex?.holds ?? []).map(h => h.operation)]
      .some(op => op?.id === verifiedOperationId && op.kind === "remove" && op.email === old.email));
    if (member && member.role !== "member" &&
        ["pending_invite", "invited", "pending_removal"].includes(old.status)) {
      bridge(next).lastError = "目标用户具有管理角色，已停止自动办理。";
      bridge(next).enabled = false;
      continue;
    }
    if (["queued", "pending_invite"].includes(old.status) && member?.role === "member" &&
        !invited && freshForRequest && safelyUnclaimed) {
      next = transition(next, systemActor, { type: "confirm_external_join", id: old.id }, now) as BridgeState;
      const occupied = next.config.reservedSeats + next.requests.filter(r =>
        ["pending_invite", "invited", "active", "pending_removal"].includes(r.status)).length;
      if (occupied > next.config.totalSeats) {
        bridge(next).lastError = "官方已有成员使门户占用超过席位容量，请核对后恢复。";
        bridge(next).globalFailureCode = "capacity_mismatch";
        delete bridge(next).operationFailureOrigin;
      }
    } else if (old.status === "pending_invite" && (member || invited) &&
        (safelyUnclaimed || verifiedInvite) && freshForRequest) {
      next = transition(next, systemActor, { type: "confirm_invited", id: old.id }, now) as BridgeState;
    }
    const current = next.requests.find(r => r.id === old.id)!;
    if (current.status === "active" && original?.status === "active" && !member && !invited &&
        freshForRequest && safelyUnclaimed) {
      next = transition(next, systemActor, { type: "confirm_external_absence", id: current.id }, now) as BridgeState;
    }
    if (current.status === "invited") current.acceptanceCheckedAt = checked.observedAt;
    if (current.status === "invited" && member && current.invitedAt && (freshForRequest || verifiedInvite) && (safelyUnclaimed || verifiedInvite) &&
        time(invitationDeadline(current)!) > time(now)) {
      next = transition(next, systemActor, { type: "confirm_active", id: old.id }, now) as BridgeState;
    }
    if (current.status === "pending_removal" && ["invitation_expired", "whitelist_revoked"].includes(current.removalReason ?? "") &&
        member?.role === "member" && freshForRequest &&
        (!targetHeld(next, "remove", current.id, current.email) || verifiedInvite) &&
        (!(next.codex?.lease && next.codex.lease.email === current.email) || verifiedInvite)) {
      // Preserve a joined member until the pending invitation is actually revoked.
      // The official snapshot does not establish the exact acceptance time.
      if (!current.joinTimingEvidence) current.joinTimingEvidence = {
        firstMemberSeenAt: checked.observedAt,
        ...(previousObservation?.invites.some(p => norm(p.email) === current.email)
          ? { lastPendingSeenAt: previousObservation.observedAt } : {}),
      };
      next = transition(next, systemActor, { type: "confirm_joined_after_timeout", id: current.id }, now) as BridgeState;
    }
    if (current.status === "pending_removal" && !member && !invited && freshForRequest &&
        (safelyUnclaimed || verifiedRemoval)) {
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
  if (enabled && (!b.inviteVerifiedAt || !b.removalVerifiedAt || (b.mailEnabled !== false && !b.mailVerifiedAt)))
    throw new Error(b.mailEnabled === false ? "需要先验证真实邀请和成员回收。" : "需要先验证真实邀请、回收和邮件发送。");
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
    faultIsolationVersion: 1, globalFailureCode: b?.globalFailureCode ?? null,
    globalFailureId: b?.globalFailureCode ? latestWorkspaceFailureId(input) : null,
    workspaceReviewedAt: b?.workspaceReviewedAt ?? null,
    officialObservedAt: b?.observation?.observedAt ?? null,
    recoveryProgress: publicRecoveryProgress(input), faultRescue: publicFaultRescue(input),
    browserRecovery: b?.globalFailureCode === "browser_unavailable" && b.browserUnavailableAt && !b.lease
      ? { eligible: true, blockedAt: b.browserUnavailableAt } : null,
    blockedOperations: b?.holds ?? [],
    mailChannelError: b?.mailChannelError ?? null,
    scheduleId: b?.scheduleId ?? null, lastRunAt: b?.lastRunAt ?? null,
    invites: input.requests.filter(r => r.status === "pending_invite" && input.config.whitelist.includes(r.email) &&
      allowed(r.email) && !targetHeld(input, "invite", r.id, r.email)),
    removals: input.requests.filter(r => r.status === "pending_removal" &&
      allowed(r.email) && !targetHeld(input, "remove", r.id, r.email)),
    awaitingAcceptance: input.requests.filter(r => r.status === "invited" && allowed(r.email) && !targetHeld(input, "acceptance", r.id, r.email)),
    reminders: input.notices.filter(n => {
      const r = input.requests.find(r => r.id === n.requestId);
      return b?.mailEnabled !== false && !b?.mailChannelError && n.type === "expiry_30m" && n.status === "pending" && allowed(n.email) && !targetHeld(input, "mail", n.id, n.email) &&
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
  if (rescueBlocksClaims(next)) throw new Error("故障诊断尚未交还执行权，禁止新的成员或邮件操作。");
  if ((b.lastError || b.globalFailureCode) && !b.lease &&
      !(kind === "mail" && b.globalFailureCode === "browser_unavailable" && b.browserUnavailableAt))
    throw new Error("执行器有未解决错误，请先核实。");
  if (b.lease) throw new Error("已有办理未结束；结果不明时必须先核对，不能重试。");
  let email: string, requestId: string, expectedExpiry: string | undefined;
  let originalPresence: Lease["originalPresence"];
  if (kind === "mail") {
    if (b.mailEnabled === false) throw new Error("当前只显示网页提醒，不发送提醒邮件。");
    if (b.mailChannelError) throw new Error("邮件通道已暂停，成员回收不受影响。");
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
    if (kind === "invite" && !next.config.whitelist.includes(r.email))
      throw new Error("员工白名单授权已撤销，不能发送新的工作空间邀请。");
    if (!b.observation) throw new Error("缺少官方成员证据。");
    const s = validateObservation(b.observation, now);
    const member = s.members.find(p => norm(p.email) === r.email);
    const invitation = s.invites.find(p => norm(p.email) === r.email);
    originalPresence = member ? "member" : invitation ? "invite" : "absent";
    if ((member && member.role !== "member") || (invitation && invitation.role !== "member"))
      throw new Error("禁止自动移除管理员或 Owner。");
    if (kind === "remove" && ["invitation_expired", "whitelist_revoked"].includes(r.removalReason ?? "")) {
      if (r.removalReason === "invitation_expired" && time(s.observedAt) < time(invitationDeadline(r)!))
        throw new Error("须先取得加入窗口截止后的完整官方快照。");
      if (r.removalReason === "whitelist_revoked" && time(s.observedAt) < time(r.authorizationRevokedAt ?? r.updatedAt))
        throw new Error("须先取得白名单撤销后的完整官方快照。");
      if (member) throw new Error("员工已加入，禁止按邀请撤回规则移除成员；请重新同步官方状态。");
    }
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
  if (targetHeld(next, kind, targetId, email))
    throw new Error("此目标已隔离，须核实原操作；禁止重复办理。");
  if (b.testOnly && email !== TEST_EMAIL) throw new Error("测试模式只能处理指定测试邮箱。");
  b.lease = { id: "op_" + token, token, kind, targetId, email, requestId, claimedAt: now,
    expiresAt: new Date(time(now) + 2 * minute).toISOString(), status: "claimed", expectedExpiry, originalPresence };
  b.lastRunAt = now;
  record(next, "codex_claim_" + kind, now, requestId);
  return next;
}
export function completeOperation(input: BridgeState, args: {
    operationId: string; token: string; outcome: "verified" | "joined" | "uncertain" | "blocked";
    observation?: Observation; providerMessageId?: string; detail?: string; failureCode?: FailureCode; invitationSentAt?: string;
  }, now: string): BridgeState {
  let next = structuredClone(input); let b = bridge(next);
  if (!["verified", "joined", "uncertain", "blocked"].includes(args.outcome)) throw new Error("办理结果无效。");
  const hold = b.holds?.find(h => h.operation.id === args.operationId && h.operation.token === args.token);
  const op = b.lease?.id === args.operationId ? b.lease : hold?.operation;
  if (!op && ["verified", "joined"].includes(args.outcome) && b.receipts.some(r => r.id === args.operationId)) return next;
  if (!op || op.id !== args.operationId || op.token !== args.token) throw new Error("执行回执不匹配。");
  if (hold && b.lease) throw new Error("其他操作正在办理，请稍后核对隔离记录。");
  if (args.outcome === "joined") {
    if (op.kind !== "remove" || op.originalPresence !== "invite" ||
        !["invitation_expired", "whitelist_revoked"].includes(next.requests.find(r => r.id === op.requestId)?.removalReason ?? ""))
      throw new Error("只有撤回未接受邀请时转为普通成员，才可提交加入竞态回执。");
    const s = validateObservation(args.observation!, now);
    if (time(s.observedAt) < time(op.claimedAt) ||
        !s.members.some(p => norm(p.email) === op.email && p.role === "member") ||
        s.invites.some(p => norm(p.email) === op.email))
      throw new Error("须提供本次办理后已成为普通成员、且无待接受邀请的完整官方证据。");
    const origin = resolvedOperationOrigin(next, op, s);
    if (hold) b.holds = b.holds?.filter(h => h.operation.id !== op.id);
    else delete b.lease;
    next = observeWorkspace(next, s, now); b = bridge(next);
    if (next.requests.find(r => r.id === op.requestId)?.status !== "active")
      throw new Error("官方加入状态未能确认，不能结束撤回租约。");
    b.receipts.push({ id: op.id, kind: "joined_during_revocation", email: op.email, at: now, evidence: s.pageUrl });
    b.receipts = b.receipts.slice(-500);
    finishOperationFault(next, origin, now);
    if (!b.globalFailureCode) delete b.lastError;
    record(next, "codex_joined_during_revocation", now, op.requestId);
    return next;
  }
  if (args.outcome !== "verified") {
    const code = failureCode(args.failureCode, op.kind);
    if (code === "browser_unavailable")
      throw new Error("已取得操作租约，不能归类为未开始操作的浏览器暂不可用；须核对真实结果。");
    const detail = (args.detail ?? "操作结果不明，请先核对真实状态。").slice(0, 500);
    op.status = "uncertain";
    if (isIsolated(code)) {
      b.holds ??= [];
      if (hold) { hold.code = code; hold.detail = detail; }
      else b.holds.push({ operation: op, code, detail, at: now, attempted: true });
      if (b.lease?.id === op.id) delete b.lease;
      record(next, "codex_isolate_" + op.kind, now, op.requestId);
    } else {
      const priorOrigin = b.operationFailureOrigin;
      const mayAttach = code === "unknown" && detail === POSTCLAIM_UNCERTAIN_ERROR &&
        op.kind !== "mail" && !hold && b.lease?.id === op.id && (b.holds?.length ?? 0) === 0 && !b.mailChannelError &&
        ((!b.globalFailureCode && !b.lastError) || sameOperation(priorOrigin, op) &&
          priorOrigin?.failureId === latestWorkspaceFailureId(next) && b.globalFailureCode === "unknown" &&
          b.lastError === POSTCLAIM_UNCERTAIN_ERROR);
      b.lastError = detail; b.globalFailureCode = code;
      record(next, "codex_workspace_blocked", now, op.requestId);
      delete b.operationFailureOrigin;
      if (mayAttach) b.operationFailureOrigin = {failureId: latestWorkspaceFailureId(next)!,
        operationId: op.id, requestId: op.requestId, kind: op.kind as "invite" | "remove",
        email: op.email, claimedAt: op.claimedAt, failedAt: now};
    }
    return next;
  }
  let evidence: string, origin: OperationFailureOrigin | null = null;
  if (op.kind === "mail") {
    if (!args.providerMessageId || !/^[a-zA-Z0-9_-]{5,200}$/.test(args.providerMessageId))
      throw new Error("需要 Gmail 或发信服务返回的消息 ID。");
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
    origin = resolvedOperationOrigin(next, op, s);
    if (op.kind === "invite" && args.invitationSentAt) {
      if (time(args.invitationSentAt) < time(op.claimedAt) || time(args.invitationSentAt) > time(s.observedAt))
        throw new Error("邀请发出时间必须位于本次实际办理与核实之间。");
      const r = next.requests.find(r => r.id === op.requestId);
      if (r?.status === "pending_invite" || r?.status === "pending_removal" && r.removalReason === "whitelist_revoked")
        next = transition(next, systemActor, { type: "confirm_invited", id: r.id, sentAt: args.invitationSentAt }, now) as BridgeState;
    }
    next = observeWorkspace(next, s, now, op.id); b = bridge(next);
    if (op.kind === "invite") b.inviteVerifiedAt = now;
    else if (op.originalPresence === "member") b.removalVerifiedAt = now;
    else b.invitationRevokedAt = now;
    evidence = s.pageUrl;
  }
  b.receipts.push({ id: op.id, kind: op.kind, email: op.email, at: now, evidence });
  b.receipts = b.receipts.slice(-500);
  if (hold) b.holds = b.holds?.filter(h => h.operation.id !== op.id);
  else {
    delete b.lease;
    // A verified target receipt cannot clear a workspace-wide safety incident.
    if (!b.globalFailureCode) delete b.lastError;
  }
  finishOperationFault(next, origin, now);
  record(next, "codex_verified_" + op.kind, now, op.requestId);
  return next;
}

/** Report a failure before an external action, or isolate the matching active lease.
 * No retry, success receipt, seat release or access change is implied. */
export function deferOperation(input: BridgeState, args: {
  kind: Lease["kind"]; targetId: string; failureCode: FailureCode; detail?: string;
}, now: string): BridgeState {
  const next = structuredClone(input), b = bridge(next);
  const code = failureCode(args.failureCode, args.kind);
  if (!["mail", "invite", "remove"].includes(args.kind)) throw new Error("操作类型无效。");
  if (b.lease) {
    if (b.lease.kind !== args.kind || b.lease.targetId !== args.targetId)
      throw new Error("必须先核对当前未完成操作。");
    return completeOperation(next, { operationId: b.lease.id, token: b.lease.token,
      outcome: "blocked", failureCode: code, detail: args.detail }, now);
  }
  const notice = args.kind === "mail" ? next.notices.find(n => n.id === args.targetId) : undefined;
  const r = next.requests.find(r => r.id === (notice?.requestId ?? args.targetId));
  if (!r || (args.kind === "mail" && (!notice || notice.type !== "expiry_30m")))
    throw new Error("故障目标不存在。");
  if (r.email === PROTECTED_OWNER_EMAIL || next.config.protectedEmails.includes(r.email))
    throw new Error("Owner 保留账号受保护。");
  const detail = (args.detail ?? "该操作已暂停，等待管理员核查。").slice(0, 500);
  if (code === "browser_unavailable" && b.globalFailureCode && b.globalFailureCode !== code)
    throw new Error("不能把现有全局故障降级为可自动恢复的浏览器故障。");
  if (!isIsolated(code)) {
    delete b.operationFailureOrigin;
    b.lastError = detail; b.globalFailureCode = code;
    if (code === "browser_unavailable") b.browserUnavailableAt ??= now;
    else delete b.browserUnavailableAt;
  } else if (!targetHeld(next, args.kind, args.targetId, r.email)) {
    b.holds ??= [];
    b.holds.push({ code, detail, at: now, attempted: false, operation: {
      id: `deferred_${next.revision}_${time(now)}`, token: "", kind: args.kind,
      targetId: args.targetId, requestId: r.id, email: r.email,
      claimedAt: now, expiresAt: now, status: "uncertain",
    } });
  }
  record(next, isIsolated(code) ? "codex_defer_" + args.kind : "codex_workspace_blocked", now, r.id);
  return next;
}

export function reviewFailure(input: BridgeState, args: {
  decision: "retry_not_started" | "resume_workspace" | "recover_browser" | "recover_login" | "resume_preclaim_inventory" | "resume_verified_operation";
  operationId?: string; expectedFailureId?: string; expectedTargetId?: string; observation?: Observation;
}, now: string): BridgeState {
  let next = structuredClone(input), b = bridge(next);
  if (b.lease) throw new Error("仍有未完成操作，必须先提交真实核实回执。");
  if (args.decision === "retry_not_started") {
    const hold = b.holds?.find(h => h.operation.id === args.operationId);
    if (!hold || hold.attempted) throw new Error("只有明确未开始外部操作的隔离项可重新排队；其余需核实真实结果。");
    if (hold.operation.kind !== "mail") {
      next = observeWorkspace(next, args.observation!, now); b = bridge(next);
      if (b.lastError) throw new Error("工作空间异常尚未排除。");
    }
    b.holds = b.holds?.filter(h => h.operation.id !== args.operationId);
    record(next, "codex_review_unstarted", now, hold.operation.requestId);
  } else if (args.decision === "resume_workspace" || args.decision === "recover_browser" || args.decision === "recover_login" || args.decision === "resume_preclaim_inventory" || args.decision === "resume_verified_operation") {
    if(args.decision==='recover_login') {
      const failure=[...next.audit].reverse().find(a=>a.action==='codex_workspace_blocked');
      if(b.enabled!==true || b.testOnly!==false || b.globalFailureCode!=='login_expired' || !b.lastError ||
        (b.holds?.length??0)!==0 || b.operationFailureOrigin || b.mailChannelError ||
        !args.expectedFailureId || args.expectedFailureId!==failure?.id ||
        !next.config.inventoryVerified || next.config.workspaceId!==TARGET_WORKSPACE_ID)
        throw new Error('登录故障已变化或尚有未结案记录，禁止自动恢复。');
      const checked=validateObservation(args.observation!,now),entries=[...checked.members,...checked.invites];
      if(time(checked.observedAt)<time(failure.at) || checked.totalSeats!==next.config.totalSeats || entries.length>checked.totalSeats ||
        new Set(entries.map(p=>norm(p.email))).size!==entries.length ||
        checked.members.some(p=>norm(p.email)===PROTECTED_OWNER_EMAIL?p.role!=='owner':p.role!=='member') ||
        checked.invites.some(p=>p.role!=='member'||norm(p.email)===PROTECTED_OWNER_EMAIL))
        throw new Error('登录恢复缺少同一故障后的完整官方安全证据。');
    }
    if (args.decision === "resume_preclaim_inventory" &&
        (b.enabled !== true || b.testOnly !== false || b.globalFailureCode !== "unknown" ||
         b.lastError !== PRECLAIM_INVENTORY_ERROR || (b.holds?.length ?? 0) !== 0 || b.mailChannelError ||
         !args.expectedFailureId || args.expectedFailureId !== latestWorkspaceFailureId(next)))
      throw new Error("未开始成员写入的故障已变化或存在其他未结案事项；不得恢复。");
    if (args.decision === "resume_verified_operation") {
      // This guard runs inside mutateState's revision CAS. A fresh incident,
      // lease, missing original receipt or changed request invalidates it.
      const failure = [...next.audit].reverse().find(a => a.action === "codex_workspace_blocked");
      const receipts = b.receipts.filter(r => r.id === args.operationId);
      const receipt = receipts[0];
      const request = next.requests.find(r => r.id === failure?.requestId);
      const action = receipt?.kind === "joined_during_revocation" ? "codex_joined_during_revocation" : `codex_verified_${receipt?.kind}`;
      const matchingAudit = next.audit.filter(a => a.action === action && a.requestId === failure?.requestId && a.at === receipt?.at);
      const failureIndex = next.audit.findIndex(a => a.id === args.expectedFailureId);
      const subsequentVerified = next.audit.slice(failureIndex + 1).filter(a => a.requestId === failure?.requestId &&
        ["codex_verified_invite", "codex_verified_remove", "codex_joined_during_revocation"].includes(a.action));
      if (b.enabled !== true || b.testOnly !== false || b.globalFailureCode !== "unknown" ||
          b.lastError !== POSTCLAIM_UNCERTAIN_ERROR || (b.holds?.length ?? 0) !== 0 || b.mailChannelError ||
          !args.expectedFailureId || args.expectedFailureId !== failure?.id || !failure.requestId ||
          !args.expectedTargetId || args.expectedTargetId !== failure.requestId ||
          (b.reviewReceipts ?? []).some(r => r.failureId === args.expectedFailureId) ||
          !args.operationId || receipts.length !== 1 || !receipt || !request ||
          !["invite", "remove", "joined_during_revocation"].includes(receipt.kind) ||
          norm(receipt.email) !== norm(request.email) || norm(request.email) === PROTECTED_OWNER_EMAIL ||
          next.config.protectedEmails.includes(norm(request.email)) || matchingAudit.length !== 1 ||
          failureIndex < 0 || subsequentVerified.length !== 1 || subsequentVerified[0].id !== matchingAudit[0].id ||
          time(receipt.at) < time(failure.at))
        throw new Error("故障、原操作回执或申请目标已变化，不能解除工作空间暂停。");
      const evidence = new URL(receipt.evidence);
      if (evidence.protocol !== "https:" || evidence.hostname !== "admin.openai.com" ||
          evidence.pathname !== "/workspace/" + TARGET_WORKSPACE_ID + "/members")
        throw new Error("原操作缺少目标工作空间的官方回执。");
      const snapshot = validateObservation(args.observation!, now);
      const entries = [...snapshot.members, ...snapshot.invites];
      if (time(snapshot.observedAt) < time(receipt.at) || time(snapshot.observedAt) < time(failure.at) ||
          !next.config.inventoryVerified || next.config.workspaceId !== TARGET_WORKSPACE_ID ||
          snapshot.totalSeats !== next.config.totalSeats || entries.length > snapshot.totalSeats ||
          new Set(entries.map(p => norm(p.email))).size !== entries.length ||
          snapshot.members.some(p => norm(p.email) === PROTECTED_OWNER_EMAIL ? p.role !== "owner" : p.role !== "member") ||
          snapshot.invites.some(p => p.role !== "member" || norm(p.email) === PROTECTED_OWNER_EMAIL))
        throw new Error("工作空间容量、成员角色或名单异常，不能解除暂停。");
    }
    if (args.decision === "recover_browser" &&
        (b.globalFailureCode !== "browser_unavailable" || !b.browserUnavailableAt))
      throw new Error("自动恢复仅适用于未开始外部操作的浏览器暂不可用故障。");
    validateObservation(args.observation!, now);
    delete b.lastError; delete b.globalFailureCode; delete b.operationFailureOrigin;
    next = observeWorkspace(next, args.observation!, now); b = bridge(next);
    if (b.lastError) throw new Error("最新官方证据仍有工作空间异常。");
    b.workspaceReviewedAt = now;
    if (args.decision === "resume_verified_operation") {
      // Stored in the same CAS as the cleared failure. Old receipts may age
      // out, in which case clients must stop rather than infer success.
      b.reviewReceipts = [...(b.reviewReceipts ?? []), {failureId: args.expectedFailureId!,
        targetId: args.expectedTargetId!, operationId: args.operationId!,
        workspaceId: TARGET_WORKSPACE_ID, observedAt: args.observation!.observedAt, reviewedAt: now}].slice(-1000);
    }
    delete b.browserUnavailableAt;
    record(next, args.decision === "recover_browser" ? "codex_browser_recovered" : args.decision === "recover_login" ? "codex_login_recovered" :
      args.decision === "resume_preclaim_inventory" ? "codex_review_preclaim_inventory" :
      args.decision === "resume_verified_operation" ? "codex_review_verified_operation" : "codex_review_workspace", now);
  } else throw new Error("核查决定无效。");
  return next;
}

export function verifiedReviewReceipt(input: BridgeState, key: {
  failureId: string; targetId: string; operationId: string;
}) {
  if (!key || !/^codex_[a-zA-Z0-9_]{1,140}$/.test(key.failureId ?? "") ||
      !/^req_[a-zA-Z0-9_]{1,140}$/.test(key.targetId ?? "") ||
      !/^op_[a-zA-Z0-9_-]{1,140}$/.test(key.operationId ?? ""))
    throw new Error("复核回执查询参数无效。");
  const matches = (input.codex?.reviewReceipts ?? []).filter(r => r.failureId === key.failureId &&
    r.targetId === key.targetId && r.operationId === key.operationId);
  if (matches.length > 1) throw new Error("复核回执不唯一，保持暂停。");
  return { receipt: matches[0] ?? null };
}
