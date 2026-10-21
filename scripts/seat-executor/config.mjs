import path from "node:path";
import { readFile } from "node:fs/promises";

export const root = path.resolve(import.meta.dirname, "../..");
export const runtimeDir = path.join(root, ".sites-runtime", "seat-executor");
export const configPath = path.join(runtimeDir, "config.json");

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("邮箱格式不正确。");
  return email;
}

export function validateConfig(input) {
  const config = {
    siteUrl: "https://numems-seat-portal.workspace-026021.chatgpt.site/",
    workspaceId: "cd01c344-8ff9-41fd-a750-f7b30af9a7c9",
    workspaceName: "My Workspace",
    workspaceSlug: "my-workspace",
    adminEmail: "xiaocaisong70@gmail.com",
    seatLabel: "高级",
    totalSeats: 4,
    reservedSeats: 1,
    browserChannel: "msedge",
    headless: true,
    profile: path.join(runtimeDir, "browser"),
    pollSeconds: 15,
    mailMode: "codex",
    codexCli: "",
    liveActions: false,
    legacyCheckerDisabled: false,
    ...input,
  };
  const site = new URL(config.siteUrl);
  if (site.origin !== "https://numems-seat-portal.workspace-026021.chatgpt.site" ||
      site.pathname !== "/" || site.search || site.hash || site.username || site.password)
    throw new Error("仅允许连接已绑定的原版 Sites 门户。");
  if (config.workspaceId !== "cd01c344-8ff9-41fd-a750-f7b30af9a7c9" ||
      config.adminEmail !== "xiaocaisong70@gmail.com" || config.workspaceName !== "My Workspace" ||
      config.workspaceSlug !== "my-workspace" || config.seatLabel !== "高级" ||
      config.totalSeats !== 4 || config.reservedSeats !== 1)
    throw new Error("工作空间、Owner 或已购席位配置不匹配。");
  if (!["msedge", "chrome", ""].includes(config.browserChannel) ||
      !["codex", "gmail_connector", "relay"].includes(config.mailMode) ||
      !Number.isInteger(config.pollSeconds) || config.pollSeconds < 10 || config.pollSeconds > 300 ||
      typeof config.liveActions !== "boolean" || typeof config.legacyCheckerDisabled !== "boolean" ||
      typeof config.headless !== "boolean" || typeof config.profile !== "string")
    throw new Error("执行器配置无效。");
  if (config.liveActions && config.mailMode === "codex")
    throw new Error("真实执行前须配置无模型 Gmail 连接器或已验收 HTTPS 邮件中继。");
  if (config.liveActions && config.mailMode === "gmail_connector" && !config.codexCli)
    throw new Error("无模型 Gmail 连接器缺少 Codex CLI 路径。");
  config.profile = path.resolve(root, config.profile);
  const profileRelative = path.relative(runtimeDir, config.profile);
  if (!profileRelative || profileRelative === ".." || profileRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(profileRelative))
    throw new Error("浏览器登录档案必须位于执行器专用运行目录内。");
  return Object.freeze(config);
}

export async function loadConfig() {
  let input;
  try { input = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    input = {};
  }
  return validateConfig(input);
}
