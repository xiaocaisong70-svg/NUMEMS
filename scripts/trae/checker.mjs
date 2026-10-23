// TRAE CN 的确定式巡检器：不启动任何模型、不依赖 Codex。
// 每轮读取门户计划，把真正的待办写入 pending.json；由 TRAE 代理按 skill 办理。
import { readFile, writeFile, mkdir, rename, open, unlink } from "node:fs/promises";
import path from "node:path";
import { loadConfig, runtimeDir } from "./config.mjs";
import { assertLegacyInactive } from "./legacy-guard.mjs";
import { TRAE_SCHEDULE_ID, assertRelayMode, beginRun, collectItems, decision, settle } from "./checker-core.mjs";

const statePath = path.join(runtimeDir, "state.json");
const statusPath = path.join(runtimeDir, "status.json");
const pendingPath = path.join(runtimeDir, "pending.json");
const lockPath = path.join(runtimeDir, "checker.lock");
const ackPath = id => path.join(runtimeDir, `ack-${id}.json`);

const args = process.argv.slice(2);
const has = name => args.includes(name);
const value = name => args[args.indexOf(name) + 1];

async function readJson(file, fallback) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

async function save(file, data, mode = 0o600) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode });
  await rename(temporary, file);
}

async function lock() {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return async () => { await handle.close(); await unlink(lockPath); };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = await readJson(lockPath);
    if (!Number.isInteger(old.pid)) throw new Error("锁文件无效，需人工核对。");
    try {
      process.kill(old.pid, 0);
      return null;
    } catch (check) {
      if (check.code !== "ESRCH") return null;
      await unlink(lockPath);
      return lock();
    }
  }
}

await mkdir(runtimeDir, { recursive: true });

if (has("--dry-run")) {
  // 只读验收：不调用 process_seat_queue（会投递提醒并改动运行时），
  // 不登记调度、不写 pending.json/state.json，只读取计划并计算本轮决策。
  let dryClient = null;
  let dryExit = 0;
  try {
    const { TraePortalClient } = await import("./portal-client.mjs");
    dryClient = new TraePortalClient({ ...(await loadConfig()), headless: true });
    const snapshot = await dryClient.call("seat_portal_status");
    const plan = snapshot.plan;
    const state = await readJson(statePath, { version: 1, seen: {}, checks: 0, runs: 0 });
    const result = decision(state, plan);
    const items = result.kind === "wake" ? collectItems(plan, result.events) : null;
    console.log(JSON.stringify({
      dryRun: true,
      portalReachable: true,
      administratorVerified: true,
      decision: result.kind,
      eventCount: result.events.length,
      items,
      plan: {
        enabled: plan.enabled,
        testOnly: plan.testOnly,
        busy: plan.busy,
        scheduleId: plan.scheduleId,
        lastError: plan.lastError ?? null,
        globalFailureCode: plan.globalFailureCode ?? null,
        blockedOperations: plan.blockedOperations?.length ?? 0,
        reminders: plan.reminders?.length ?? 0,
        mailChannelError: plan.mailChannelError ?? null,
      },
      note: "只读验收：未调用 process_seat_queue，未登记调度，未写 pending.json。",
    }, null, 2));
  } catch (error) {
    console.error(`TRAE dry-run: ${error.message}`);
    dryExit = 1;
  } finally {
    if (dryClient) await dryClient.close();
  }
  process.exit(dryExit);
}

if (has("--status")) {
  console.log(JSON.stringify(await readJson(statusPath, { state: "not_started" }), null, 2));
  process.exit(0);
}

if (has("--ack")) {
  const id = value("--ack"), outcome = value("--outcome");
  if (!/^[0-9a-f-]{36}$/.test(id ?? "") || !["done", "blocked", "uncertain"].includes(outcome))
    throw new Error("确认参数无效。");
  const state = await readJson(statePath, { version: 1, seen: {}, checks: 0, runs: 0 });
  const file = ackPath(id);
  const old = await readJson(file, null);
  if (old) {
    if (old.outcome !== outcome) throw new Error("同一运行已记录不同的确认结果。");
  } else {
    if (state.active?.id !== id) throw new Error("确认与当前 TRAE 运行不匹配。");
    await save(file, { id, outcome, at: new Date().toISOString() });
  }
  console.log(`TRAE 运行确认已记录：${outcome}。下次 --once 会结算本次运行。`);
  process.exit(0);
}

if (has("--resume")) {
  const unlock = await lock();
  if (!unlock) process.exit(0);
  try {
    const state = await readJson(statePath, { version: 1, seen: {}, checks: 0, runs: 0 });
    if (state.active) throw new Error("仍有未确认的 TRAE 运行，请先结算。");
    state.recoveries = [...(state.recoveries ?? []), {
      at: new Date().toISOString(), priorHalt: state.halted, lastAcknowledgement: state.lastAcknowledgement,
    }].slice(-100);
    delete state.halted;
    for (const [key, item] of Object.entries(state.seen ?? {}))
      if (item.outcome !== "done") delete state.seen[key];
    await save(statePath, state);
    console.log("TRAE 执行器已恢复。");
  } finally {
    await unlock();
  }
  process.exit(0);
}

