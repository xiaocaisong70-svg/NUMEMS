import type { Actor, Config } from "./seat-engine";

export type PortalAccess = "allowed" | "signin_required" | "not_authorized" | "unavailable";

// Portal eligibility is independent of a paid Business seat or an invitation.
// The caller supplies an identity verified by Sites, never an email from a form.
export function portalAccess(
  config: Pick<Config, "whitelist">,
  actor: Actor | null,
): PortalAccess {
  if (!actor?.userId || !actor.email.trim()) return "signin_required";
  if (actor.isAdmin) return "allowed";
  const email = actor.email.trim().toLowerCase();
  return config.whitelist.some(value => value.trim().toLowerCase() === email)
    ? "allowed" : "not_authorized";
}

export class PortalAccessError extends Error {
  readonly status: number;
  readonly access: PortalAccess;
  constructor(access: "signin_required" | "not_authorized") {
    super(access === "signin_required" ? "请先使用本人 ChatGPT 账号登录。" : "此登录邮箱尚未获得门户访问权限，请联系管理员。");
    this.name = "PortalAccessError";
    this.access = access;
    this.status = access === "signin_required" ? 401 : 403;
  }
}

export function requirePortalAccess(config: Pick<Config, "whitelist">, actor: Actor | null) {
  const access = portalAccess(config, actor);
  if (access === "signin_required" || access === "not_authorized")
    throw new PortalAccessError(access);
}
