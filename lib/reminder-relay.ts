import { claimOperation, completeOperation, workPlan, type BridgeState } from "./codex-bridge.ts";
import { reminderMessage } from "./reminder-message.ts";

type RelayConfig = { url: string; token: string; portalUrl: string };
type Store = {
  read(): Promise<BridgeState>;
  mutate(change: (state: BridgeState) => BridgeState): Promise<BridgeState>;
};

export function validateRelay(config: RelayConfig) {
  for (const address of [config.url, config.portalUrl]) {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("邮件中继和门户地址必须使用不含凭据的 HTTPS。");
  }
  const portal = new URL(config.portalUrl);
  if (portal.search || portal.pathname !== "/") throw new Error("门户地址必须是 HTTPS 根地址。");
  if (!config.token || /[\r\n]/.test(config.token)) throw new Error("邮件中继凭据无效。");
}

/** One lease per message, persisted before I/O. Never retries an unknown send. */
export async function deliverReminders(store: Store, config: RelayConfig, {
  clock = () => new Date().toISOString(), fetcher = fetch,
  token = () => crypto.randomUUID(), limit = 10,
} = {}) {
  validateRelay(config);
  let sent = 0;
  for (let i = 0; i < limit; i++) {
    const state = await store.read();
    const plan = workPlan(state, clock());
    if (!plan.enabled || plan.busy || plan.lastError || !plan.reminders.length) break;
    const noticeId = plan.reminders[0].id, claimToken = token();
    let claimed: BridgeState;
    try {
      claimed = await store.mutate(s => claimOperation(s, "mail", noticeId, claimToken, clock()));
    } catch {
      // Renewal, expiry or another worker can win the CAS. No I/O happened.
      break;
    }
    const lease = claimed.codex!.lease!;
    const notice = claimed.notices.find(n => n.id === noticeId)!;
    let providerMessageId: string;
    try {
      const response = await fetcher(config.url, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`, "Idempotency-Key": notice.key },
        body: JSON.stringify({
          notificationId: notice.id, idempotencyKey: notice.key, to: lease.email,
          ...reminderMessage(notice, lease.expectedExpiry!, config.portalUrl),
          expectedExpiry: lease.expectedExpiry,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const receipt = await response.json() as { accepted?: boolean; id?: string; notificationId?: string };
      if (!response.ok || receipt.accepted !== true ||
          receipt.notificationId !== notice.id || !/^[a-zA-Z0-9_-]{5,200}$/.test(receipt.id ?? ""))
        throw new Error("Missing or mismatched delivery receipt.");
      providerMessageId = receipt.id!;
    } catch {
      await store.mutate(s => completeOperation(s, {
        operationId: lease.id, token: claimToken, outcome: "uncertain",
        failureCode: "mail_delivery",
        detail: "邮件中继结果不明；请按通知 ID 核查发信记录，禁止切换通道重复发送。",
      }, clock()));
      break;
    }
    // If persistence fails, the existing lease still blocks a resend.
    await store.mutate(s => completeOperation(s, {
      operationId: lease.id, token: claimToken, outcome: "verified", providerMessageId,
    }, clock()));
    sent++;
  }
  return { sent };
}
