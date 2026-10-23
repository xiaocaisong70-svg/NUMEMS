// 把构建产物发布到 Cloudflare Workers，并自动绑定 D1。
// 真正的账号操作需要 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CF_D1_DATABASE_ID。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipBuild = args.has("--skip-build");
const migrate = args.has("--migrate");

const workerName = process.env.CF_WORKER_NAME?.trim() || "numems-seat-portal-trae";
const databaseName =
  process.env.CF_D1_DATABASE_NAME?.trim() || "numems-seat-portal-trae-db";
const databaseId =
  process.env.CF_D1_DATABASE_ID?.trim() ||
  process.env.CLOUDFLARE_D1_DATABASE_ID?.trim() ||
  "";
const publicUrl = process.env.PORTAL_PUBLIC_URL?.trim() || "";
const publicOrigin = process.env.PUBLIC_ORIGIN?.trim() || publicUrl;
const accessTeamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim() || "";
const accessAud = process.env.CF_ACCESS_AUD?.trim() || "";
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";
const microsoftClientId = process.env.MICROSOFT_CLIENT_ID?.trim() || "";
const identityMode = process.env.PORTAL_IDENTITY_MODE?.trim() || "oauth";

const wranglerBin = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const generatedConfig = path.join(root, "dist", "server", "wrangler.json");
const deployConfig = path.join(root, "dist", "server", "wrangler.deploy.json");

function fail(message) {
  console.error(`部署中止：${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`命令退出码 ${result.status}：${command} ${commandArgs.join(" ")}`);
  return result.stdout ?? "";
}

function wrangler(commandArgs, options) {
  return run(process.execPath, [wranglerBin, ...commandArgs], options);
}

function buildConfig() {
  if (!existsSync(generatedConfig))
    fail("未找到 dist/server/wrangler.json，请先运行构建。");
  const config = JSON.parse(readFileSync(generatedConfig, "utf8"));

  config.name = workerName;
  config.main = "index.js";
  config.d1_databases = [
    {
      binding: "DB",
      database_name: databaseName,
      database_id: databaseId || "00000000-0000-4000-8000-000000000000",
    },
  ];
  config.vars = {
    ...(config.vars ?? {}),
    REMINDER_DELIVERY_MODE: process.env.REMINDER_DELIVERY_MODE?.trim() || "relay",
    PORTAL_IDENTITY_MODE: identityMode,
    ...(publicUrl ? { PORTAL_PUBLIC_URL: publicUrl } : {}),
    ...(publicOrigin ? { PUBLIC_ORIGIN: publicOrigin } : {}),
    ...(googleClientId ? { GOOGLE_CLIENT_ID: googleClientId } : {}),
    ...(microsoftClientId ? { MICROSOFT_CLIENT_ID: microsoftClientId } : {}),
    ...(accessTeamDomain ? { CF_ACCESS_TEAM_DOMAIN: accessTeamDomain } : {}),
    ...(accessAud ? { CF_ACCESS_AUD: accessAud } : {}),
  };

  writeFileSync(deployConfig, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function portalStateExists() {
  const output = wrangler(
    [
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--config",
      deployConfig,
      "--json",
      "--command",
      "SELECT name FROM sqlite_master WHERE type='table' AND name='portal_state';",
    ],
    { capture: true },
  );
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end < start) return null;
  try {
    const payload = JSON.parse(output.slice(start, end + 1));
    return payload.some(entry => Array.isArray(entry?.results) && entry.results.length > 0);
  } catch {
    return null;
  }
}

if (!skipBuild) run(process.execPath, [path.join(root, "scripts", "run-framework.mjs"), "build"]);

const config = buildConfig();

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    workerName,
    databaseName,
    databaseIdConfigured: Boolean(databaseId),
    publicUrl: publicUrl || null,
    publicOrigin: publicOrigin || null,
    identityMode,
    accessConfigured: Boolean(accessTeamDomain && accessAud),
    oauthConfigured: Boolean(googleClientId || microsoftClientId),
    configPath: deployConfig,
    vars: config.vars,
    note: "未调用 wrangler deploy，未改动 Cloudflare 账号。",
  }, null, 2));
  process.exit(0);
}

if (!process.env.CLOUDFLARE_API_TOKEN?.trim())
  console.log("未提供 CLOUDFLARE_API_TOKEN，使用 wrangler 当前 OAuth 登录。");
if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim())
  console.warn("提示：未设置 CLOUDFLARE_ACCOUNT_ID，将使用 wrangler 当前账号。");
if (!databaseId)
  fail("缺少 CF_D1_DATABASE_ID（Cloudflare D1 数据库的真实 ID）。");
if (!publicUrl)
  console.warn("提示：未设置 PORTAL_PUBLIC_URL，提醒邮件里的链接会退回原 ChatGPT Sites 地址。");
if (identityMode === "oauth" && !googleClientId && !microsoftClientId)
  console.warn("提示：未设置 GOOGLE_CLIENT_ID / MICROSOFT_CLIENT_ID，登录页会提示未配置。");
if (identityMode === "access" && (!accessTeamDomain || !accessAud))
  console.warn("提示：未设置 CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD，Cloudflare Access 登录将无法识别身份。");

if (migrate) {
  const exists = portalStateExists();
  if (exists === null) {
    console.warn("无法确认 portal_state 是否存在，跳过自动迁移。请手动执行 drizzle/0000_bored_stick.sql。");
  } else if (exists) {
    console.log("portal_state 已存在，跳过数据库迁移。");
  } else {
    console.log("首次部署：正在创建 D1 表结构…");
    wrangler([
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--config",
      deployConfig,
      "--file",
      path.join(root, "drizzle", "0000_bored_stick.sql"),
    ]);
  }
}

wrangler(["deploy", "--config", deployConfig]);

console.log(`\n已部署 Worker：${workerName}`);
console.log("请在 Cloudflare 控制台查看 workers.dev 地址；设置 PORTAL_PUBLIC_URL 后重新部署即可固定提醒链接。");
if (identityMode === "oauth")
  console.log("OAuth 密钥需单独写入：wrangler secret put SESSION_SECRET / GOOGLE_CLIENT_SECRET / MICROSOFT_CLIENT_SECRET。");
