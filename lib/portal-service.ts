import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { createState, upgradeState, transition, viewState, type Actor, type State } from "./seat-engine";
import type { BridgeState } from "./codex-bridge";
import { portalAccess, requirePortalAccess } from "./portal-access";
import { applyReminderPolicy, reminderMode } from "./reminder-policy";
import { archivedRequestKey, persistHistoryCas, readHistoryPage } from "./history-store";
import { enforceRequestRate } from "./request-rate-policy";
import type { HistoryKind } from "./history-policy";
import { publicFaultRescue, publicRecoveryProgress, rescueBlocksClaims } from './recovery-control';

export const ADMIN_EMAIL = "xiaocaisong70@gmail.com";
export const ADMIN_CONTACT_EMAIL = "2712467009@qq.com";
export const schedulerActor: Actor = {
  userId: "system:scheduler",
  email: ADMIN_EMAIL,
  isAdmin: true,
};

export async function currentActor() {
  const user = await getChatGPTUser();
  return user ? {
    ...user,
    email: user.email.trim().toLowerCase(),
    isAdmin: user.email.trim().toLowerCase() === ADMIN_EMAIL,
  } : null;
}

function database() {
  if (!env.DB) throw new Error("数据库尚未连接，请完成站点部署。");
  return env.DB;
}

export async function readState(): Promise<{ state: State; revision: number }> {
  const db = database();
  const row = await db.prepare("SELECT revision, document FROM portal_state WHERE id = ?")
    .bind("main").first<{ revision: number; document: string }>();
  if (row) return { state: applyReminderPolicy(upgradeState(JSON.parse(row.document)), reminderMode(env.REMINDER_DELIVERY_MODE)), revision: row.revision };
  const initial = createState(new Date().toISOString());
  await db.prepare("INSERT OR IGNORE INTO portal_state (id,revision,document) VALUES (?,?,?)")
    .bind("main", 0, JSON.stringify(initial)).run();
  const inserted = await db.prepare("SELECT revision,document FROM portal_state WHERE id = ?")
    .bind("main").first<{ revision: number; document: string }>();
  if (!inserted) throw new Error("初始化数据库失败。");
  return { state: applyReminderPolicy(upgradeState(JSON.parse(inserted.document)), reminderMode(env.REMINDER_DELIVERY_MODE)), revision: inserted.revision };
}

// Retrying pure transforms is safe. No email or member mutation belongs here.
export async function mutateState(change: (state: State) => State | Promise<State>): Promise<State> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const old = await readState();
    const next = await change(structuredClone(old.state));
    const result = await persistHistoryCas(database(), old.state, next, old.revision);
    if (result.committed) return result.state;
  }
  throw new Error("当前申请较多，请稍后重试。");
}

export async function runCommand(actor: Actor, command: Record<string, unknown>) {
  const normalized = { ...command, id: command.id ?? command.requestId };
  return mutateState(async state => {
    const now = new Date().toISOString();
    // Recheck the latest whitelist in the same transaction as every mutation.
    requirePortalAccess(state.config, actor);
    // Recheck on EVERY CAS attempt: another writer may have archived the
    // original hot record between attempts. A cached miss is not evidence.
    const archivedDuplicate = command.type === "apply" && typeof command.requestKey === "string" && command.requestKey.length <= 100
      ? await archivedRequestKey(database(), actor, command.requestKey) : null;
    if (archivedDuplicate) return state;
    const changed = transition(state, actor, normalized as Parameters<typeof transition>[2], now);
    enforceRequestRate(state, changed, actor, normalized, now);
    // The same atomic write records the request and any resulting allocation.
    return transition(changed, schedulerActor, { type: "tick" }, now);
  });
}

