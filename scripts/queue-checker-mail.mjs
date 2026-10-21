import { ADMIN_EMAIL, TARGET_WORKSPACE } from "./queue-checker-core.mjs";
import { assertGmailSender } from "./seat-executor/gmail-mailer.mjs";

const messageId = value => typeof value === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(value);
const currentPlan = result => result?.plan ?? result;
const isoTime = value => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function codexDispatchPlan(plan, directMail) {
  return directMail ? { ...plan, reminders: [] } : plan;
}

// A successful claim is persisted by the portal before Gmail is contacted. An
// ambiguous send is isolated in the portal and is never retried automatically.
export async function processDirectReminder({ client, session, plan, mailer }) {
  if (plan.workspaceId !== TARGET_WORKSPACE || plan.administrator !== ADMIN_EMAIL)
    throw new Error("Unexpected workspace or administrator; direct mail stopped.");
  if (!Array.isArray(plan.reminders) || typeof plan.enabled !== "boolean" ||
      typeof plan.busy !== "boolean")
    throw new Error("Incomplete reminder plan.");
  if (!plan.enabled || plan.testOnly || plan.busy || plan.lastError || plan.globalFailureCode ||
      plan.mailChannelError || !plan.reminders.length)
    return { kind: "skipped" };
  const notice = plan.reminders[0];
  const prefix = `${notice.requestId}:expiry_30m:`;
  const expiry = typeof notice.key === "string" && notice.key.startsWith(prefix)
    ? notice.key.slice(prefix.length) : null;
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(notice.id ?? "") ||
      !/^[A-Za-z0-9_:.-]{1,250}$/.test(notice.requestId ?? "") ||
      notice.type !== "expiry_30m" || notice.status !== "pending" || !isoTime(expiry) ||
      typeof notice.title !== "string" || !notice.title.trim() ||
      notice.title.length > 120 || /[\r\n]/.test(notice.title) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notice.email ?? ""))
    throw new Error("Invalid reminder identity.");
  // Identity is checked before the claim, then again in the sender's own
  // App Server session immediately before Gmail is asked to send.
  assertGmailSender(await client.connector(session, "gmail.get_profile", {}));
  const claimed = currentPlan(await client.portal(session, "claim_seat_operation", {
    kind: "mail", targetId: notice.id,
  }));
  const lease = claimed?.lease;
  if (!lease || lease.kind !== "mail" || lease.targetId !== notice.id ||
      lease.email !== notice.email || !lease.id || !lease.token ||
      lease.expectedExpiry !== expiry)
    throw new Error("Reminder claim does not match the selected notice; direct mail stopped.");
  let receipt;
  try {
    receipt = await mailer.send(notice, lease.expectedExpiry);
    if (!messageId(receipt)) throw new Error("Gmail returned no verifiable message ID.");
  } catch {
    await client.portal(session, "complete_seat_operation", {
      operationId: lease.id, token: lease.token, outcome: "uncertain",
      failureCode: "mail_delivery",
      detail: "普通程序发信结果不明；先按通知 ID 核查已发送邮件，禁止自动重发。",
    });
    return { kind: "uncertain", noticeId: notice.id };
  }
  // If this completion fails, keep the claimed lease and never send again.
  await client.portal(session, "complete_seat_operation", {
    operationId: lease.id, token: lease.token, outcome: "verified",
    providerMessageId: receipt,
  });
  return { kind: "sent", noticeId: notice.id };
}

// Keep the checker lock for a small, bounded batch. Fetch the authoritative
// plan after every receipt, and never select the same notice twice in one run.
export async function drainDirectReminders({ client, session, plan, mailer,
  limit = 3, blockedNoticeIds = [] }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw new Error("Invalid reminder batch limit.");
  let current = plan, sent = 0, uncertain = 0;
  const attempted = new Set(), blocked = new Set(blockedNoticeIds);
  for (let index = 0; index < limit && current.reminders?.length; index++) {
    const eligible = current.reminders.filter(item => !blocked.has(item.id));
    if (!eligible.length) break;
    const id = eligible[0]?.id;
    if (attempted.has(id))
      throw new Error("Reminder remained pending after a completion; automatic retry stopped.");
    const result = await processDirectReminder({ client, session,
      plan: { ...current, reminders: eligible }, mailer });
    if (result.kind === "skipped") break;
    attempted.add(id);
    if (result.kind === "sent") sent++;
    else if (result.kind === "uncertain") uncertain++;
    current = currentPlan(await client.portal(session, "seat_portal_status"));
  }
  return { plan: current, sent, uncertain };
}
