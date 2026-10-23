// 用管理员已登录的浏览器档案直接读写官方工作空间成员。
// 只通过官方页面同源接口与页面控件操作，不复制 Cookie、不伪造身份。
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.mjs";

const roleOf = value => value === "account-owner" || value === "owner" ? "owner"
  : value === "admin" || value === "account-admin" ? "admin" : "member";

const personOf = (item, invited) => ({
  email: item.email ?? item.email_address,
  role: roleOf(item.role),
  ...(invited ? { inviteId: item.id } : { userId: item.id }),
});

const membersUrlOf = workspaceId =>
  `https://admin.openai.com/workspace/${workspaceId}/members?workspace=my-workspace`;

// 在已导航到官方管理后台的页面里提供读取与写操作。
export function officialTools(page, workspaceId) {
  const api = (path, init = {}) => page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: response.status, body };
  }, { path, init });

  async function snapshot() {
    const users = await api(`/api/workspaces/${workspaceId}/members/users?limit=100&offset=0&view=members`);
    const invites = await api(`/api/workspaces/${workspaceId}/members/invites?limit=100&offset=0&status=invited`);
    const capacity = await api(`/api/workspaces/${workspaceId}/billing/premium-seat-capacity`);
    const memberItems = users.body?.users?.items ?? [];
    const inviteItems = invites.body?.invites?.items ?? [];
    const members = memberItems.map(item => personOf(item, false));
    const pending = inviteItems.map(item => personOf(item, true));
    const complete = users.status === 200 && invites.status === 200 && capacity.status === 200 &&
      users.body?.users?.pagination?.total === memberItems.length &&
      invites.body?.invites?.pagination?.total === inviteItems.length;
    return {
      workspaceId,
      accountEmail: members.find(member => member.role === "owner")?.email ?? "",
      pageUrl: `https://admin.openai.com/workspace/${workspaceId}/members`,
      observedAt: new Date().toISOString(), complete,
      totalSeats: capacity.body?.billing?.subscription?.seats_entitled ?? 0,
      members: members.map(({ email, role }) => ({ email, role })),
      invites: pending.map(({ email, role }) => ({ email, role })),
      detail: { members, pending },
    };
  }

  async function remove(email) {
    const before = await snapshot();
    const found = before.detail.members.find(member => member.email?.toLowerCase() === email.toLowerCase());
    if (!found) return { performed: false, reason: "not_member", before };
    const result = await api(`/api/workspaces/${workspaceId}/members/users/${found.userId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_address: found.email }),
    });
    return { performed: result.status === 200, status: result.status, target: found.email, body: result.body };
  }

  async function revoke(email) {
    const before = await snapshot();
    const invited = before.detail.pending.find(item => item.email?.toLowerCase() === email.toLowerCase());
    if (!invited) return { performed: false, reason: "no_pending_invite", before };
    const result = await api(`/api/workspaces/${workspaceId}/members/invites`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_address: invited.email }),
    });
    return { performed: result.status === 200, status: result.status, target: invited.email, body: result.body };
  }

  async function invite(email) {
    const before = await snapshot();
    if ([...before.detail.members, ...before.detail.pending].some(item => item.email?.toLowerCase() === email.toLowerCase()))
      return { performed: false, reason: "already_present", before };
    const requests = [], responses = [];
    const onRequest = request => {
      if (request.method() === "POST" && /admin\.openai\.com\/api\/workspaces\//.test(request.url()))
        requests.push({ url: request.url(), body: request.postData() });
    };
    const onResponse = response => {
      if (response.request().method() === "POST" && /admin\.openai\.com\/api\/workspaces\//.test(response.url()))
        responses.push({ status: response.status(), url: response.url() });
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    try {
      await page.locator('button[aria-label="邀请成员"]').first().click();
      const field = page.locator('[role="dialog"] input[aria-label="电子邮箱"]').first();
      await field.waitFor();
      await field.fill(email);
      // 默认“标准”席位可用数为 0，必须显式选中“高级”席位，避免触发付费升级。
      const seat = page.locator('[role="dialog"] span[role="button"]').filter({ hasText: "席位类型" }).first();
      if (await seat.count()) {
        await seat.click();
        const premium = page.locator('[role="option"]').filter({ hasText: "高级" }).first();
        if (await premium.count()) await premium.click();
      }
      await page.waitForTimeout(600);
      const invitationSentAt = new Date().toISOString();
      await page.getByRole("button", { name: "发送邀请" }).first().click();
      const started = Date.now();
      let after = null;
      while (Date.now() - started < 25_000) {
        await page.waitForTimeout(1500);
        after = await snapshot();
        if ([...after.detail.members, ...after.detail.pending]
          .some(item => item.email?.toLowerCase() === email.toLowerCase())) break;
        if (responses.some(item => item.status >= 400)) break;
      }
      after ??= await snapshot();
      const present = [...after.detail.members, ...after.detail.pending]
        .some(item => item.email?.toLowerCase() === email.toLowerCase());
      return { performed: present, invitationSentAt, requests, responses, after };
    } catch (error) {
      return { performed: false, reason: "ui_error", detail: error.message.slice(0, 300), requests, responses };
    } finally {
      page.off("request", onRequest);
      page.off("response", onResponse);
    }
  }

  return { api, snapshot, invite, remove, revoke };
}

// CLI 用法
if (import.meta.main) {
  const config = await loadConfig();
  const args = process.argv.slice(2);
  const command = args[0];
  const target = (args[1] ?? "").trim().toLowerCase();
  if (!["snapshot", "remove", "revoke", "invite"].includes(command ?? "")) {
    console.error("用法：node scripts/trae/official-members.mjs <snapshot|remove|revoke|invite> [邮箱]");
    process.exit(1);
  }
  if (command !== "snapshot" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
    console.error("缺少有效邮箱。");
    process.exit(1);
  }
  await mkdir(config.profile, { recursive: true });
  const context = await chromium.launchPersistentContext(config.profile, {
    channel: config.browserChannel || undefined,
    headless: config.headless, viewport: { width: 1440, height: 960 }, locale: "zh-CN",
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);
  await page.goto(membersUrlOf(config.workspaceId), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2500);
  const tools = officialTools(page, config.workspaceId);
  let payload;
  if (command === "snapshot") payload = await tools.snapshot();
  if (command === "remove") payload = { ...(await tools.remove(target)), after: await tools.snapshot() };
  if (command === "revoke") payload = { ...(await tools.revoke(target)), after: await tools.snapshot() };
  if (command === "invite") payload = await tools.invite(target);
  console.log(JSON.stringify(payload, null, 2));
  await context.close();
  process.exit(payload.performed === false ? 2 : 0);
}
