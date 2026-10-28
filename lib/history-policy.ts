import type { Actor, AuditRecord, Notice, RequestRecord, State } from "./seat-engine.ts";
import { AUTHORIZED_TEST_EMAIL } from "./seat-engine.ts";
import type { BridgeState } from "./codex-bridge.ts";

export const HISTORY_LIMITS = { requests: 150, notices: 500, audit: 500 } as const;
export type HistoryKind = "request" | "notice" | "audit";
export type HistoryRecord = RequestRecord | Notice | AuditRecord;
export type HistoryRow = { kind: HistoryKind; id: string; email: string; userId: string; sortAt: string; payload: string };
const closed = new Set(["completed", "cancelled"]);
const recent = <T>(items: T[], at: (item: T) => string) => [...items].sort((a, b) => at(b).localeCompare(at(a)));

function row(kind: HistoryKind, item: HistoryRecord): HistoryRow {
  return { kind, id: item.id, email: "email" in item ? item.email : "", userId: "userId" in item ? item.userId : "",
    sortAt: "createdAt" in item ? item.createdAt : item.at, payload: JSON.stringify(item) };
}

/** Only immutable, settled history leaves the allocation document. All writes
 * below are committed with the original CAS, never as a best-effort side job. */
export function compactHistory(previous: State, input: State) {
  const state = structuredClone(input) as BridgeState;
  const bridge = state.codex;
  const protectedRequests = new Set<string>();
  const protectedNotices = new Set<string>();
  for (const operation of [bridge?.lease, ...(bridge?.holds ?? []).map(h => h.operation)]) {
    if (!operation) continue;
    if (operation.requestId) protectedRequests.add(operation.requestId);
    if (operation.kind === "mail") protectedNotices.add(operation.targetId);
    else protectedRequests.add(operation.targetId);
  }
  if (bridge?.operationFailureOrigin?.requestId) protectedRequests.add(bridge.operationFailureOrigin.requestId);
  const activeRescue=bridge?.faultRescue && ['pending','uncertain'].includes(bridge.faultRescue.phase)?bridge.faultRescue:null;
  for(const target of activeRescue?.targets??[])protectedRequests.add(target.targetId);
  const rescueFailure=activeRescue?state.audit.find(a=>a.id===activeRescue.failureId):undefined;
  if(rescueFailure?.requestId)protectedRequests.add(rescueFailure.requestId);
  const latestFailure = [...state.audit].reverse().find(a => a.action === "codex_workspace_blocked");
  if ((bridge?.globalFailureCode || bridge?.lastError) && latestFailure?.requestId)
    protectedRequests.add(latestFailure.requestId);
  const retainedClosed = new Set(recent(state.requests.filter(r => closed.has(r.status)), r => r.updatedAt)
    .slice(0, HISTORY_LIMITS.requests).map(r => r.id));
  const rows: HistoryRow[] = [];
  state.requests = state.requests.filter(r => {
    if (!closed.has(r.status) || retainedClosed.has(r.id) || protectedRequests.has(r.id)) return true;
    rows.push(row("request", r)); return false;
  });
  const openRequests = new Map(state.requests.filter(r => !closed.has(r.status)).map(r => [r.id, r]));
  const recentNotices = new Set(recent(state.notices, n => n.createdAt).slice(0, HISTORY_LIMITS.notices).map(n => n.id));
  state.notices = state.notices.filter(n => {
    const request = openRequests.get(n.requestId);
    const cycle = request?.expiresAt ?? request?.invitedAt ?? request?.createdAt;
    // A long-lived, repeatedly renewed request must not pin every historic
    // notice. Keep its CURRENT cycle's deduplication keys and actionable mail;
    // old cycles are immutable and remain readable from the archive.
    const currentCycle = request && n.key === `${request.id}:${n.type}:${cycle}`;
    if (recentNotices.has(n.id) || currentCycle || protectedNotices.has(n.id)) return true;
    rows.push(row("notice", n)); return false;
  });
  // Keep the latest incident and every audit event for an unsettled target,
  // including multiple verified events that must still cause an ambiguity
  // rejection. Unrelated application history must not grow a blocked document.
  const keep = new Set(state.audit.slice(-HISTORY_LIMITS.audit).map(a => a.id));
  if ((bridge?.globalFailureCode || bridge?.lastError) && latestFailure) keep.add(latestFailure.id);
  if (bridge?.operationFailureOrigin?.failureId) keep.add(bridge.operationFailureOrigin.failureId);
  if(activeRescue)keep.add(activeRescue.failureId);
  for (const item of state.audit) if (item.requestId && protectedRequests.has(item.requestId)) keep.add(item.id);
  for (const item of state.audit) if (!keep.has(item.id)) rows.push(row("audit", item));
  state.audit = state.audit.filter(a => keep.has(a.id));
  // Also preserve previous records displaced by a legacy/special transform.
  const surviving = new Set(state.audit.map(a => a.id));
  for (const item of previous.audit) if (!surviving.has(item.id)) rows.push(row("audit", item));
  return { state, rows: [...new Map(rows.map(r => [`${r.kind}:${r.id}`, r])).values()] };
}

export function canReadHistory(item: { email?: string; userId?: string }, actor: Actor) {
  return actor.isAdmin || (item.email === actor.email && (item.userId === actor.userId ||
    item.userId === `inventory:${actor.email}` || (actor.email === AUTHORIZED_TEST_EMAIL && item.userId === `test:${AUTHORIZED_TEST_EMAIL}`)));
}

/** Reconstitute CURRENT data for a V11 rollback; never restore a stale state
 * snapshot. The caller must stop all executors and CAS this result at revision. */
export function rehydrateHistory(input: State, rows: HistoryRow[]) {
  const state = structuredClone(input) as BridgeState;
  if(state.codex?.faultRescue && ['pending','uncertain'].includes(state.codex.faultRescue.phase))
    throw new Error('故障诊断仍持有执行权，禁止回退或覆盖当前状态。');
  if (state.codex?.lease || state.codex?.holds?.length || state.codex?.operationFailureOrigin)
    throw new Error("存在未结案操作，禁止恢复历史；请先按原租约核对结案。");
  if (state.requests.some(r => r.status === "pending_removal" && (r.removalReason as string) === "whitelist_revoked"))
    throw new Error("存在 V12 白名单撤邀待办；请先核实结案，禁止交给 V11 按普通回收办理。");
  const target = { request: state.requests, notice: state.notices, audit: state.audit };
  for (const item of rows) {
    const value = JSON.parse(item.payload) as HistoryRecord;
    if (value.id !== item.id || (item.kind === "request" && !("status" in value && closed.has(value.status))))
      throw new Error("归档记录校验失败，未修改当前状态。");
    const list = target[item.kind] as HistoryRecord[];
    if (!list.some(existing => existing.id === value.id)) list.push(value);
  }
  state.requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  state.notices.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  state.audit.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return state;
}
