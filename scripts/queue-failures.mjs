// This module contains no I/O. Portal isolation records, never a free-form ack,
// decide whether a failed task may yield to unrelated work.
export function settleAcknowledgement(active, ack, plan, events, { ignoreAcceptance = false } = {}) {
  if (!active || ack.id !== active.id || !["done", "blocked", "uncertain"].includes(ack.outcome))
    throw new Error("Acknowledgement does not match the active wake.");
  const held = (plan.blockedOperations ?? []).map(h => h.operation ?? h);
  const originals = active.events ?? [];
  const isolated = originals.filter(e => (plan.mailChannelError && e.kind === "mail") ||
    held.some(h => (h.kind === "mail" ? e.kind === "mail" : e.kind !== "mail") && h.targetId === e.id));
  const remaining = events.filter(e => active.keys.includes(e.key) &&
    !(ignoreAcceptance && e.kind === "acceptance"));
  const fatal = plan.busy || plan.lastError;
  const isolatedFailure = !fatal && plan.faultIsolationVersion === 1 && isolated.length > 0;
  const outcome = fatal ? "blocked" : isolatedFailure ? "isolated"
    : ack.outcome !== "done" ? ack.outcome : remaining.length ? "blocked" : "done";
  return { outcome, isolated, remaining };
}

export function applyAcknowledgement(state, ack, plan, events, options = {}) {
  const decision = settleAcknowledgement(state.active, ack, plan, events, options);
  const unfinished = new Set(decision.remaining.map(e => e.key));
  const isolated = new Set(decision.isolated.map(e => e.key));
  state.seen ??= {};
  for (const key of state.active.keys) {
    // Unprocessed members in a partially failed batch must be dispatched again.
    if (decision.outcome === "isolated" && unfinished.has(key)) continue;
    state.seen[key] = { at: ack.at, outcome: isolated.has(key) ? "isolated" : decision.outcome };
  }
  state.lastAcknowledgement = { id: ack.id, at: ack.at, outcome: decision.outcome,
    originalOutcome: ack.outcome, isolatedEvents: decision.isolated,
    elapsedMs: Math.max(0, (options.now ?? Date.now()) - Date.parse(state.active.createdAt)) };
  if (!["done", "isolated"].includes(decision.outcome))
    state.halted = { reason: `ack_${decision.outcome}`, at: ack.at };
  delete state.active;
  return decision;
}
