// 登录态保活：以无头浏览器定期访问门户与官方管理后台，避免会话因长期闲置而过期。
// 全程只读，不发起任何成员变更；与执行器共用同一浏览器档案，靠档案占用检测自动互斥。
import { chromium } from "playwright";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadConfig, runtimeDir, root, ADMIN_EMAIL } from "./config.mjs";
import { officialTools } from "./official-members.mjs";

const execFileAsync = promisify(execFile);
const EDGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const statusPath = path.join(runtimeDir, "keepalive-status.json");

async function save(data) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, statusPath);
}

// 档案同一时间只能被一个浏览器进程占用：执行器正在运行时直接跳过本轮，避免互相干扰。
async function profileBusy(profile) {
  if (process.platform !== "win32") return false;
  const needle = path.relative(root, profile).split(path.sep).join("\\");
  if (!needle) return false;
  const command = "$ErrorActionPreference='SilentlyContinue'; " +
    "$p=@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*" + needle + "*' }); " +
    "[Console]::Out.WriteLine($p.Count)";
  const { stdout } = await execFileAsync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 });
  return Number(stdout.trim()) > 0;
}

const config = await loadConfig();
const report = {
  checkedAt: new Date().toISOString(),
  mode: "session_keepalive",
  state: "unknown",
};

if (await profileBusy(config.profile)) {
  report.state = "skipped";
  report.reason = "profile_busy";
  await save(report);
  process.exit(0);
}

let exitCode = 0;
let context;
try {
  context = await chromium.launchPersistentContext(config.profile, {
    channel: config.browserChannel || undefined,
    headless: config.headless,
    viewport: { width: 1440, height: 960 },
    locale: "zh-CN",
    ...(config.headless ? { userAgent: EDGE_USER_AGENT } : {}),
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
      "--disable-blink-features=AutomationControlled"],
  });

  // 1）门户会话：确认管理员身份仍然有效。
  const portal = context.pages()[0] ?? (await context.newPage());
  portal.setDefaultTimeout(20_000);
  await portal.goto(config.siteUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const identity = await portal.evaluate(async () => {
    const response = await fetch("/api/portal", { cache: "no-store", credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  });
  const portalOk = identity.status === 200 && identity.body?.access === "allowed" &&
    identity.body?.user?.email?.toLowerCase() === ADMIN_EMAIL;

  // 2）官方后台会话：只读访问成员页与容量接口，让 OpenAI 侧登录保持活跃。
  const admin = await context.newPage();
  admin.setDefaultTimeout(20_000);
  await admin.goto(`https://admin.openai.com/workspace/${config.workspaceId}/members?workspace=my-workspace`,
    { waitUntil: "domcontentloaded", timeout: 45_000 });
  await admin.waitForTimeout(2500);
  const tools = officialTools(admin, config.workspaceId);
  const capacity = await tools.api(`/api/workspaces/${config.workspaceId}/billing/premium-seat-capacity`);
  const officialOk = capacity.status === 200;

  report.portal = portalOk ? "allowed" : `denied_${identity.status}`;
  report.official = officialOk ? "signed_in" : `expired_${capacity.status}`;
  report.seats = capacity.body?.billing?.subscription?.seats_entitled ?? null;
  report.state = portalOk && officialOk ? "alive" : "expired";
  if (!portalOk || !officialOk) exitCode = 3;
} catch (error) {
  report.state = "error";
  report.error = String(error.message).slice(0, 300);
  exitCode = 1;
} finally {
  await context?.close();
}

await save(report);
if (exitCode !== 0) console.error(`登录态保活：${report.state} ${report.error ?? ""}`.trim());
process.exit(exitCode);