export async function portalHistory(kind: HistoryKind, cursor?: string | null, limit = 50) {
  const actor = await currentActor();
  if (!actor) return { access: "signin_required" as const, page: null };
  const latest = await readState();
  if (portalAccess(latest.state.config, actor) !== "allowed") return { access: "not_authorized" as const, page: null };
  const page = await readHistoryPage(database(), actor, kind, cursor, limit);
  // A concurrent whitelist revocation must also close an in-flight read.
  const after = await readState();
  requirePortalAccess(after.state.config, actor);
  return { access: "allowed" as const, page };
}

export async function portalData() {
  const user = await currentActor();
  const closed = (access: "signin_required" | "not_authorized") => ({
    user, access, view: null,
    connection: { memberAdapter: "not_connected", scheduler: false, mail: false },
  });
  if (!user) return closed("signin_required");
  const before = await readState();
  if (portalAccess(before.state.config, user) !== "allowed") return closed("not_authorized");
  const serverNow = new Date().toISOString();
  // Pure, atomic queue processing also runs on an authorized refresh. It never
  // sends email or changes official members, even if the local checker is offline.
  const state = await mutateState(current => {
    requirePortalAccess(current.config, user);
    return transition(current, schedulerActor, { type: "tick" }, serverNow);
  });
  const view = viewState(state, user, serverNow);
  // Admin views include the cloned aggregate for existing controls. Never
  // expose the new handoff credential through a page response.
  const aggregateBridge=(view as unknown as {codex?:{faultRescue?:unknown}}).codex;
  if(aggregateBridge?.faultRescue)aggregateBridge.faultRescue=publicFaultRescue(state as BridgeState);
  const runtime = (state as State & { runtime?: { lastTickAt?: string; lastDeliveryError?: string } }).runtime;
  const codex = (state as BridgeState).codex;
  const onDemand = codex?.scheduleId?.startsWith("local:queue-checker:") ?? false;
  const deterministic = codex?.scheduleId?.startsWith("local:seat-executor:") ?? false;
  const checkerFresh = Boolean(runtime?.lastTickAt &&
    Date.now() - Date.parse(runtime.lastTickAt) < 3 * 60_000);
  return {
    user,
    access: "allowed" as const,
    view,
    connection: {
      memberAdapter: codex?.enabled ? (codex.testOnly ? "codex_test" : deterministic ? "deterministic_browser" : "codex_browser") : "not_connected",
      scheduler: onDemand || deterministic ? checkerFresh : Boolean(codex?.scheduleId) || env.PORTAL_SCHEDULE_ENABLED === "true",
      schedulerMode: deterministic ? "deterministic" : onDemand ? "on_demand" : "heartbeat",
      lastTickAt: runtime?.lastTickAt ?? null,
      reminderMode: reminderMode(env.REMINDER_DELIVERY_MODE),
      mail: reminderMode(env.REMINDER_DELIVERY_MODE) === "relay" && Boolean(codex?.mailVerifiedAt || (env.REMINDER_WEBHOOK_URL && env.REMINDER_WEBHOOK_TOKEN)),
      lastDeliveryError: user?.isAdmin ? codex?.lastError ?? codex?.mailChannelError ?? runtime?.lastDeliveryError ?? null : undefined,
      isolatedOperations: user?.isAdmin ? codex?.holds?.length ?? 0 : undefined,
      memberPaused: Boolean(codex?.lastError || codex?.globalFailureCode || rescueBlocksClaims(state as BridgeState)),
      browserRecovering: codex?.globalFailureCode === "browser_unavailable" && Boolean(codex?.browserUnavailableAt),
      recoveryProgress: publicRecoveryProgress(state as BridgeState,serverNow),
      faultRescue: publicFaultRescue(state as BridgeState),
      officialObservedAt: codex?.observation?.observedAt ?? null,
      officialStale: !codex?.observation?.observedAt || Date.now() - Date.parse(codex.observation.observedAt) > 3 * 60_000,
    },
    setup: !state.config.inventoryVerified
      ? "首次使用需由管理员核对工作空间、登记当前成员并设置员工白名单。"
      : undefined,
  };
}
