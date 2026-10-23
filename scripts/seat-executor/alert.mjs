import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { AppServerClient } from "../app-server-client.mjs";
import { root, runtimeDir } from "./config.mjs";

const defaultAlertPath = path.join(runtimeDir, "alert.json");
const defaultCheckerConfigPath = path.join(root, ".sites-runtime", "queue-checker", "config.json");
const cleanEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^(CODEX|OPENAI|MCP|CXX|RUST)/i.test(name) &&
    !/(?:PASSWORD|PASS|SECRET|TOKEN|API_KEY)/i.test(name)));

async function readJson(file) {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function destination(config, checkerConfigPath, projectRoot) {
  const checker = config.alertCli && config.alertThreadId ? null : await readJson(checkerConfigPath);
  const validChecker = checker?.projectPath && path.resolve(checker.projectPath) === path.resolve(projectRoot);
  const cli = config.alertCli || (validChecker && checker.cli);
  const threadId = config.alertThreadId || (validChecker && checker.threadId);
  if (typeof cli !== "string" || !path.isAbsolute(cli) ||
      typeof threadId !== "string" || !/^[a-zA-Z0-9_:-]{8,150}$/.test(threadId))
    return null;
  return { cli, threadId };
}

function alertText(alertId, projectRoot, kind) {
  if (kind === "browser_recovery") return `NUMEMS 官方后台恢复提醒 [${alertId}]\n` +
    "这是用户已批准的单次只读恢复核验。普通程序多次无法读取官方后台，成员邀请和回收暂缓。" +
    `请管理员查看 ${path.join(projectRoot, ".sites-runtime", "queue-checker", "status.json")}。` +
    "先读取seat_portal_status：仅对browser_unavailable且无租约的故障，使用当前已授权in-app官方浏览器" +
    "让页面自然完成验证后，只读核对指定My Workspace的Owner、4个席位及完整成员和邀请清单；" +
    "取得60秒内完整证据才调用review_seat_failure(decision=recover_browser)。" +
    "不要邀请、移除、发送邮件、创建申请或改截止时间；普通检查器会根据云端核验回执恢复并另行派发有效待办。" +
    "仍需本人登录/验证码或无法完整核实时报告一次，不循环唤醒、不绕过验证、不重试结果不明的操作。";
  return `NUMEMS 确定性执行器故障告警 [${alertId}]\n` +
    `真实执行程序已停止。请由管理员检查 ${path.join(projectRoot, ".sites-runtime", "seat-executor", "status.json")}，` +
    "并核对门户租约和官方成员／邀请状态。此告警不代表邀请、邮件或移除成功；" +
    "结果不明时不要重试外部操作。此消息只通知故障，不授权办理成员或发送邮件。";
}

/** A durable client ID is written before queue/add. An ambiguous enqueue is
 * reconciled read-only, never sent again. No model turn is started here. */
export async function sendFatalAlert({ config, alertPath = defaultAlertPath,
  checkerConfigPath = defaultCheckerConfigPath, projectRoot = root,
  alertKind = "executor",
  clock = () => new Date(), newId = randomUUID,
  clientFactory = (cli, options) => new AppServerClient(cli, options),
} = {}) {
  if (!config?.liveActions) return { state: "disabled" };
  await mkdir(path.dirname(alertPath), { recursive: true });
  let state = await readJson(alertPath);
  if (state && (state.version !== 1 || !state.id || !state.clientId || !state.phase))
    throw new Error("Existing executor alert record needs manual review.");
  if (!state || state.resolvedAt) {
    const id = newId();
    state = { version: 1, id, clientId: `numems-executor-alert:${id}`,
      createdAt: clock().toISOString(), phase: "prepared" };
    await saveJson(alertPath, state);
  }
  if (state.phase === "queued") return { state: "deduped", id: state.id };
  const target = await destination(config, checkerConfigPath, projectRoot);
  if (!target) return { state: "not_configured", id: state.id };

  let client;
  let interactive = false;
  try {
    client = clientFactory(target.cli, { cwd: projectRoot, env: cleanEnv() });
    client.on("interactiveRequest", () => { interactive = true; });
    await client.initialize();
    if (interactive) throw new Error("Interactive authorization is required.");
    if (state.phase !== "prepared") {
      // A prior queue/add might have succeeded before a crash or timeout.
      // Looking at the queue is safe, but absence is not proof of non-delivery.
      let found;
      try { found = (await client.queued(target.threadId))
        .find(item => item.clientUserMessageId === state.clientId); }
      catch { /* Keep the previous uncertain state; never enqueue again. */ }
      if (found) {
        state = { ...state, phase: "queued", queuedId: found.id };
        await saveJson(alertPath, state);
        return { state: "queued", id: state.id };
      }
      state = { ...state, phase: "uncertain" };
      await saveJson(alertPath, state);
      return { state: "uncertain", id: state.id };
    }
    state = { ...state, phase: "enqueuing", threadId: target.threadId };
    await saveJson(alertPath, state);
    let queued;
    try {
      queued = await client.enqueue(target.threadId, state.clientId,
        alertText(state.id, projectRoot, alertKind));
    } catch {
      // Even a transport error can follow a successful queue write.
      state = { ...state, phase: "uncertain" };
      await saveJson(alertPath, state);
      return { state: "uncertain", id: state.id };
    }
    if (!queued?.queuedSubmission?.id || interactive) {
      state = { ...state, phase: "uncertain" };
      await saveJson(alertPath, state);
      return { state: "uncertain", id: state.id };
    }
    state = { ...state, phase: "queued", queuedId: queued.queuedSubmission.id };
    await saveJson(alertPath, state);
    return { state: "queued", id: state.id };
  } catch {
    // Setup failed before queue/add only when phase is prepared. Once marked
    // enqueuing, keep the durable uncertainty and never try another send.
    return { state: state.phase === "prepared" ? "not_sent" : "uncertain", id: state.id };
  } finally { if (client) await client.close().catch(() => {}); }
}

/** A successful live cycle closes the incident but preserves its receipt.
 * A later fatal stop is a new incident, not a retry of the old client ID. */
export async function markExecutorHealthy(alertPath = defaultAlertPath,
  clock = () => new Date()) {
  const state = await readJson(alertPath);
  if (!state || state.resolvedAt) return;
  await saveJson(alertPath, { ...state, resolvedAt: clock().toISOString() });
}