const unlock = await lock();
if (!unlock) process.exit(0);
const state = await readJson(statePath, { version: 1, seen: {}, checks: 0, runs: 0 });
state.seen ??= {};
if (!state.active && state.lastAcknowledgement?.id) {
  const settledPending = await readJson(pendingPath, null);
  if (settledPending?.runId === state.lastAcknowledgement.id)
    await unlink(pendingPath).catch(() => {});
  await unlink(ackPath(state.lastAcknowledgement.id)).catch(() => {});
}
let client = null;
let exitCode = 0;
try {
  // 仅真正需要访问门户时才加载 Playwright；--status/--ack/--resume 无需依赖。
  const { TraePortalClient } = await import("./portal-client.mjs");
  const config = await loadConfig();
  await assertLegacyInactive(config);
  client = new TraePortalClient(config);
  const jobs = await client.call("process_seat_queue");
  assertRelayMode(jobs);
  const snapshot = await client.call("seat_portal_status");
  const plan = snapshot.plan;
  const savedAck = state.active ? await readJson(ackPath(state.active.id), null) : null;
  if (savedAck) {
    settle(state, savedAck, plan);
    // Persist the settled run before removing its durable handoff files. If the
    // process crashes earlier, the ack can safely be applied again next run.
    await save(statePath, state);
    await unlink(ackPath(savedAck.id)).catch(() => {});
    const oldPending = await readJson(pendingPath, null);
    if (oldPending?.runId === savedAck.id) await unlink(pendingPath).catch(() => {});
  }
  let result = decision(state, plan);
  state.checks++;
  if (result.kind === "stalled") {
    state.halted = { reason: "run_not_acknowledged", at: new Date().toISOString() };
    result = { kind: "halted", events: [] };
  }
  let runId = null, items = null;
  if (result.kind === "wake") {
    runId = beginRun(state, result.events);
    state.runs = (state.runs ?? 0) + 1;
    // 先持久化运行意图，再写待办文件；崩溃也不会导致同一事件被静默重发。
    await save(statePath, state);
    items = collectItems(plan, result.events);
    await save(pendingPath, {
      runId,
      createdAt: new Date().toISOString(),
      workspaceId: plan.workspaceId,
      administrator: plan.administrator,
      events: result.events,
      items,
      plan: {
        enabled: plan.enabled, testOnly: plan.testOnly, busy: plan.busy,
        lastError: plan.lastError ?? null,
        globalFailureCode: plan.globalFailureCode ?? null,
        blockedOperations: plan.blockedOperations ?? [],
        mailChannelError: plan.mailChannelError ?? null,
      },
      relayReminders: plan.reminders ?? [],
      procedure: "docs/TRAE-CN-EXECUTOR.md",
      ackCommand: `node scripts/trae/checker.mjs --ack ${runId} --outcome done`,
    });
  }
  const healthy = Boolean(plan.enabled && !plan.testOnly && !plan.lastError &&
    !plan.globalFailureCode && !state.halted && result.kind !== "halted");
  const registeredId = healthy ? TRAE_SCHEDULE_ID : "";
  let scheduleError = null;
  if (plan.scheduleId !== registeredId) {
    try {
      await client.call("record_codex_schedule", { scheduleId: registeredId });
    } catch (error) {
      // 登记只影响门户上的在线指示，不应阻断本轮真实办理。
      scheduleError = error.message;
    }
  }
  await save(statePath, state);
  const status = {
    checkedAt: new Date().toISOString(),
    mode: "trae_cn",
    state: state.halted || result.kind === "halted" ? "blocked" : runId ? "pending_trae" : result.kind,
    modelCallsByChecker: 0,
    checks: state.checks,
    runs: state.runs ?? 0,
    runId,
    events: result.events.length,
    pending: {
      invites: items?.invites.length ?? plan.invites?.length ?? 0,
      removals: items?.removals.length ?? plan.removals?.length ?? 0,
      reminders: plan.reminders?.length ?? 0,
      acceptance: items?.awaitingAcceptance.length ?? plan.awaitingAcceptance?.length ?? 0,
    },
    mailMode: "relay",
    isolatedOperations: plan.blockedOperations?.length ?? 0,
    ...(plan.mailChannelError ? { mailChannelError: plan.mailChannelError } : {}),
    ...(scheduleError ? { scheduleError } : {}),
    ...(state.halted ? { reason: state.halted.reason } : result.reason ? { reason: result.reason } : {}),
  };
  await save(statusPath, status);
  console.log(JSON.stringify(status));
  exitCode = runId ? 3 : result.kind === "halted" ? 2 : 0;
} catch (error) {
  await save(statusPath, {
    checkedAt: new Date().toISOString(), mode: "trae_cn", state: "error",
    modelCallsByChecker: 0, error: error.message,
  });
  console.error(`TRAE checker: ${error.message}`);
  exitCode = 1;
} finally {
  if (client) await client.close();
  await unlock();
}
process.exit(exitCode);
