import { env } from "cloudflare:workers";
import { mutateState, readState, schedulerActor } from "./portal-service";
import { transition, type State } from "./seat-engine";

type JobState = State & {
  runtime?: { lastTickAt?: string; lastDeliveryError?: string };
  deliveries?: Record<string, { status: "sending" | "sent" | "uncertain"; at: string }>;
};

export async function runJobs() {
  const now = new Date().toISOString();
  let state = await mutateState(current => {
    const changed = transition(current, schedulerActor, { type: "tick" }, now) as JobState;
    changed.runtime = { ...changed.runtime, lastTickAt: now };
    for (const delivery of Object.values(changed.deliveries ?? {})) {
      if (delivery.status === "sending" &&
          Date.parse(now) - Date.parse(delivery.at) > 5 * 60_000) {
        delivery.status = "uncertain";
        changed.runtime.lastDeliveryError =
          "有提醒在发送过程中中断，请到发信服务核查；系统不会盲目重发。";
      }
    }
    return changed;
  }) as JobState;

  // The optional relay must deduplicate on Idempotency-Key. Unknown results
  // are retained for review instead of blindly sending a duplicate reminder.
  const url = env.REMINDER_WEBHOOK_URL;
  const token = env.REMINDER_WEBHOOK_TOKEN;
  if (url && token) {
    const destination = new URL(url);
    if (destination.protocol !== "https:") throw new Error("提醒服务必须使用 HTTPS。");
    for (const notice of state.notices
      .filter(n => n.status === "pending" && !state.deliveries?.[n.key]).slice(0, 20)) {
      let claimed = false;
      await mutateState(current => {
        claimed = false;
        const next = current as JobState;
        if (next.deliveries?.[notice.key]) return next;
        next.deliveries ??= {};
        next.deliveries[notice.key] = { status: "sending", at: now };
        claimed = true;
        return next;
      });
      if (!claimed) continue;
      let confirmed = false;
      try {
        const result = await fetch(destination, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": notice.key,
          },
          body: JSON.stringify({
            idempotencyKey: notice.key,
            to: notice.email,
            subject: notice.title,
            text: notice.message,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const receipt = await result.json() as { accepted?: boolean; id?: string };
        confirmed = result.ok && receipt.accepted === true && typeof receipt.id === "string";
      } catch { /* Unknown side effect; do not retry automatically. */ }
      await mutateState(current => {
        const next = current as JobState;
        next.deliveries ??= {};
        next.deliveries[notice.key] = { status: confirmed ? "sent" : "uncertain", at: now };
        if (confirmed) {
          const target = next.notices.find(n => n.key === notice.key);
          if (target) { target.status = "sent"; target.sentAt = now; }
        } else {
          next.runtime = {
            ...next.runtime,
            lastDeliveryError: "提醒发送结果不明，请在发信服务核查后再处理；系统不会盲目重发。",
          };
        }
        return next;
      });
    }
    state = (await readState()).state as JobState;
  }
  return {
    lastTickAt: now,
    queued: state.requests.filter(r => r.status === "queued").length,
    pendingInvites: state.requests.filter(r => r.status === "pending_invite").length,
    pendingRemovals: state.requests.filter(r => r.status === "pending_removal").length,
    pendingNotices: state.notices.filter(n => n.status === "pending").length,
    unresolvedDeliveries: Object.values(state.deliveries ?? {}).filter(d => d.status !== "sent").length,
    emailConfigured: Boolean(url && token),
    memberAdapter: "not_connected",
  };
}
