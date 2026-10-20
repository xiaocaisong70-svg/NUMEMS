import { createState, viewState, PROTECTED_OWNER_EMAIL, type State } from "../lib/seat-engine";
export type DemoMode = "queue" | "invite" | "timeout" | "active";
export const demoUser = { userId: "demo", email: "lin@example.com", displayName: "林知远", isAdmin: false };
export const demoScheduler = { userId: "demo-scheduler", email: PROTECTED_OWNER_EMAIL, isAdmin: true };
export function renderDemo(state: State, now = new Date().toISOString()) {
  return { access: "allowed" as const, user: demoUser, demoState: state, view: viewState(state, demoUser, now) };
}
export function makeDemo(mode: DemoMode = "queue") {
  const now = new Date().toISOString(), instant = Date.parse(now);
  const s = createState(now);
  Object.assign(s.config, { workspaceId: "browser-demo", inventoryVerified: true, automationEnabled: true,
    whitelist: ["lin@example.com", "chen@example.com", "zhou@example.com", "li@example.com", "wu@example.com"] });
  const emails = ["chen@example.com", "zhou@example.com", "li@example.com"];
  s.requests = emails.map((email, i) => ({ id: `DEMO_OTHER_${i}`, userId: `other-${i}`, email,
    name: email.split("@")[0], reason: "演示中的工作申请", hours: i + 1, status: "active",
    createdAt: now, updatedAt: now, expiresAt: new Date(instant + (i + 1) * 3_600_000).toISOString() }));
  const invitedAt = new Date(instant - (mode === "timeout" ? 298_000 : 0)).toISOString();
  if (mode !== "queue") s.requests.pop();
  s.requests.push({ id: "DEMO_MINE", userId: demoUser.userId, email: demoUser.email,
    name: demoUser.displayName, reason: "整理产品调研资料与分析报告", hours: 1,
    status: mode === "queue" ? "queued" : mode === "active" ? "active" : "invited",
    createdAt: now, updatedAt: now,
    ...(mode === "active" ? { expiresAt: new Date(instant + 3_600_000).toISOString() } : {}),
    ...(["invite", "timeout"].includes(mode) ? { invitedAt, joinDeadlineAt: new Date(Date.parse(invitedAt) + 300_000).toISOString() } : {}) });
  s.requests.push({ id: "DEMO_NEXT", userId: "next", email: "wu@example.com", name: "吴同事",
    reason: "下一位排队员工", hours: 1, status: "queued", createdAt: new Date(instant + 1).toISOString(), updatedAt: now });
  return renderDemo(s, now);
}
