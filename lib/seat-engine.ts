export const PROTECTED_OWNER_EMAIL = "xiaocaisong70@gmail.com";
export const AUTHORIZED_TEST_EMAIL = "hit_wangning@outlook.com";
export type Actor = { userId: string; email: string; isAdmin: boolean };
export type RequestStatus = "queued" | "pending_invite" | "invited" | "active" | "pending_removal" | "completed" | "cancelled";
export type Config = {
  totalSeats: number; reservedSeats: number; leaseHours: number; reminderMinutes: number; acceptHours: number;
  automationEnabled: boolean; workspaceId: string; whitelist: string[];
  inventoryVerified: boolean; existingEmails: string[]; protectedEmails: string[];
};
export type RequestRecord = {
  id: string; userId: string; email: string; name: string; reason: string; hours: number;
  status: RequestStatus; createdAt: string; updatedAt: string; expiresAt?: string | null;
  invitedAt?: string; operationId?: string; error?: string; requestKey?: string; lastRenewalKey?: string; isTest?: boolean;
};
export type Notice = {
  id: string; key: string; requestId: string; userId: string; email: string; type: string;
  title: string; message: string; createdAt: string; status: "pending" | "sent" | "cancelled"; sentAt?: string;
};
export type AuditRecord = { id: string; at: string; actor: string; action: string; requestId?: string };
export type State = { config: Config; requests: RequestRecord[]; audit: AuditRecord[]; notices: Notice[]; revision: number };
export type Command =
  | { type: "apply"; reason: string; name: string; hours: number; requestKey?: string }
  | { type: "renew"; id: string; hours: number; requestKey?: string }
  | { type: "cancel" | "release" | "confirm_invited" | "confirm_active" | "confirm_removed"; id: string }
  | { type: "configure"; config: Partial<Config> }
  | { type: "tick" }
  | { type: "sync_inventory"; members: { email: string; role: string }[] };
