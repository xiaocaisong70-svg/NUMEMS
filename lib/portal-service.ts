import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { createState, transition, viewState, type Actor, type State } from "./seat-engine";

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
  if (row) return { state: JSON.parse(row.document), revision: row.revision };
  const initial = createState(new Date().toISOString());
  await db.prepare("INSERT OR IGNORE INTO portal_state (id,revision,document) VALUES (?,?,?)")
    .bind("main", 0, JSON.stringify(initial)).run();
  const inserted = await db.prepare("SELECT revision,document FROM portal_state WHERE id = ?")
    .bind("main").first<{ revision: number; document: string }>();
  if (!inserted) throw new Error("初始化数据库失败。");
  return { state: JSON.parse(inserted.document), revision: inserted.revision };
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
    const changed = transition(state, actor, normalized as Parameters<typeof transition>[2], now);
    // The same atomic write records the request and any resulting allocation.
    return transition(changed, schedulerActor, { type: "tick" }, now);
  });
}

export async function portalData() {
  const user = await currentActor();
  const { state } = await readState();
  const anonymous: Actor = { userId: "anonymous", email: "", isAdmin: false };
  const view = viewState(state, user ?? anonymous);
  const runtime = (state as State & { runtime?: { lastTickAt?: string; lastDeliveryError?: string } }).runtime;
  return {
    user,
    view,
    connection: {
      memberAdapter: "not_connected",
      scheduler: env.PORTAL_SCHEDULE_ENABLED === "true",
      lastTickAt: runtime?.lastTickAt ?? null,
      mail: Boolean(env.REMINDER_WEBHOOK_URL && env.REMINDER_WEBHOOK_TOKEN),
      lastDeliveryError: user?.isAdmin ? runtime?.lastDeliveryError ?? null : undefined,
    },
    setup: !state.config.inventoryVerified
      ? "首次使用需由管理员核对工作空间、登记当前成员并设置员工白名单。"
      : undefined,
  };
}
