import type { State, RequestRecord } from "./seat-engine.ts";

export const INVITATION_MINUTES = 5;
export const INVITATION_MS = INVITATION_MINUTES * 60_000;
export function invitationDeadline(r: Pick<RequestRecord, "invitedAt" | "joinDeadlineAt">) {
  return r.joinDeadlineAt ?? (r.invitedAt ? new Date(Date.parse(r.invitedAt) + INVITATION_MS).toISOString() : null);
}
export type WaitEstimate = {
  status: "ready" | "estimated" | "uncertain" | "paused";
  earliestAt: string | null; latestAt: string | null; reason: string;
};
const uncertain = (reason: string): WaitEstimate => ({ status: "uncertain", earliestAt: null, latestAt: null, reason });

/** Two parallel FIFO simulations: invitation times out vs the employee uses the
 * requested duration. These are planning estimates, never a capacity grant. */
export function queueForecast(state: State, now: string) {
  const instant = Date.parse(now);
  const queue = state.requests.filter(r => r.status === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const count = Math.max(0, state.config.totalSeats - state.config.reservedSeats);
  const bridge = (state as State & { codex?: { enabled: boolean; testOnly: boolean; lastError?: string; holds?: { operation: { kind: string; email: string } }[] } }).codex;
  const paused = !state.config.inventoryVerified || !state.config.workspaceId || !state.config.automationEnabled ||
    bridge?.enabled === false || bridge?.testOnly === true || Boolean(bridge?.lastError);
  const pauseReason = !state.config.inventoryVerified ? "等待管理员核对席位" : "自动办理未启用或已暂停";
  const startSlots = (upper: boolean) => {
    const slots: number[] = [];
    for (const r of state.requests.filter(r => ["pending_invite", "invited", "active", "pending_removal"].includes(r.status))) {
      const held = bridge?.holds?.some(h => h.operation.kind !== "mail" && h.operation.email === r.email);
      let freeAt = Infinity;
      if (!held && r.status === "active" && r.expiresAt && Date.parse(r.expiresAt) > instant)
        freeAt = Date.parse(r.expiresAt);
      if (!held && r.status === "invited") {
        const deadline = invitationDeadline(r);
        if (deadline && Date.parse(deadline) > instant)
          freeAt = upper ? Date.parse(deadline) + r.hours * 3_600_000 : Date.parse(deadline);
      }
      // Pending invitation/removal and fixed members have no reliable finish time.
      slots.push(freeAt);
    }
    if (slots.length > count) return [];
    while (slots.length < count) slots.push(instant);
    return slots;
  };
  const low = startSlots(false), high = startSlots(true);
  const take = (slots: number[], r?: RequestRecord) => {
    slots.sort((a, b) => a - b);
    const next = slots[0];
    if (!Number.isFinite(next)) return null;
    if (r) slots[0] = next + INVITATION_MS + r.hours * 3_600_000;
    return next;
  };
  const estimate = (r?: RequestRecord): WaitEstimate => {
    if (paused) return { status: "paused", earliestAt: null, latestAt: null, reason: pauseReason };
    const earliest = take(low, r), latest = take(high, r);
    if (earliest === null || latest === null) return uncertain("等待实际邀请／回收确认或固定席位释放");
    return { status: latest <= instant ? "ready" : "estimated",
      earliestAt: new Date(earliest).toISOString(), latestAt: new Date(latest).toISOString(),
      reason: "按当前到期时间、邀请等待窗口及前方申请时长估算；不含实际办理延迟，续期和提前释放会改变结果" };
  };
  const byRequest: Record<string, WaitEstimate> = {};
  for (const r of queue) {
    if (!state.config.whitelist.includes(r.email)) { byRequest[r.id] = uncertain("申请邮箱待管理员核查"); continue; }
    byRequest[r.id] = estimate(r);
  }
  return { byRequest, nextApplicant: estimate() };
}
