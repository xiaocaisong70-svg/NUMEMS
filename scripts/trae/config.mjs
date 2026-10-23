import path from "node:path";
import { readFile } from "node:fs/promises";

export const root = path.resolve(import.meta.dirname, "../..");
export const runtimeDir = path.join(root, ".sites-runtime", "trae-executor");
export const configPath = path.join(runtimeDir, "config.json");

export const SITE_URL =
  process.env.PORTAL_SITE_URL?.trim() ||
  "https://numems-seat-portal-trae.numems.workers.dev/";
export const ADMIN_EMAIL = "xiaocaisong70@gmail.com";
export const WORKSPACE_ID = "cd01c344-8ff9-41fd-a750-f7b30af9a7c9";

export function validateConfig(input = {}) {
  const config = {
    siteUrl: SITE_URL,
    adminEmail: ADMIN_EMAIL,
    workspaceId: WORKSPACE_ID,
    browserChannel: "msedge",
    headless: false,
    profile: path.join(runtimeDir, "browser"),
    // Must only be set after the legacy Windows task is verified disabled.
    legacyCheckerDisabled: false,
    ...input,
  };
  const site = new URL(config.siteUrl);
  if (site.origin !== new URL(SITE_URL).origin || site.pathname !== "/" ||
      site.search || site.hash || site.username || site.password)
    throw new Error("只允许连接已绑定的 NUMEMS 门户站点。");
  if (config.adminEmail !== ADMIN_EMAIL || config.workspaceId !== WORKSPACE_ID)
    throw new Error("管理员邮箱或工作空间标识不匹配。");
  if (!["msedge", "chrome", ""].includes(config.browserChannel) ||
      typeof config.headless !== "boolean" || typeof config.profile !== "string" ||
      typeof config.legacyCheckerDisabled !== "boolean")
    throw new Error("浏览器配置无效。");
  config.profile = path.resolve(root, config.profile);
  const relative = path.relative(runtimeDir, config.profile);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("浏览器登录档案必须位于 TRAE 执行器专用运行目录内。");
  return Object.freeze(config);
}

export async function loadConfig() {
  let input = {};
  try {
    input = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return validateConfig(input);
}
