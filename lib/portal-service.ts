import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { createState, upgradeState, transition, viewState, type Actor, type State } from "./seat-engine";
import type { BridgeState } from "./codex-bridge";
import { portalAccess, requirePortalAccess } from "./portal-access";

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
  if (row) return { state: upgradeState(JSON.parse(row.document)), revision: row.revision };
  const initial = createState(new Date().toISOString());
  await db.prepare("INSERT OR IGNORE INTO portal_state (id,revision,document) VALUES (?,?,?)")
    .bind("main", 0, JSON.stringify(initial)).run();
  const inserted = await db.prepare("SELECT revision,document FROM portal_state WHERE id = ?")
    .bind("main").first<{ revision: number; document: string }>();
  if (!inserted) throw new Error("初始化数据库失败。");
  return { state: upgradeState(JSON.parse(inserted.document)), revision: inserted.revision };
}

// Retrying pure transforms is safe. No email or member mutation belongs here.
export async function mutateState(change: (state: State) => State): Promise<State> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const old = await readState();
    const next = change(structuredClone(old.state));
    if (JSON.stringify(next) === JSON.stringify(old.state)) return next;
    const result = await database().prepare(
      "UPDATE portal_state SET document=?, revision=revision+1 WHERE id=? AND revision=?"
    ).bind(JSON.stringify(next), "main", old.revision).run();
    if (result.meta.changes === 1) return next;
  }
  throw new Error("当前申请较多，请稍后重试。");
}

export async function runCommand(actor: Actor, command: Record<string, unknown>) {
  const now = new Date().toISOString();
  const normalized = { ...command, id: command.id ?? command.requestId };
  return mutateState(state => {
    // Recheck the latest whitelist in the same transaction as every mutation.
    requirePortalAccess(state.config, actor);
    const changed = transition(state, actor, normalized as Parameters<typeof transition>[2], now);
    // The same atomic write records the request and any resulting allocation.
    return transition(changed, schedulerActor, { type: "tick" }, now);
  });
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
      mail: Boolean(codex?.mailVerifiedAt || (env.REMINDER_WEBHOOK_URL && env.REMINDER_WEBHOOK_TOKEN)),
      lastDeliveryError: user?.isAdmin ? codex?.lastError ?? codex?.mailChannelError ?? runtime?.lastDeliveryError ?? null : undefined,
      isolatedOperations: user?.isAdmin ? codex?.holds?.length ?? 0 : undefined,
    },
    setup: !state.config.inventoryVerified
      ? "首次使用需由管理员核对工作空间、登记当前成员并设置员工白名单。"
      : undefined,
  };
}
