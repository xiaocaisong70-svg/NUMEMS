import { env } from "cloudflare:workers";
import { mutateState, readState, schedulerActor } from "./portal-service";
import { transition, type State } from "./seat-engine";
import type { BridgeState } from "./codex-bridge";
import { deliverReminders, validateRelay } from "./reminder-relay";
import { applyReminderPolicy, reminderMode } from "./reminder-policy";

// A pure, atomic queue transform and heartbeat. This helper never delivers
// reminders, contacts a provider, or performs an official member operation.
async function runQueueTick() {
  const now = new Date().toISOString();
  const mode = reminderMode(env.REMINDER_DELIVERY_MODE);
  await mutateState(current => {
    const next = transition(applyReminderPolicy(current, mode), schedulerActor, { type: "tick" }, now) as State & {
      runtime?: { lastTickAt?: string };
    };
    next.runtime = { ...next.runtime, lastTickAt: now };
    return next;
  });
  return { now, mode };
}

function queueSummary(state: BridgeState, now: string, mode: ReturnType<typeof reminderMode>) {
  return {
    lastTickAt: now,
    queued: state.requests.filter(r => r.status === "queued").length,
    pendingInvites: state.requests.filter(r => r.status === "pending_invite").length,
    pendingRemovals: state.requests.filter(r => r.status === "pending_removal").length,
    pendingNotices: state.notices.filter(n => n.status === "pending").length,
    emailConfigured: Boolean(state.codex?.mailVerifiedAt),
    mailMode: mode,
  };
}

/** Safe synchronization endpoint: even relay mode cannot send an email here. */
export async function refreshSeatQueue() {
  const { now, mode } = await runQueueTick();
  return queueSummary((await readState()).state as BridgeState, now, mode);
}

export async function runJobs() {
  const { now, mode } = await runQueueTick();
  // Configuration faults affect only the mail channel; never suppress expiry work.
  if (mode === "relay") {
    const config = { url: env.REMINDER_WEBHOOK_URL ?? "", token: env.REMINDER_WEBHOOK_TOKEN ?? "",
      portalUrl: env.PORTAL_PUBLIC_URL ?? "" };
    let error: string | undefined;
    try { validateRelay(config); } catch { error = "邮件通道配置无效，邮件已暂停；成员回收可继续。"; }
    await mutateState(current => {
      const s = current as BridgeState;
      s.codex ??= { enabled: false, testOnly: true, mailEnabled: true, receipts: [] };
      s.codex.mailChannelError = error;
      return s;
    });
    if (!error) await deliverReminders({
      read: async () => (await readState()).state as BridgeState,
      mutate: change => mutateState(s => change(s as BridgeState)),
    }, config);
  }
  return queueSummary((await readState()).state as BridgeState, now, mode);
}
