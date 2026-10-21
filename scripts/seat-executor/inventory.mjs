import { normalizeEmail } from "./config.mjs";

export function validateObservation(s, config, now = Date.now()) {
  if (!s || s.complete !== true || s.workspaceId !== config.workspaceId ||
      s.workspaceName !== config.workspaceName || s.accountEmail !== config.adminEmail ||
      s.totalSeats !== config.totalSeats || s.seatLabel !== config.seatLabel ||
      !Number.isFinite(Date.parse(s.observedAt)) ||
      now - Date.parse(s.observedAt) > 60_000 || Date.parse(s.observedAt) - now > 5000)
    throw new Error("官方快照的身份、工作空间、席位数量或时效未通过核对。");
  const page = new URL(s.pageUrl);
  if (page.origin !== "https://admin.openai.com" ||
      page.pathname !== `/workspace/${config.workspaceId}/members`)
    throw new Error("官方快照来源不正确。");
  if (!Array.isArray(s.members) || !Array.isArray(s.invites))
    throw new Error("成员或邀请清单不完整。");
  const seen = new Set();
  for (const p of [...s.members, ...s.invites]) {
    if (normalizeEmail(p.email) !== p.email || seen.has(p.email) ||
        !["owner", "admin", "member"].includes(p.role) || p.seatLabel !== config.seatLabel)
      throw new Error("成员重复、角色未知或席位类型异常。");
    seen.add(p.email);
  }
  if (s.members.find(p => p.email === config.adminEmail)?.role !== "owner" ||
      seen.size > config.totalSeats ||
      s.invites.some(p => p.role !== "member"))
    throw new Error("Owner、容量或邀请角色异常。");
  return s;
}

export function presence(snapshot, email) {
  const target = normalizeEmail(email);
  return snapshot.members.some(p => p.email === target) ? "member" :
    snapshot.invites.some(p => p.email === target) ? "invite" : "absent";
}

export function assertOrdinary(snapshot, email, state) {
  const target = normalizeEmail(email);
  if (state.config.protectedEmails.some(value => normalizeEmail(value) === target))
    throw new Error("禁止处理受保护账号。");
  const p = [...snapshot.members, ...snapshot.invites].find(p => p.email === target);
  if (p && p.role !== "member") throw new Error("目标已变为 Owner 或管理员。");
}

export function bridgeObservation(s) {
  return {
    workspaceId: s.workspaceId, accountEmail: s.accountEmail, pageUrl: s.pageUrl,
    observedAt: s.observedAt, complete: true, totalSeats: s.totalSeats,
    members: s.members.map(({ email, role }) => ({ email, role })),
    invites: s.invites.map(({ email, role }) => ({ email, role })),
  };
}
