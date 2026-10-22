import { bridgeObservation, presence } from "./inventory.mjs";

const minute = 60_000;
const at = value => Date.parse(value || "");

export function acceptanceDue(request, now = Date.now()) {
  const sent = at(request.invitedAt);
  if (!Number.isFinite(sent)) return false;
  const age = now - sent;
  const deadline = Number.isFinite(at(request.joinDeadlineAt))
    ? at(request.joinDeadlineAt) : sent + 5 * minute;
  if (age < 0 || now >= deadline) return false;
  const checked = at(request.acceptanceCheckedAt);
  const requested = at(request.acceptanceRequestedAt);
  if (Number.isFinite(requested) && requested <= now &&
      (!Number.isFinite(checked) || requested > checked)) return true;
  return [2, 4].some(n => age >= n * minute && age < 5 * minute &&
    (!Number.isFinite(checked) || checked < sent + n * minute));
}

function currentPlan(value) { return value.plan ?? value; }
function assertPlan(plan, config) {
  if (plan.workspaceId !== config.workspaceId || plan.administrator !== config.adminEmail)
    throw new Error("门户工作空间或管理员与本机配置不一致。");
  if (!plan.enabled || plan.testOnly || plan.lastError || plan.globalFailureCode)
    throw new Error("门户执行器未启用或已有全局故障。");
  if (plan.busy || plan.lease) throw new Error("已有未完成办理；须先核对真实结果。");
}

export async function processOnce({ portal, browser, mailer, config, clock = () => new Date() }) {
  if (!config.liveActions) {
    const view = currentPlan(await portal.call("seat_portal_status"));
    return { mode: "dry_run", pending: { invites: view.invites.length,
      removals: view.removals.length, reminders: view.reminders.length,
      acceptance: view.awaitingAcceptance.length } };
  }
  if (!config.legacyCheckerDisabled)
    throw new Error("旧按需检查器尚未确认停止，禁止并行办理同一工作空间。");
  const jobs = await portal.call("process_seat_queue");
  if (jobs?.mailMode && (jobs.mailMode === "relay") !== (config.mailMode === "relay"))
    throw new Error("本机与云端邮件通道不一致，禁止产生重复提醒。");
  let plan = currentPlan(await portal.call("seat_portal_status"));
  assertPlan(plan, config);
  const summary = { invites: plan.invites.length, removals: plan.removals.length,
    reminders: plan.reminders.length, acceptance: plan.awaitingAcceptance.length };
  // runJobs may have sent an HTTPS-relay reminder. It uses the same D1 lease.
  // Reclaiming an expired seat must not wait behind an unrelated reminder.
  if (!plan.removals.length && !plan.invites.length && plan.reminders.length && mailer) {
    const notice = plan.reminders[0];
    const claimed = currentPlan(await portal.call("claim_seat_operation", {
      kind: "mail", targetId: notice.id,
    }));
    const lease = claimed.lease;
    if (!lease || lease.kind !== "mail" || lease.email !== notice.email)
      throw new Error("邮件租约目标与待办不一致。");
    let messageId;
    try { messageId = await mailer.send(notice, lease.expectedExpiry); }
    catch (error) {
      await portal.call("complete_seat_operation", { operationId: lease.id, token: lease.token,
        outcome: "uncertain", failureCode: "mail_delivery",
        detail: "普通程序邮件发送结果不明；按通知 ID 核查已发送记录，不得自动重发。" });
      return { mode: "mail_uncertain", targetId: notice.id, error: error.message };
    }
    await portal.call("complete_seat_operation", { operationId: lease.id, token: lease.token,
      outcome: "verified", providerMessageId: messageId });
    return { mode: "mail_verified", targetId: notice.id };
  }

  const wanted = plan.removals[0] ? { kind: "remove", request: plan.removals[0] } :
    plan.invites[0] ? { kind: "invite", request: plan.invites[0] } : null;
  const shouldCheckAcceptance = plan.awaitingAcceptance.some(r => acceptanceDue(r, clock().getTime()));
  if (!wanted && !shouldCheckAcceptance)
    return { mode: plan.reminders.length ? "mail_channel_required" : "idle", pending: summary };

  let before;
  try {
    before = await browser.observe();
    await portal.call("observe_workspace", { observation: bridgeObservation(before) });
  } catch (error) {
    const target = wanted ?? { kind: "invite", request: plan.awaitingAcceptance.find(r => acceptanceDue(r, clock().getTime())) };
    if (target.request) await portal.call("defer_seat_operation", { kind: target.kind,
      targetId: target.request.id, failureCode: error.failureCode ?? "unknown",
      detail: "读取官方完整成员清单失败，已停止成员操作。" });
    throw error;
  }
  if (!wanted) return { mode: "acceptance_checked" };

  plan = currentPlan(await portal.call("seat_portal_status"));
  assertPlan(plan, config);
  const liveTarget = (wanted.kind === "remove" ? plan.removals : plan.invites)
    .find(r => r.id === wanted.request.id && r.email === wanted.request.email);
  if (!liveTarget) return { mode: "target_changed", targetId: wanted.request.id };
  const claimed = currentPlan(await portal.call("claim_seat_operation", {
    kind: wanted.kind, targetId: liveTarget.id,
  }));
  const lease = claimed.lease;
  if (!lease || lease.kind !== wanted.kind || lease.email !== liveTarget.email)
    throw new Error("成员租约目标与待办不一致；已停止外部操作。");

  let attempted = false;
  browser.onExternalAction = () => { attempted = true; };
  try {
    let invitationSentAt;
    if (wanted.kind === "invite") invitationSentAt = await browser.invite(lease.email, before);
    else if (presence(before, lease.email) !== "absent") await browser.remove(lease.email, before);
    const after = await browser.observe();
    const observation = bridgeObservation(after);
    const joined = wanted.kind === "remove" && lease.originalPresence === "invite" &&
      liveTarget.removalReason === "invitation_expired" &&
      presence(after, lease.email) === "member";
    await portal.call("complete_seat_operation", {
      operationId: lease.id, token: lease.token, outcome: joined ? "joined" : "verified",
      observation, ...(invitationSentAt ? { invitationSentAt } : {}),
    });
    return { mode: joined ? "joined_during_revocation" : `${wanted.kind}_verified`,
      targetId: liveTarget.id };
  } catch (error) {
    // Only the original lease may be completed. If its receipt is unclear, do not retry.
    try {
      if (wanted.kind === "remove") {
        const after = await browser.observe();
        const observedPresence = presence(after, lease.email);
        if (observedPresence === "absent") {
          await portal.call("complete_seat_operation", { operationId: lease.id,
            token: lease.token, outcome: "verified", observation: bridgeObservation(after) });
          return { mode: "remove_verified", targetId: liveTarget.id };
        }
        if (lease.originalPresence === "invite" &&
            liveTarget.removalReason === "invitation_expired" &&
            observedPresence === "member") {
          await portal.call("complete_seat_operation", { operationId: lease.id,
            token: lease.token, outcome: "joined", observation: bridgeObservation(after) });
          return { mode: "joined_during_revocation", targetId: liveTarget.id };
        }
      }
      await portal.call("complete_seat_operation", { operationId: lease.id,
        token: lease.token, outcome: attempted ? "uncertain" : "blocked",
        failureCode: "unknown", detail: "成员操作或操作后核实未完成，禁止自动重试。" });
    } catch { /* An unconfirmed lease remains locked; a human must reconcile it. */ }
    throw error;
  }
}
