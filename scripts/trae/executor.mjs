// 无人值守执行器：单次运行读取门户计划，直接完成官方邀请／移除并回执。
// 不调用任何模型；每轮最多处理 3 个目标，异常按故障分类隔离并退出。
import { chromium } from "playwright";
import { writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, runtimeDir, ADMIN_EMAIL } from "./config.mjs";
import { assertLegacyInactive } from "./legacy-guard.mjs";
import { officialTools } from "./official-members.mjs";

const MAX_ITEMS = 3;
const statusPath = path.join(runtimeDir, "executor-status.json");

const clean = ({ detail: _detail, ...rest }) => rest;

async function save(data) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, statusPath);
}

const config = await loadConfig();
await assertLegacyInactive(config);

// 空闲时先不启动浏览器：用裸请求问门户有没有待办，避免每 5 分钟弹窗打扰。
async function hasPendingWork() {
  try {
    const response = await fetch(new URL("/api/executor-hint", config.siteUrl), { cache: "no-store" });
    if (!response.ok) return true;
    const body = await response.json();
    return Number(body?.pending ?? 0) > 0;
  } catch {
    // 探测失败时按「有待办」处理：宁可多跑一轮，也不漏办申请。
    return true;
  }
}

if (!(await hasPendingWork())) {
  await save({ checkedAt: new Date().toISOString(), mode: "deterministic_executor",
    state: "idle", skipped: "no_pending_work", actions: [] });
  process.exit(0);
}