const HOUR = 3600000;
const OCCUPYING = new Set<RequestStatus>(["pending_invite", "invited", "active", "pending_removal"]);
const CLOSED = new Set<RequestStatus>(["completed", "cancelled"]);
function email(value: unknown): string {
  if (typeof value !== "string") throw new Error("邮箱格式不正确。");
  const result = value.trim().toLowerCase();
  if (result.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new Error("邮箱格式不正确。");
  return result;
}
function timestamp(now: string | Date): string {
  const value = new Date(now).getTime();
  if (!Number.isFinite(value)) throw new Error("时间格式不正确。");
  return new Date(value).toISOString();
}
function field(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label}需填写 1 至 ${max} 个字符。`);
  return value.trim();
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 至 ${max} 的整数。`);
  return value;
}
function actorIdentity(actor: Actor, anonymous = false): Actor {
  if (!actor || typeof actor.isAdmin !== "boolean") throw new Error("身份无效。");
  return { userId: field(actor.userId, "用户标识", 200), email: anonymous && !actor.email ? "" : email(actor.email), isAdmin: actor.isAdmin };
}
function belongsTo(item: { userId: string; email: string }, actor: Actor) {
  // Admin-created test records precede this employee's first portal sign-in.
  const authorizedTest = item.email === AUTHORIZED_TEST_EMAIL && item.userId === `test:${AUTHORIZED_TEST_EMAIL}`;
  return Boolean(actor.email) && item.email === actor.email &&
    (item.userId === actor.userId || item.userId === `inventory:${item.email}` || authorizedTest);
}
function used(state: State) { return state.config.reservedSeats + state.requests.filter(r => OCCUPYING.has(r.status)).length; }
export function createState(now: string | Date): State {
  timestamp(now);
  return { config: { totalSeats: 4, reservedSeats: 1, leaseHours: 3, reminderMinutes: 30, acceptHours: 24, automationEnabled: false, workspaceId: "", whitelist: [], inventoryVerified: false, existingEmails: [], protectedEmails: [PROTECTED_OWNER_EMAIL] }, requests: [], audit: [], notices: [], revision: 0 };
}
/** Upgrade JSON records without silently truncating already accepted leases. */
export function upgradeState(value: State): State {
  const next = structuredClone(value) as State & { schemaVersion?: number };
  const config = next.config as Config & { leaseDays?: number };
  config.leaseHours = Math.min(3, Math.max(1, config.leaseHours ?? 3));
  config.reminderMinutes = 30;
  config.protectedEmails ??= [PROTECTED_OWNER_EMAIL];
  delete config.leaseDays;
  for (const record of next.requests) {
    const legacy = record as RequestRecord & { days?: number };
    legacy.hours = legacy.hours ?? (legacy.days === 0 ? 0 : Math.min(3, (legacy.days ?? 1) * 24));
    delete legacy.days;
  }
  next.schemaVersion = 2;
  return next;
}
/** The actor must come from a trusted server session, never the request body. */
export function transition(state: State, rawActor: Actor, command: Command, now: string | Date): State {
  const actor = actorIdentity(rawActor);
  const at = timestamp(now), instant = Date.parse(at);
  const next: State = upgradeState(state);
  const protectedEmails = () => [...new Set([PROTECTED_OWNER_EMAIL, ...(next.config.protectedEmails ?? [])])];
  const isProtected = (value: string) => protectedEmails().includes(value);
  let changed = false, sequence = 0;
  const id = (kind: string) => `${kind}_${instant.toString(36)}_${state.revision + 1}_${++sequence}`;
  const admin = () => { if (!actor.isAdmin) throw new Error("此操作需要管理员权限。"); };
  const audit = (action: string, requestId?: string) => {
    changed = true;
    next.audit.push({ id: id("audit"), at, actor: actor.email, action, ...(requestId ? { requestId } : {}) });
    next.audit = next.audit.slice(-1000);
  };
  const notice = (r: RequestRecord, type: string, title: string, message: string) => {
    const cycle = r.expiresAt ?? r.invitedAt ?? r.createdAt;
    const key = `${r.id}:${type}:${cycle}`;
    if (next.notices.some(n => n.key === key)) return;
    next.notices.push({ id: id("notice"), key, requestId: r.id, userId: r.userId, email: r.email, type, title, message, createdAt: at, status: "pending" });
    changed = true;
  };
  const update = (r: RequestRecord, status: RequestStatus, action: string) => {
    r.status = status; r.updatedAt = at; delete r.error; audit(action, r.id);
  };
  const get = (requestId: string, adminOnly = false) => {
    if (adminOnly) admin();
    const r = next.requests.find(item => item.id === requestId);
    if (!r || (!actor.isAdmin && !belongsTo(r, actor))) throw new Error("未找到可操作的申请。");
    if (isProtected(r.email) || (actor.isAdmin && r.email === actor.email)) throw new Error("管理员保留账号受保护，不能参与席位回收。");
    return r;
  };
  const remove = (r: RequestRecord, action: string, type: string, message: string) => {
    update(r, "pending_removal", action); r.operationId = id("remove");
    for (const item of next.notices)
      if (item.requestId === r.id && item.type === "expiry_30m" && item.status === "pending") item.status = "cancelled";
    notice(r, type, "席位等待回收确认", message);
  };
  if (!command || typeof command.type !== "string") throw new Error("操作类型无效。");
  switch (command.type) {
    case "apply": {
      if (actor.isAdmin || isProtected(actor.email)) throw new Error("管理员使用保留席位，无需申请。");
      if (!next.config.whitelist.includes(actor.email)) throw new Error("此邮箱不在已授权员工名单中。");
      if (command.requestKey && next.requests.some(r => belongsTo(r, actor) && r.requestKey === command.requestKey)) break;
      if (next.requests.some(r => !CLOSED.has(r.status) && (r.email === actor.email || r.userId === actor.userId))) throw new Error("你已有未结束的申请或席位，请勿重复申请。");
      const r: RequestRecord = { id: id("req"), userId: actor.userId, email: actor.email, name: field(command.name, "姓名", 80), reason: field(command.reason, "用途", 1000), hours: integer(command.hours, "申请小时数", 1, next.config.leaseHours), status: "queued", createdAt: at, updatedAt: at, ...(command.requestKey ? { requestKey: field(command.requestKey, "请求标识", 100) } : {}) };
      next.requests.push(r); audit("apply", r.id);
      notice(r, "queued", "申请已进入队列", "将按提交先后分配可用席位。实际可用时间以工作空间加入确认结果为准。");
      break;
    }
    case "configure": {
      admin();
      if (!command.config || typeof command.config !== "object" || Array.isArray(command.config)) throw new Error("设置格式无效。");
      const allowed = new Set(["totalSeats", "reservedSeats", "leaseHours", "acceptHours", "automationEnabled", "workspaceId", "whitelist"]);
      if (Object.keys(command.config).some(k => !allowed.has(k))) throw new Error("盘点状态只能通过首次成员盘点更新。");
      const c = { ...next.config, ...command.config };
      integer(c.totalSeats, "总席位", 2, 10000); integer(c.reservedSeats, "保留席位", protectedEmails().length, c.totalSeats);
      integer(c.leaseHours, "单次最大小时数", 1, 3); integer(c.acceptHours, "邀请有效小时数", 1, 168);
      if (typeof c.automationEnabled !== "boolean" || typeof c.workspaceId !== "string" || c.workspaceId.length > 200 || !Array.isArray(c.whitelist) || c.whitelist.length > 1000) throw new Error("设置格式无效。");
      c.workspaceId = c.workspaceId.trim(); c.whitelist = [...new Set(c.whitelist.map(email))].filter(e => !isProtected(e));
      const occupied = next.requests.filter(r => OCCUPYING.has(r.status)).length;
      if (c.totalSeats < c.reservedSeats + occupied) throw new Error("总席位不能少于已占用和保留的席位。");
      if (c.workspaceId !== next.config.workspaceId && (next.config.inventoryVerified || occupied)) throw new Error("已盘点或有占用时不能更换工作空间。");
      if (JSON.stringify(c) !== JSON.stringify(next.config)) { next.config = c; audit("configure"); }
      break;
    }
    case "cancel": {
      const r = get(command.id); if (r.status === "cancelled") break;
      if (r.status !== "queued") throw new Error("仅排队中的申请可取消；已分配的席位请提交释放。");
      update(r, "cancelled", "cancel"); notice(r, "cancelled", "申请已取消", "你的排队申请已取消。"); break;
    }
    case "release": {
      const r = get(command.id); if (r.status === "pending_removal" || r.status === "completed") break;
      if (!OCCUPYING.has(r.status)) throw new Error("该申请目前没有可释放的席位。");
      remove(r, "release", "removal_required", "已收到释放请求。实际移除确认后才会释放席位。"); break;
    }
    case "renew": {
      const r = get(command.id);
      if (command.requestKey && r.lastRenewalKey === command.requestKey) break;
      if (r.status !== "active" || !r.expiresAt) throw new Error("只有正在使用且有到期时间的席位可以续期。");
      if (Date.parse(r.expiresAt) <= instant) throw new Error("租期已结束，请等待回收后重新申请。");
      if (next.requests.some(item => item.status === "queued" && item.id !== r.id)) throw new Error("已有同事排队，租期结束后请重新申请。");
      const hours = integer(command.hours, "续期小时数", 1, next.config.leaseHours);
      const expiry = new Date(instant + hours * HOUR).toISOString();
      if (Date.parse(expiry) <= Date.parse(r.expiresAt)) throw new Error("请选择比当前剩余时间更长的时长；续期从现在起计算，最多 3 小时。");
      for (const item of next.notices) if (item.requestId === r.id && item.type === "expiry_30m" && item.status === "pending") item.status = "cancelled";
      r.expiresAt = expiry; r.updatedAt = at; audit("renew", r.id);
      r.lastRenewalKey = command.requestKey ? field(command.requestKey, "请求标识", 100) : undefined;
      notice(r, "renewed", "席位租期已延长", `新的到期时间：${expiry}。`); break;
    }
    case "sync_inventory": {
      admin();
      if (next.config.inventoryVerified) throw new Error("首次成员盘点已完成，后续变化须通过明确的操作回执确认。");
      if (!next.config.workspaceId) throw new Error("请先设置目标工作空间标识。");
      if (!Array.isArray(command.members) || command.members.length > 10000) throw new Error("成员快照无效。");
      const members = command.members.map(m => ({ email: email(m.email), role: field(m.role, "成员角色", 50).toLowerCase() }));
      const protectedSnapshot = new Set([PROTECTED_OWNER_EMAIL, ...members.filter(m => m.role === "owner").map(m => m.email)]);
      if (protectedSnapshot.size > next.config.reservedSeats) throw new Error("保留席位少于快照中的 Owner 数量，请先调整设置。");
      if (next.requests.some(r => protectedSnapshot.has(r.email) && !CLOSED.has(r.status))) throw new Error("Owner 账号已有未结束申请，请先取消申请再盘点。");
      const emails = [...new Set(members.filter(m => !protectedSnapshot.has(m.email)).map(m => m.email))];
      for (const value of emails) {
        const existing = next.requests.find(r => r.email === value && !CLOSED.has(r.status));
        if (existing?.status === "queued") throw new Error(`成员 ${value} 已在工作空间中，请先取消其排队申请再盘点。`);
        if (existing) continue;
        const r: RequestRecord = { id: id("req"), userId: `inventory:${value}`, email: value, name: value.split("@")[0], reason: "首次盘点导入的现有成员或待接受邀请，未设置自动到期。", hours: 0, status: "active", createdAt: at, updatedAt: at, expiresAt: null };
        next.requests.push(r); audit("inventory_import", r.id);
      }
      next.config.protectedEmails = [...protectedSnapshot];
      next.config.whitelist = next.config.whitelist.filter(value => !protectedSnapshot.has(value));
      next.config.existingEmails = emails; next.config.inventoryVerified = true;
      if (used(next) > next.config.totalSeats) next.config.automationEnabled = false;
      audit("sync_inventory"); break;
    }
    case "confirm_invited": {
      const r = get(command.id, true); if (r.status === "invited" || r.status === "active") break;
      if (r.status !== "pending_invite") throw new Error("该申请不在待邀请状态，不能确认邀请。");
      update(r, "invited", "confirm_invited"); r.invitedAt = at;
      notice(r, "invited", "工作空间邀请已发送", `请在 ${next.config.acceptHours} 小时内接受邀请。接受结果核实后开始计算租期。`); break;
    }
    case "confirm_active": {
      const r = get(command.id, true); if (r.status === "active") break;
      if (r.status !== "invited") throw new Error("该申请不在待接受邀请状态，不能确认加入。");
      if (r.invitedAt && Date.parse(r.invitedAt) + next.config.acceptHours * HOUR <= instant) throw new Error("邀请预留已到期，请先核实并回收。");
      update(r, "active", "confirm_active"); r.expiresAt = new Date(instant + r.hours * HOUR).toISOString();
      notice(r, "active", "席位已开始使用", `已确认加入工作空间，到期时间：${r.expiresAt}。`); break;
    }
    case "confirm_removed": {
      const r = get(command.id, true); if (r.status === "completed") break;
      if (r.status !== "pending_removal") throw new Error("该申请不在待回收状态，不能确认移除。");
      update(r, "completed", "confirm_removed"); notice(r, "completed", "席位已回收", "已确认移除工作空间访问。需要时可重新申请。"); break;
    }
    case "tick": {
      admin();
      for (const r of next.requests) {
        if (isProtected(r.email) || r.email === actor.email) continue;
        if (r.status === "invited" && r.invitedAt && Date.parse(r.invitedAt) + next.config.acceptHours * HOUR <= instant) remove(r, "invitation_expired", "invitation_expired", "邀请期限已过，正在等待撤销邀请或成员移除确认。确认前不会释放预留席位。");
        if (r.status !== "active" || !r.expiresAt) continue;
        const remaining = Date.parse(r.expiresAt) - instant;
        if (remaining <= 0) remove(r, "lease_expired", "expired", "租期已到期，正在等待实际移除确认。");
        else if (remaining <= next.config.reminderMinutes * 60_000) notice(r, "expiry_30m", "ChatGPT 席位将在 30 分钟内到期", `你的 ChatGPT Business 席位即将到期。截止时间（UTC）：${r.expiresAt}。如需继续使用，请在到期前打开席位申请中心续期：https://numems-seat-portal.workspace-026021.chatgpt.site/ 。如已续期，请以网页当前截止时间为准。网页按本地时区显示；有同事排队时需重新申请。`);
      }
      if (next.config.inventoryVerified && next.config.workspaceId && next.config.automationEnabled) {
        let available = Math.max(0, next.config.totalSeats - used(next));
        const queue = next.requests.filter(r => r.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const r of queue) {
          if (!available) break;
          if (isProtected(r.email) || !next.config.whitelist.includes(r.email)) continue;
          update(r, "pending_invite", "reserve_seat"); r.operationId = id("invite");
          notice(r, "invite_required", "已为你预留席位", "已轮到你的申请，正在等待真实工作空间邀请。接受邀请后方可使用。"); available -= 1;
        }
      }
      break;
    }
    default: throw new Error("不支持的操作类型。");
  }
  if (changed) next.revision = state.revision + 1;
  return next;
}
export function viewState(state: State, rawActor: Actor) {
  const actor = actorIdentity(rawActor, true), snapshot: State = upgradeState(state);
  const queue = snapshot.requests.filter(r => r.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const occupied = used(snapshot);
  const aggregate = { totalSeats: snapshot.config.totalSeats, reservedSeats: snapshot.config.reservedSeats, usedSeats: occupied, availableSeats: Math.max(0, snapshot.config.totalSeats - occupied), overCapacity: Math.max(0, occupied - snapshot.config.totalSeats), queued: queue.length, active: snapshot.requests.filter(r => r.status === "active").length, pendingInvites: snapshot.requests.filter(r => ["pending_invite", "invited"].includes(r.status)).length, pendingRemovals: snapshot.requests.filter(r => r.status === "pending_removal").length, inventoryVerified: snapshot.config.inventoryVerified };
  if (actor.isAdmin) return { ...snapshot, aggregate, queuePosition: null as number | null };
  const mine = (item: { userId: string; email: string }) => belongsTo(item, actor);
  const position = queue.findIndex(mine);
  const { totalSeats, reservedSeats, leaseHours, reminderMinutes, acceptHours, automationEnabled, inventoryVerified } = snapshot.config;
  return { config: { totalSeats, reservedSeats, leaseHours, reminderMinutes, acceptHours, automationEnabled, inventoryVerified }, requests: snapshot.requests.filter(mine), notices: snapshot.notices.filter(mine), revision: snapshot.revision, aggregate, queuePosition: position < 0 ? null : position + 1, eligible: snapshot.config.whitelist.includes(actor.email) && ![PROTECTED_OWNER_EMAIL, ...(snapshot.config.protectedEmails ?? [])].includes(actor.email) };
}


