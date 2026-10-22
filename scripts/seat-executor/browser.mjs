// Deterministic, fail-closed UI adapter. No private API requests, injected identity or model calls.
// Only an isolated, administrator-signed-in profile is used. Unknown UI requires maintenance.
import fs from "node:fs/promises";
import path from "node:path";
import { root, normalizeEmail } from "./config.mjs";
import { validateObservation, presence, assertOrdinary } from "./inventory.mjs";
import { OfficialPageError, waitForOfficialPage } from "./official-readiness.mjs";

export const ui = {
  members: /^(用户|活跃成员(?:\s+\d+)?|Users|Members(?:\s+\d+)?)$/,
  invites: /^(待处理的邀请|待处理邀请|Pending invitations|Invites)(?:\s+\d+)?$/i,
  next: /^(下一页|下一頁|Next page|Next)$/i,
  previous: /^(上一页|上一頁|Previous page|Previous)$/i,
  invite: /^(邀请成员|Invite members)$/i,
  send: /^(发送邀请|Send invitations?|Send invite)$/i,
  removeMenu: /^(移除成员|Remove member)$/i,
  removeConfirm: /^(从工作空间中移除|Remove from workspace)$/i,
  revoke: /^(撤销邀请|取消邀请|Revoke invitation|Cancel invitation)$/i,
  keepSeats: /^(保留付费席位|Keep paid seats)$/i
};
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function parseCapacity(text, label) {
  const clean = text.replace(/\u00a0/g, " ").trim();
  const total = clean.match(new RegExp(`(?:^|\\n)\\s*(\\d+)\\s*(?:\\n|\\s)+${escape(label)}(?:席位|\\s+seats)`, "i")) ||
    clean.match(new RegExp(`${escape(label)}(?:席位|\\s+seats)\\s*(\\d+)`, "i"));
  const assigned = clean.match(/(?:已分配|Assigned)\s*(\d+)/i), available = clean.match(/(?:可用|Available)\s*(\d+)/i);
  if (!total || !assigned || !available || +total[1] !== +assigned[1] + +available[1])
    throw new Error("无法严格读取已购席位、已分配和可用数量。");
  return { total: +total[1], assigned: +assigned[1], available: +available[1] };
}
export function parseRow(cells, seatLabel) {
  const text = cells.join("\n");
  const emails = [...new Set(text.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/g) || [])];
  if (emails.length !== 1) throw new Error("成员行无法唯一确定邮箱。");
  const roleNames = new Map([["所有者", "owner"], ["Owner", "owner"], ["管理员", "admin"], ["Admin", "admin"], ["成员", "member"], ["Member", "member"]]);
  const roleTokens = cells.flatMap(s => s.replace(/角色类型|Role type/gi, "").trim().split(/\n/)).map(s => s.trim()).filter(s => roleNames.has(s));
  const seats = cells.map(s => s.replace(/席位类型|Seat type/gi, "").trim()).filter(s => s === seatLabel);
  if (roleTokens.length !== 1 || seats.length !== 1) throw new Error("成员行角色或席位类型不明确。");
  return { email: normalizeEmail(emails[0]), role: roleNames.get(roleTokens[0]), seatLabel, self: /（你）|\(you\)/i.test(text) };
}
export async function chromiumRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, ".runtime/browsers");
  return (await import("playwright")).chromium;
}
async function only(locator, label) {
  const visible = locator.filter({ visible: true });
  if (await visible.count() !== 1) throw new Error(`${label}不唯一或不存在；页面结构可能变化。`);
  return visible;
}
export class BrowserAdapter {
  constructor(config, { page, fixtureOrigin, onExternalAction = () => {} } = {}) {
    this.config = config;
    // Test injection is unavailable to HTTP routes or .env. Tests use only a loopback fixture.
    if (fixtureOrigin && (!page || !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin))) throw new Error("Invalid fixture.");
    this.page = page; this.fixtureOrigin = fixtureOrigin;
    this.onExternalAction = onExternalAction;
  }
  async open() {
    if (this.page) return this.page;
    const chromium = await chromiumRuntime();
    await fs.mkdir(this.config.profile, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.config.profile, {
      headless: this.config.headless, viewport: { width: 1440, height: 1000 },
      locale: "zh-CN", acceptDownloads: false,
      ...(this.config.browserChannel ? { channel: this.config.browserChannel } : {})
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(12_000);
    this.page.on("dialog", dialog => { void dialog.dismiss(); }); // Never silently accept new legal/security prompts.
    return this.page;
  }
  url(tab = "members") {
    const base = this.fixtureOrigin || "https://admin.openai.com";
    return `${base}/workspace/${encodeURIComponent(this.config.workspaceId)}/members?workspace=${encodeURIComponent(this.config.workspaceSlug)}${tab === "invites" ? "&tab=invites" : ""}`;
  }
  async guard() {
    const p = await this.open(), url = new URL(p.url()), expected = new URL(this.url());
    if (url.origin !== expected.origin || !url.pathname.startsWith(`/workspace/${this.config.workspaceId}/members`))
      throw new OfficialPageError("管理员登录失效或跳转到非目标工作空间，请手动重新登录。",
        /auth\.openai\.com|\/(log-in|login|sign-in)/.test(p.url()) ? "login_expired" : "workspace_mismatch");
    const body = await p.locator("body").innerText();
    if (/verify you are human|captcha|完成验证|验证您是真人|安全验证|sign in to continue|登录以继续/i.test(body))
      throw new OfficialPageError("出现登录或安全验证，成员操作已停止。",
        /sign in to continue|登录以继续/i.test(body) ? "login_expired" : "browser_unavailable");
    if (!body.includes(this.config.workspaceName)) throw new Error("目标工作空间名称不匹配。");
    const switcher = p.getByRole("button", { name: new RegExp(`(?:当前选择[：:]|Current selection:).*${escape(this.config.workspaceName)}`) });
    await only(switcher, "工作空间选择器");
  }
  async load(tab = "members") {
    const p = await this.open();
    try { await p.goto(this.url(tab), { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch (error) {
      if (/Timeout|net::ERR_(TIMED_OUT|CONNECTION|NETWORK|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)/i.test(String(error)))
        throw new OfficialPageError("官方后台暂时无法连接，未开始成员操作。", "browser_unavailable");
      throw error;
    }
    const selected = p.getByRole("tab", { name: tab === "members" ? ui.members : ui.invites });
    await waitForOfficialPage({
      inspect: async () => ({ url: p.url(), expectedUrl: this.url(tab),
        body: await p.locator("body").innerText(), ready: await selected.isVisible() }),
      pause: ms => p.waitForTimeout(ms),
    });
    await this.guard();
    const tabControl = await only(selected, "成员标签页");
    if (await tabControl.getAttribute("aria-selected") !== "true") {
      await tabControl.click();
      await p.waitForFunction(el => el.getAttribute("aria-selected") === "true", await tabControl.elementHandle());
    }
    const searches = p.getByRole("searchbox").or(p.getByRole("textbox", { name: /搜索|筛选|Search|Filter/i })).filter({ visible: true });
    for (const search of await searches.all()) {
      if (await search.inputValue()) { await search.fill(""); await p.waitForTimeout(300); }
    }
    const filter = p.getByRole("combobox", { name: /^(角色|Role)$/i }).filter({ visible: true });
    if (await filter.count() && !/^(角色|所有角色|全部|Role|All roles|All)$/i.test((await filter.innerText()).trim()))
      throw new Error("成员列表存在角色筛选，请清除后恢复。");
    await p.getByRole("table").filter({ visible: true }).waitFor({ state: "visible", timeout: 25_000 });
  }
  async capacity() {
    const p = await this.open(), label = `${this.config.seatLabel}席位`;
    const texts = await p.getByText(new RegExp(`^${escape(this.config.seatLabel)}(?:席位| seats)$`, "i")).evaluateAll(nodes => nodes.map(node => {
      let el = node;
      for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
        if (el.querySelector("dl") && /已分配|Assigned/i.test(el.innerText) && /可用|Available/i.test(el.innerText)) return el.innerText;
      }
      return "";
    }));
    const candidates = [...new Set(texts.filter(Boolean))];
    if (candidates.length !== 1) throw new Error(`无法唯一确定${label}容量卡。`);
    return parseCapacity(candidates[0], this.config.seatLabel);
  }
  async rows() {
    const p = await this.open(), result = [], fingerprints = new Set();
    for (let index = 0; index < 100; index++) {
      await this.guard();
      const table = await only(p.getByRole("table"), "成员或邀请表");
      const records = await table.getByRole("row").all();
      const pageRows = [];
      for (const row of records) {
        const cells = await row.getByRole("cell").allInnerTexts();
        if (!cells.length || !cells.join(" ").includes("@")) continue; // Column header, never a user.
        pageRows.push(parseRow(cells, this.config.seatLabel));
      }
      if (!pageRows.length) {
        const empty = p.getByText(/^(无结果|未找到成员|没有待处理的邀请|No results|No pending invitations|No members found)[。.]*$/i);
        if (!await empty.filter({ visible: true }).count()) throw new Error("空列表没有可信的加载完成状态。");
      }
      const fingerprint = JSON.stringify(pageRows);
      if (fingerprints.has(fingerprint)) throw new Error("分页重复，无法确认完整名单。");
      fingerprints.add(fingerprint); result.push(...pageRows);
      const next = p.getByRole("button", { name: ui.next }).filter({ visible: true });
      if (await next.count() > 1) throw new Error("分页控件不唯一。");
      if (!await next.count() || !await next.isEnabled() || await next.getAttribute("aria-disabled") === "true") return result;
      const oldText = await table.innerText();
      await next.click();
      // Bounded wait for the visible table to change; never an unbounded polling loop.
      await p.waitForFunction(({ selector, old }) => {
        const t = document.querySelector(selector); return t && t.innerText !== old;
      }, { selector: 'table,[role="table"]', old: oldText }, { timeout: 12_000 });
    }
    throw new Error("分页超过上限，未执行外部操作。");
  }
  async snapshot() {
    await this.load("members");
    const capacity = await this.capacity(), members = await this.rows();
    const me = members.filter(p => p.self);
    if (me.length !== 1 || me[0].email !== this.config.adminEmail || me[0].role !== "owner")
      throw new Error("页面中的当前账号不是指定 Owner。");
    await this.load("invites");
    const invites = await this.rows();
    // The Business seat card can account for pending invitations as assigned.
    // Verify only the two unambiguous interpretations; never infer a free seat
    // from a partial list or an unexplained count.
    if (![members.length, members.length + invites.length].includes(capacity.assigned))
      throw new Error("读取成员及邀请数与席位已分配数不一致，可能存在分页或加载变化。");
    return {
      complete: true, workspaceId: this.config.workspaceId, workspaceName: this.config.workspaceName,
      accountEmail: me[0].email, totalSeats: capacity.total, seatLabel: this.config.seatLabel,
      members: members.map(p => ({ email: p.email, role: p.role, seatLabel: p.seatLabel })),
      invites: invites.map(p => ({ email: p.email, role: p.role, seatLabel: p.seatLabel })),
      observedAt: new Date().toISOString(), pageUrl: this.page.url()
    };
  }
  async observe() {
    const a = await this.snapshot(), b = await this.snapshot();
    const canonical = s => JSON.stringify({ totalSeats: s.totalSeats,
      members: s.members.slice().sort((x, y) => x.email.localeCompare(y.email)),
      invites: s.invites.slice().sort((x, y) => x.email.localeCompare(y.email)) });
    if (canonical(a) !== canonical(b)) throw new Error("两次完整快照不一致，等待管理员核对，未执行写入。");
    return validateObservation(b, this.config);
  }
  permit(email, before) {
    if (!this.config.liveActions && !this.fixtureOrigin) throw new Error("LIVE_ACTIONS 未开启。");
    normalizeEmail(email);
    validateObservation(before, this.config);
    assertOrdinary(before, email, { config: { protectedEmails: [this.config.adminEmail] } });
  }
  async invite(email, before) {
    this.permit(email, before);
    if (presence(before, email) !== "absent") return;
    if (before.members.length + before.invites.length >= this.config.totalSeats) throw new Error("容量已满。");
    await this.load("members"); const p = this.page;
    const current = await this.capacity();
    if (current.total !== this.config.totalSeats || current.available < 1) throw new Error("没有已购可用席位。");
    await (await only(p.getByRole("button", { name: ui.invite }), "邀请成员按钮")).click();
    const dialog = await only(p.getByRole("dialog"), "邀请对话框");
    if (!(await dialog.innerText()).includes(this.config.workspaceName)) throw new Error("邀请工作空间不匹配。");
    await (await only(dialog.getByRole("textbox", { name: /电子邮箱|Email/i }), "邀请邮箱")).fill(email);
    // Select the already-paid configured pool. Never change an existing member's seat.
    const seats = dialog.getByRole("combobox", { name: /席位类型|Seat type/i });
    const seat = await only(seats, "席位类型选择器");
    if (!(await seat.innerText()).includes(this.config.seatLabel)) {
      await seat.click();
      await (await only(p.getByRole("option", { name: new RegExp(`^${escape(this.config.seatLabel)}(?:\\s|$)`) }), "已购席位类型")).click();
    }
    const role = dialog.getByRole("combobox", { name: /角色|Role/i });
    if (!/成员|Member/i.test(await (await only(role, "邀请角色")).innerText())) throw new Error("只允许邀请普通成员。");
    const text = await dialog.innerText();
    if (/需要增加|需要购买|额外费用|add \d+ seats?|additional charge|purchase|buy seats/i.test(text))
      throw new Error("邀请将引起加购或费用变化，禁止继续。");
    if ((await dialog.getByRole("textbox", { name: /电子邮箱|Email/i }).inputValue()).trim().toLowerCase() !== email)
      throw new Error("邀请邮箱发生变化。");
    await this.guard();
    this.onExternalAction("invite", email);
    await (await only(dialog.getByRole("button", { name: ui.send }), "发送邀请按钮")).click();
    // Capture the completed click before waiting for the dialog to disappear.
    // The UI exposes no authoritative server send timestamp.
    const invitationSentAt = new Date().toISOString();
    await dialog.waitFor({ state: "hidden", timeout: 20_000 });
    // Worker performs a fresh, full observation before acknowledging success.
    return invitationSentAt;
  }
  async locateRow(email) {
    const p = this.page;
    for (let i = 0; i < 100; i++) {
      const table = await only(p.getByRole("table"), "成员表");
      // DOM textContent does not preserve visual cell boundaries; parseRow below checks exact identity.
      const rows = table.getByRole("row").filter({ hasText: new RegExp(escape(email), "i") });
      if (await rows.count() === 1) return rows;
      if (await rows.count() > 1) throw new Error("目标邮箱重复。");
      const next = p.getByRole("button", { name: ui.next }).filter({ visible: true });
      if (!await next.count() || !await next.isEnabled()) break;
      await (await only(next, "下一页")).click();
      await p.waitForTimeout(400);
    }
    throw new Error("未定位到确切目标邮箱。");
  }
  async remove(email, before) {
    this.permit(email, before);
    const original = presence(before, email); if (original === "absent") return;
    await this.load(original === "member" ? "members" : "invites");
    const p = this.page, row = await this.locateRow(email);
    const parsed = parseRow(await row.getByRole("cell").allInnerTexts(), this.config.seatLabel);
    if (parsed.email !== email || parsed.role !== "member" || parsed.self) throw new Error("目标身份或角色不安全。");
    await (await only(row.getByRole("button", { name: /打开.+的操作|Open .+ actions|Actions for/i }), "成员操作菜单")).click();
    // Some UI variants apply invite revocation directly from the menu. Mark the
    // outcome as potentially external before that click so an unexpected UI
    // transition cannot be recorded as an operation that never started.
    const menuAction = await only(p.getByRole("menuitem", {
      name: original === "member" ? ui.removeMenu : ui.revoke,
    }), "成员移除或撤销邀请菜单");
    this.onExternalAction("remove", email);
    await menuAction.click();
    const dialog = await only(p.getByRole("dialog"), "移除确认对话框");
    const dialogText = await dialog.innerText();
    // The official dialog may show display name rather than email; retain exact row identity and workspace.
    if (!dialogText.includes(this.config.workspaceName)) throw new Error("移除确认的工作空间不匹配。");
    if (/删除数据|Delete data|permanently delete/i.test(dialogText)) throw new Error("检测到删除数据流程，禁止操作。");
    await this.guard();
    await (await only(dialog.getByRole("button", { name: original === "member" ? ui.removeConfirm : ui.revoke }), "最终确认按钮")).click();
    if (original === "member") {
      const keep = p.getByRole("button", { name: ui.keepSeats });
      // Current Business flow presents paid-seat retention after a member is removed.
      // Wait for that control OR all dialogs closing; never click a purchase/reduction button.
      await p.waitForFunction(() => {
        const visible = e => e.getClientRects().length;
        return [...document.querySelectorAll("button")].some(e => visible(e) && /^(保留付费席位|Keep paid seats)$/i.test(e.innerText.trim())) ||
          ![...document.querySelectorAll('[role="dialog"]')].some(visible);
      }, null, { timeout: 25_000 });
      if (await keep.filter({ visible: true }).count()) await (await only(keep, "保留付费席位")).click();
    }
    await p.getByRole("dialog").filter({ visible: true }).waitFor({ state: "hidden", timeout: 20_000 });
  }
  async close() { if (this.context) await this.context.close(); this.context = null; this.page = null; }
}
