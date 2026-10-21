import { readFile, writeFile, rename, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { loadConfig, runtimeDir } from "./config.mjs";
import { BrowserAdapter } from "./browser.mjs";
import { PortalClient } from "./portal-client.mjs";
import { GmailConnectorMailer } from "./gmail-mailer.mjs";
import { processOnce } from "./core.mjs";
import { sendFatalAlert, markExecutorHealthy } from "./alert.mjs";

const lockPath = path.join(runtimeDir, "worker.lock");
const statusPath = path.join(runtimeDir, "status.json");
const legacyStatusPath = path.join(runtimeDir, "..", "queue-checker", "status.json");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const EXECUTOR_SCHEDULE_ID = "local:seat-executor:NUMEMS-Seat-Queue";
const unhealthyResults = new Set(["dry_run", "mail_uncertain", "mail_channel_required"]);

export async function registerLiveSchedule({ config, portal, browser, result, registered = false }) {
  if (registered || !config.liveActions || unhealthyResults.has(result.mode)) return registered;
  // A portal-only idle cycle does not prove the administrator's official
  // browser login is still valid. Verify a fresh complete inventory once.
  await browser.observe();
  // Only after the old checker safety gate, a successful authenticated portal
  // cycle and a valid official workspace view may the UI show us online.
  await portal.call("record_codex_schedule", { scheduleId: EXECUTOR_SCHEDULE_ID });
  return true;
}

async function saveStatus(status) {
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(status, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, statusPath);
}

export async function assertLegacyInactive(config, now = Date.now()) {
  if (!config.liveActions) return;
  if (!config.legacyCheckerDisabled)
    throw new Error("旧队列检查任务未确认停止。");
  try {
    const status = JSON.parse(await readFile(legacyStatusPath, "utf8"));
    if (!Number.isFinite(Date.parse(status.checkedAt)) ||
        now - Date.parse(status.checkedAt) < 180_000)
      throw new Error("旧队列检查任务最近仍在运行，拒绝并行执行。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function acquireLock() {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return async () => { await handle.close(); await unlink(lockPath); };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error("已有执行器实例或遗留锁；需先核对进程，禁止并行运行。");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const config = await loadConfig();
  await mkdir(runtimeDir, { recursive: true });
  const release = await acquireLock();
  const browser = new BrowserAdapter(config);
  try {
    await browser.open();
    const portal = new PortalClient(browser.context, config);
    const mailer = config.mailMode === "gmail_connector" ? new GmailConnectorMailer(config) : null;
    let scheduleRegistered = false;
    do {
      await assertLegacyInactive(config);
      const result = await processOnce({ portal, browser, mailer, config });
      scheduleRegistered = await registerLiveSchedule({ config, portal, browser, result,
        registered: scheduleRegistered });
      await saveStatus({ checkedAt: new Date().toISOString(), state: result.mode,
        modelCalls: 0, liveActions: config.liveActions, pending: result.pending });
      if (config.liveActions && !unhealthyResults.has(result.mode)) await markExecutorHealthy();
      if (process.argv.includes("--once")) break;
      await sleep(config.pollSeconds * 1000);
    } while (true);
  } catch (error) {
    const status = { checkedAt: new Date().toISOString(), state: "blocked",
      modelCalls: 0, liveActions: config.liveActions,
      error: error instanceof Error ? error.message : "未知执行错误" };
    await saveStatus(status).catch(() => {});
    if (config.liveActions) {
      let alert;
      try { alert = await sendFatalAlert({ config }); }
      catch { alert = { state: "alert_storage_error" }; }
      await saveStatus({ ...status, alert: alert.state, alertId: alert.id }).catch(() => {});
    }
    console.error(`NUMEMS deterministic executor stopped: ${status.error}`);
    process.exitCode = 1;
  } finally {
    try { await browser.close(); }
    finally { await release(); }
  }
}
