import type { BridgeState } from "./codex-bridge.ts";

export type ReminderMode = "in_app" | "relay";
export function reminderMode(value?: string): ReminderMode {
  return value === "relay" ? "relay" : "in_app";
}

// This is a server-owned delivery setting, never supplied by an employee command.
// Retain notices and unresolved leases; disabling email is not a delivery receipt.
export function applyReminderPolicy(input: BridgeState, mode: ReminderMode): BridgeState {
  const state = structuredClone(input);
  state.codex ??= { enabled: false, testOnly: true, mailEnabled: false, receipts: [] };
  state.codex.mailEnabled = mode === "relay";
  if (mode === "in_app" && state.codex.lease?.kind !== "mail" &&
      !state.codex.holds?.some(h => h.operation.kind === "mail"))
    delete state.codex.mailChannelError;
  return state;
}

export function expiryReminder(request: { status: string; expiresAt?: string | null } | undefined,
  now: number, stale = false) {
  if (!request || request.status !== "active" || stale || !request.expiresAt) return null;
  const remaining = Date.parse(request.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 30 * 60_000) return null;
  return { deadline: request.expiresAt, seconds: Math.ceil(remaining / 1000) };
}
