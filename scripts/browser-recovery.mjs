import { access } from "node:fs/promises";
import path from "node:path";
import { ADMIN_EMAIL, TARGET_WORKSPACE } from "./queue-checker-core.mjs";

const currentPlan = value => value?.plan ?? value;
function identity(plan) {
  if (plan.workspaceId !== TARGET_WORKSPACE || plan.administrator !== ADMIN_EMAIL)
    throw new Error("Unexpected recovery workspace or administrator.");
}

// A local blocked ack is released only by a newer, authenticated cloud review
// that itself required fresh full official evidence. Uncertain actions/queues
// and active leases never qualify. Done/isolated event deduplication is retained.
export function reconcileDispatchRecovery(state, plan, now = Date.now()) {
  identity(plan);
  if (state.active || (state.halted ? state.halted.reason !== "ack_blocked" : state.browserRecovery?.state !== "waiting") || !plan.enabled || plan.testOnly ||
      plan.busy || plan.lease || plan.lastError || plan.globalFailureCode) return false;
  const reviewed = Date.parse(plan.workspaceReviewedAt), halted = Date.parse(state.halted?.at ?? state.browserRecovery?.blockedAt);
  if (!Number.isFinite(reviewed) || !Number.isFinite(halted) || reviewed <= halted || reviewed > now + 5000)
    return false;
  state.recoveries = [...(state.recoveries ?? []), { at: new Date(now).toISOString(),
    priorHalt: state.halted, workspaceReviewedAt: plan.workspaceReviewedAt, source: "verified_cloud_review" }].slice(-100);
  delete state.halted;
  if (state.browserRecovery) {
    state.browserRecovery.state = "recovered";
    state.browserRecovery.recoveredAt = new Date(now).toISOString();
    delete state.browserRecovery.nextCheckAt; delete state.browserRecovery.error;
  }
  for (const [key, value] of Object.entries(state.seen ?? {}))
    if (value.outcome === "blocked") delete state.seen[key];
  return true;
}

export function browserRecoveryEligible(state, plan) {
  identity(plan);
  return plan.enabled && !plan.testOnly && !plan.busy && !plan.lease && !state.active &&
    (!state.halted || state.halted.reason === "ack_blocked") &&
    plan.globalFailureCode === "browser_unavailable" && plan.browserRecovery?.eligible === true &&
    Number.isFinite(Date.parse(plan.browserRecovery.blockedAt));
}

// Uses only the existing isolated administrator profile. No sign-in automation,
// cookie extraction, CAPTCHA solving, invitation or removal is available here.
export async function observeOfficialReadOnly() {
  const { loadConfig } = await import("./seat-executor/config.mjs");
  const { BrowserAdapter } = await import("./seat-executor/browser.mjs");
  const { bridgeObservation } = await import("./seat-executor/inventory.mjs");
  const config = await loadConfig();
  await access(path.join(config.profile, "Default"));
  const browser = new BrowserAdapter({ ...config, liveActions: false });
  try { return bridgeObservation(await browser.observe()); }
  finally { await browser.close(); }
}

export async function recoverBrowser({ client, session, plan, state,
  observe = observeOfficialReadOnly, clock = () => new Date() }) {
  if (!browserRecoveryEligible(state, plan)) return { plan, kind: "not_eligible" };
  const now = clock().getTime(), blockedAt = plan.browserRecovery.blockedAt;
  if (state.browserRecovery?.blockedAt !== blockedAt)
    state.browserRecovery = { blockedAt, attempts: 0 };
  const recovery = state.browserRecovery;
  if (now < Date.parse(recovery.nextCheckAt)) return { plan, kind: "waiting" };
  recovery.attempts++;
  recovery.lastCheckedAt = clock().toISOString();
  // Persisted by the checker even if the browser is unavailable. Backoff is
  // deterministic; checking an unchanged outage never wakes a model.
  const delay = [60_000, 120_000, 300_000, 900_000][Math.min(recovery.attempts - 1, 3)];
  recovery.nextCheckAt = new Date(now + delay).toISOString();
  try {
    const observation = await observe();
    const reviewed = currentPlan(await client.portal(session, "review_seat_failure", {
      decision: "recover_browser", observation,
    }));
    identity(reviewed);
    if (reviewed.lastError || reviewed.globalFailureCode || reviewed.busy || reviewed.lease || !reviewed.workspaceReviewedAt)
      throw new Error("Recovery review did not confirm a healthy workspace.");
    recovery.state = "recovered"; recovery.recoveredAt = clock().toISOString();
    delete recovery.nextCheckAt; delete recovery.error;
    reconcileDispatchRecovery(state, reviewed, clock().getTime());
    return { plan: reviewed, kind: "recovered" };
  } catch {
    recovery.state = "waiting";
    recovery.nextCheckAt = new Date(clock().getTime() + delay).toISOString();
    recovery.error = "官方后台尚未通过只读核验；保持暂停，不执行成员操作。";
    return { plan, kind: "waiting" };
  }
}

export function canDeliverDuringBrowserPause(state, plan) {
  return browserRecoveryEligible(state, plan) && !plan.mailChannelError;
}