let exitCode = 0;
const actions = [];
let context;
try {
  context = await chromium.launchPersistentContext(config.profile, {
    channel: config.browserChannel || undefined,
    headless: config.headless,
    viewport: { width: 1440, height: 960 },
    locale: "zh-CN",
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
      // 窗口创建到屏幕外，避免无人值守运行时遮住正在使用电脑的人。
      "--window-position=-32000,-32000"],
  });
  const portal = context.pages()[0] ?? (await context.newPage());
  portal.setDefaultTimeout(20_000);
  await portal.goto(config.siteUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const identity = await portal.evaluate(async () => {
    const response = await fetch("/api/portal", { cache: "no-store", credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  });
  if (identity.status !== 200 || identity.body?.access !== "allowed" ||
      identity.body?.user?.email?.toLowerCase() !== ADMIN_EMAIL)
    throw new Error(`管理员身份校验失败，已停止本轮。status=${identity.status} access=${identity.body?.access ?? "unknown"} user=${identity.body?.user?.email ?? "none"}`);

  const call = async (name, args = {}) => {
    const result = await portal.evaluate(async ({ name, args }) => {
      const response = await fetch("/api/codex", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      return { status: response.status, body: await response.json() };
    }, { name, args });
    if (result.body?.error || result.body?.result?.isError)
      throw new Error(`${name}: ${result.body?.error?.message ?? result.body?.result?.content?.[0]?.text}`);
    return JSON.parse(result.body.result.content[0].text);
  };

  await call("process_seat_queue");
  let plan = (await call("seat_portal_status")).plan;

  const admin = await context.newPage();
  admin.setDefaultTimeout(20_000);
  await admin.goto(`https://admin.openai.com/workspace/${config.workspaceId}/members?workspace=my-workspace`,
    { waitUntil: "domcontentloaded", timeout: 45_000 });
  await admin.waitForTimeout(2500);
  const tools = officialTools(admin, config.workspaceId);

  const observe = async () => {
    const observation = await tools.snapshot();
    if (!observation.accountEmail || observation.accountEmail.toLowerCase() !== config.adminEmail)
      throw new Error("官方账号与门户管理员不一致，已停止。");
    if (!observation.complete) throw new Error("官方成员列表不完整，已停止。");
    await call("observe_workspace", { observation });
  };

  const present = (snapshot, email) => [...snapshot.detail.members, ...snapshot.detail.pending]
    .some(person => person.email?.toLowerCase() === email.toLowerCase());

  const runItem = async (kind, item) => {
    await observe();
    const lease = (await call("claim_seat_operation", { kind, targetId: item.id })).lease;
    let run;
    try {
      const snapshot = await tools.snapshot();
      const asMember = snapshot.detail.members.some(person => person.email?.toLowerCase() === item.email.toLowerCase());
      const asInvite = snapshot.detail.pending.some(person => person.email?.toLowerCase() === item.email.toLowerCase());
      // 目标已处于期望状态时不必重复动作：邀请＝已在成员/邀请列表，移除＝两者都不在。
      const settled = kind === "invite" ? (asMember || asInvite) : (!asMember && !asInvite);
      if (settled) {
        const completed = await call("complete_seat_operation", {
          operationId: lease.id, token: lease.token, outcome: "verified",
          observation: clean(snapshot),
          ...(kind === "invite" ? { invitationSentAt: snapshot.observedAt } : {}),
        });
        return { kind, email: item.email, status: "verified",
          blocked: completed.blockedOperations?.length ?? 0 };
      }
      run = kind === "remove"
        ? (asMember ? await tools.remove(item.email) : await tools.revoke(item.email))
        : await tools.invite(item.email);
    } catch (error) {
      run = { performed: false, reason: "action_error", detail: error.message };
    }

    await admin.waitForTimeout(2000);
    const after = run.after ?? await tools.snapshot();
    const ok = run.performed && (kind === "invite" ? present(after, item.email) : !present(after, item.email));
    if (ok) {
      const completed = await call("complete_seat_operation", {
        operationId: lease.id, token: lease.token, outcome: "verified",
        observation: clean(after),
        ...(kind === "invite" ? { invitationSentAt: run.invitationSentAt } : {}),
      });
      return { kind, email: item.email, status: "verified", blocked: completed.blockedOperations?.length ?? 0 };
    }
    const code = kind === "remove" ? "member_action" : "approval_required";
    const detail = JSON.stringify({ requests: run.requests, responses: run.responses,
      reason: run.reason, detail: run.detail }).slice(0, 380);
    const completed = await call("complete_seat_operation", {
      operationId: lease.id, token: lease.token, outcome: "blocked", failureCode: code, detail,
    });
    return { kind, email: item.email, status: "blocked", code,
      blocked: completed.blockedOperations?.length ?? 0 };
  };

  const queue = [
    ...(plan.removals ?? []).map(item => ["remove", item]),
    ...(plan.invites ?? []).map(item => ["invite", item]),
  ];
  if (plan.busy) {
    actions.push({ status: "skipped", reason: "已有未完成租约" });
  } else {
    for (const [kind, item] of queue.slice(0, MAX_ITEMS)) {
      try {
        const action = await runItem(kind, item);
        actions.push(action);
        if (action.status === "blocked") exitCode = 2;
      } catch (error) {
        exitCode = 2;
        actions.push({ kind, email: item.email, status: "error", error: error.message.slice(0, 240) });
      }
      plan = (await call("seat_portal_status")).plan;
      if (!plan.enabled || plan.lastError || plan.globalFailureCode) { exitCode = 2; break; }
    }
  }

  await save({
    checkedAt: new Date().toISOString(), mode: "deterministic_executor",
    state: exitCode === 0 ? (actions.length ? "done" : "idle") : "blocked",
    actions,
    plan: {
      enabled: plan.enabled, testOnly: plan.testOnly, busy: plan.busy,
      lastError: plan.lastError ?? null, globalFailureCode: plan.globalFailureCode ?? null,
      blockedOperations: plan.blockedOperations?.length ?? 0,
    },
  });
} catch (error) {
  await save({ checkedAt: new Date().toISOString(), mode: "deterministic_executor",
    state: "error", error: error.message });
  console.error(`确定性执行器：${error.message}`);
  exitCode = 1;
} finally {
  await context?.close();
}
process.exit(exitCode);
