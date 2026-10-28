// Deterministic, fail-closed UI adapter. No private API requests, injected identity or model calls.
// Only an isolated, administrator-signed-in profile is used. Unknown UI requires maintenance.
import fs from "node:fs/promises";
import path from "node:path";
import { root, normalizeEmail } from "./config.mjs";
import { validateObservation, presence, assertOrdinary } from "./inventory.mjs";
import { OfficialPageError, officialPageState, officialDiagnostic, waitForOfficialPage } from "./official-readiness.mjs";

export const ui = {
  members: /^(用户|活跃成员(?:\s*\d+)?|Users|Members(?:\s*\d+)?)$/,
  invites: /^(待处理的邀请|待处理邀请|Pending invitations|Invites)(?:\s*\d+)?$/i,
  next: /^(下一页|下一頁|Next page|Next)$/i,
  previous: /^(上一页|上一頁|Previous page|Previous)$/i,
  invite: /^(邀请成员|Invite members)$/i,
  send: /^(发送邀请|Send invitations?|Send invite)$/i,
  removeMenu: /^(移除成员|Remove member)$/i,
  removeConfirm: /^(从工作空间中移除|Remove from workspace)$/i,
  revoke: /^(撤销邀请|取消邀请|Revoke invitation|Cancel invitation)$/i,
  keepSeats: /^(保留付费席位|Keep paid seats)$/i,
  empty: /^(无结果|未找到成员|没有待处理的邀请|No results|No pending invitations|No members found)[。.]*$/i
};
export const REMOVE_OPERATION_STAGES=Object.freeze(['permission','load','target_row','menu_open',
  'menu_action','confirmation_wait','confirmation_validate','confirmation_click',
  'retention_wait','retention_validate','retention_click','dialogs_closed']);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A capacity/list mismatch can arise while an invitation is being accepted
// between the sequential page reads. The evidence is incomplete, never a
// snapshot; only a caller before a claim may classify it for read-only retry.
export class InventoryMismatchError extends Error {
  constructor(capacity, members, invites) {
    super(`读取成员及邀请数与席位已分配数不一致（已购 ${capacity.total}，已分配 ${capacity.assigned}，可用 ${capacity.available}，成员 ${members}，邀请 ${invites}）。`);
    this.name = "InventoryMismatchError";
  }
}
// A recognized official capacity-card error permits one page navigation only.
// It is not capacity evidence and never permits a member or invitation action.
export class CapacityCardUnavailable extends OfficialPageError {
  constructor(diagnostic) { super("官方席位信息加载失败；完整名单未采纳。", "browser_unavailable",diagnostic); }
}
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
// Opening a modal/menu is asynchronous in the official UI. Wait for that new
// surface, then retain the same strict uniqueness and visibility checks.
async function readyOnly(locator, label) {
  await locator.filter({ visible: true }).waitFor({ state: "visible", timeout: 20_000 });
  return only(locator, label);
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
      locale: "zh-CN", acceptDownloads: false, chromiumSandbox: true,
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
    // Modal dialogs may hide the background from accessibility without hiding it in the DOM.
    // Read its exact workspace identity; only() still requires a unique, visibly rendered button.
    const workspace = escape(this.config.workspaceName);
    const switcher = p.getByRole("button", { includeHidden: true,
      name: new RegExp(`^(?:(?:当前选择[：:]|Current selection:)\\s*${workspace}|选择全局设置、ChatGPT 工作空间或 Ads 账户。当前选择[：:]\\s*${workspace}，ChatGPT 工作空间)$`) });
    await only(switcher, "工作空间选择器");
  }
  async load(tab = "members") {
    this.listTab = tab;
    const p = await this.open();
    try { await p.goto(this.url(tab), { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch (error) {
      if (/Timeout|net::ERR_(TIMED_OUT|CONNECTION|NETWORK|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)/i.test(String(error)))
        throw new OfficialPageError("官方后台暂时无法连接，未开始成员操作。", "browser_unavailable",
          officialDiagnostic({stage:tab==='members'?'members_navigation':'invites_navigation',state:'network',expectedUrl:this.url(tab)}));
      throw error;
    }
    const selected = p.getByRole("tab", { name: tab === "members" ? ui.members : ui.invites });
    await waitForOfficialPage({
      ...this.readOnlyWaitControls,
      stage:tab==='members'?'members_navigation':'invites_navigation',challengeTimeoutMs:180_000,
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
    await this.waitForRows();
  }
  async waitForRows({requireOwner = false, ownerSeen = false} = {}) {
    const p = await this.open();
    const expectedTab = this.listTab ?? (new URL(p.url()).searchParams.get("tab") === "invites" ? "invites" : "members");
    let expectedTotal = null;
    // Table headers appear before the official data request has finished. A visible
    // table is not evidence of an empty list, including after pagination/filtering.
    await waitForOfficialPage({
      ...this.readOnlyWaitControls,
      stage:expectedTab==='members'?'members_rows':'invites_rows',challengeTimeoutMs:180_000,
      inspect: async () => {
        const selected = p.getByRole("tab", { name: expectedTab === "members" ? ui.members : ui.invites }).filter({ visible:true });
        const selectedCount = await selected.count();
        if (selectedCount > 1) throw new Error("目标成员标签页不唯一。");
        const active = selectedCount === 1 && await selected.getAttribute("aria-selected") === "true";
        const total = active ? (await selected.innerText()).trim().match(/(\d+)\s*$/) : null;
        expectedTotal = total ? Number(total[1]) : null;
        const tables = p.getByRole("table").filter({ visible: true });
        const count = await tables.count();
        if (count > 1) throw new Error("成员或邀请表不唯一；页面结构可能变化。");
        let ready = false;
        if (active && count === 1) {
          const busy = await tables.evaluate(el => !!el.closest('[aria-busy="true"]')) ||
            await tables.locator('[aria-busy="true"],[role="progressbar"]').filter({ visible: true }).count() > 0;
          const rows = await tables.getByRole("row").all();
          const cellRows = (await Promise.all(rows.map(row => row.getByRole("cell").allInnerTexts())))
            .filter(row => row.length);
          const cells = cellRows.map(row => row.join(" ").trim());
          const headers = (await tables.getByRole("columnheader").allInnerTexts()).map(text => text.trim());
          // The legacy invitation table has explicit Email / Invitation date columns.
          // The newer generic table shares member headers, so also verify row state below.
          const invitationHeaders = headers.some(text => /^(电子邮箱|邮箱|Email|Email address)$/i.test(text)) &&
            headers.some(text => /^(邀请日期|Invitation date|Invited on|Date invited)$/i.test(text));
          const invitedRows = cellRows.some(row => row.some(text => /^(已邀请|Invited|Pending invitation)$/i.test(text.trim())));
          const rowCount = cells.filter(text => text.includes("@")).length;
          const next = p.getByRole("button", { name:ui.next }).filter({ visible:true });
          if (await next.count() > 1) throw new Error("分页控件不唯一。");
          const hasNext = await next.count() === 1 && await next.isEnabled() && await next.getAttribute("aria-disabled") !== "true";
          const empty = await p.getByText(ui.empty).filter({ visible: true }).count() > 0;
          // Blank data rows are skeletons. Never ignore them beside already-loaded rows.
          ready = !busy && !cells.some(text => !text) &&
            (cells.some(text => text.includes("@")) || (empty && cells.every(text => ui.empty.test(text))));
          if (expectedTab === "members" && (invitationHeaders || invitedRows)) ready = false;
          if (expectedTotal !== null && (rowCount > expectedTotal || (rowCount === 0 && expectedTotal !== 0))) ready = false;
          if (expectedTab === "members" && requireOwner && ready) {
            const parsed = cellRows.filter(row => row.join(" ").includes("@")).map(row => parseRow(row, this.config.seatLabel));
            const marked = parsed.filter(row => row.self);
            const administrator = parsed.find(row => row.email === this.config.adminEmail);
            if (marked.some(row => row.email !== this.config.adminEmail || row.role !== "owner") ||
                (administrator && administrator.role !== "owner") || marked.length > 1)
              throw new OfficialPageError("页面中的当前账号不是指定 Owner。", "role_mismatch");
            // Do not substitute the first Owner. Wait for the exact configured account's own marker.
            if (administrator && !administrator.self) ready = false;
            if (!ownerSeen && !marked.length && !hasNext) ready = false;
          }
          if (expectedTab === "invites" && ready && cellRows.filter(row => row.join(" ").includes("@"))
            .some(row => {const parsed=parseRow(row,this.config.seatLabel);return parsed.self || parsed.role !== "member";})) ready = false;
        }
        return { url:p.url(), expectedUrl:this.url(), body:await p.locator("body").innerText(), ready };
      },
      pause: ms => p.waitForTimeout(ms), timeoutMs:25_000,
    });
    await this.guard();
    return {expectedTotal, expectedTab};
  }
  async capacity() {
    try { return await this.capacityOnce(); }
    catch (error) {
      if (!(error instanceof CapacityCardUnavailable)) throw error;
      // Navigate the existing official members page once; never click a retry
      // control or use partial lists as evidence. The normal snapshot checks
      // and two-read consistency verification remain mandatory afterwards.
      await this.guard();
      await this.load("members");
      return this.capacityOnce();
    }
  }
  async capacityOnce() {
    const p = await this.open(), label = `${this.config.seatLabel}席位`;
    let candidates = [];
    await waitForOfficialPage({
      ...this.readOnlyWaitControls,
      stage:'capacity',challengeTimeoutMs:180_000,
      inspect: async () => {
        candidates = await p.getByText(new RegExp(`^${escape(this.config.seatLabel)}(?:席位| seats)$`, "i"))
          .filter({ visible:true }).evaluateAll(nodes => {
            const cards = new Set();
            for (const node of nodes) {
              for (let i = 0, el = node; i < 5 && el; i++, el = el.parentElement) {
                if (el.querySelector("dl") && /已分配|Assigned/i.test(el.innerText) && /可用|Available/i.test(el.innerText)) {
                  cards.add(el); break;
                }
              }
            }
            return [...cards].map(card => card.innerText);
          });
        if (candidates.length > 1) throw new Error(`无法唯一确定${label}容量卡。`);
        const text = candidates[0] ?? "";
        const total = new RegExp(`(?:^|\\n)\\s*\\d+\\s*(?:\\n|\\s)+${escape(this.config.seatLabel)}(?:席位|\\s+seats)|${escape(this.config.seatLabel)}(?:席位|\\s+seats)\\s*\\d+`, "i");
        let ready = candidates.length === 1 && total.test(text) &&
          /(?:已分配|Assigned)\s*\d+/i.test(text) && /(?:可用|Available)\s*\d+/i.test(text);
        const body = await p.locator("body").innerText();
        // Only the exact visible capacity error and one visible retry control
        // qualify. Security challenges, ambiguous UI and another workspace do
        // not. An error banner makes even a visible old card untrustworthy.
        if (officialPageState({url:p.url(),expectedUrl:this.url(),body,ready:false}) === 'loading' &&
            new URL(p.url()).searchParams.get('tab') !== 'invites') {
          const messages = p.getByText(/^无法加载席位信息[。.]?$/).filter({visible:true});
          const noticeCount = await messages.count();
          if (noticeCount > 1) throw new Error('席位信息错误提示不唯一，未采纳容量。');
          if (noticeCount === 1) {
            ready = false;
            const buttons = p.getByRole('button',{name:/^(?:重试|Retry)$/i}).filter({visible:true});
            const buttonCount = await buttons.count();
            if (buttonCount > 1) throw new Error('席位信息重试控件不唯一，未采纳容量。');
            if (buttonCount === 1) { await this.guard(); throw new CapacityCardUnavailable(
              officialDiagnostic({stage:'capacity',state:'capacity_unavailable',expectedUrl:this.url()})); }
          }
        }
        return { url:p.url(), expectedUrl:this.url(), body, ready };
      },
      pause: ms => p.waitForTimeout(ms), timeoutMs:25_000,
    });
    await this.guard();
    return parseCapacity(candidates[0], this.config.seatLabel);
  }
  async rows({requireOwner = false} = {}) {
    const p = await this.open(), result = [], fingerprints = new Set();
    let expectedTotal = null;
    for (let index = 0; index < 100; index++) {
      await this.guard();
      const evidence = await this.waitForRows({requireOwner,
        ownerSeen:result.some(row => row.email === this.config.adminEmail && row.role === "owner" && row.self)});
      if (evidence.expectedTotal !== null) {
        if (expectedTotal !== null && expectedTotal !== evidence.expectedTotal)
          throw new OfficialPageError("读取期间成员或邀请总数发生变化，未采纳不完整名单。", "browser_unavailable");
        expectedTotal = evidence.expectedTotal;
      }
      const table = await only(p.getByRole("table"), "成员或邀请表");
      const records = await table.getByRole("row").all();
      const pageRows = [];
      for (const row of records) {
        const cells = await row.getByRole("cell").allInnerTexts();
        if (!cells.length) continue; // Column headers have no data cells.
        if (!cells.join(" ").includes("@")) {
          if (ui.empty.test(cells.join(" ").trim())) continue;
          throw new Error("成员数据行尚未完整加载或无法确定邮箱，未采纳部分名单。");
        }
        pageRows.push(parseRow(cells, this.config.seatLabel));
      }
      if (!pageRows.length) {
        const empty = p.getByText(ui.empty);
        if (!await empty.filter({ visible: true }).count()) throw new Error("空列表没有可信的加载完成状态。");
      }
      const fingerprint = JSON.stringify(pageRows);
      if (fingerprints.has(fingerprint)) throw new Error("分页重复，无法确认完整名单。");
      fingerprints.add(fingerprint); result.push(...pageRows);
      const next = p.getByRole("button", { name: ui.next }).filter({ visible: true });
      if (await next.count() > 1) throw new Error("分页控件不唯一。");
      if (!await next.count() || !await next.isEnabled() || await next.getAttribute("aria-disabled") === "true") {
        if (expectedTotal !== null && result.length !== expectedTotal)
          throw new OfficialPageError("完整列表与标签页显示总数不一致，未采纳不完整名单。", "browser_unavailable");
        return result;
      }
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
    const capacity = await this.capacity(), members = await this.rows({requireOwner:true});
    if (capacity.total !== this.config.totalSeats)
      throw new OfficialPageError("官方已购席位数量与配置不一致。", "capacity_mismatch");
    const me = members.filter(p => p.self);
    if (me.length !== 1 || me[0].email !== this.config.adminEmail || me[0].role !== "owner")
      throw new Error("页面中的当前账号不是指定 Owner。");
    await this.load("invites");
    const invites = await this.rows();
    // The Business seat card can account for pending invitations as assigned.
    // Verify only the two unambiguous interpretations; never infer a free seat
    // from a partial list or an unexplained count.
    if (![members.length, members.length + invites.length].includes(capacity.assigned))
      throw new InventoryMismatchError(capacity, members.length, invites.length);
    return {
      complete: true, workspaceId: this.config.workspaceId, workspaceName: this.config.workspaceName,
      accountEmail: me[0].email, totalSeats: capacity.total, seatLabel: this.config.seatLabel,
      members: members.map(p => ({ email: p.email, role: p.role, seatLabel: p.seatLabel })),
      invites: invites.map(p => ({ email: p.email, role: p.role, seatLabel: p.seatLabel })),
      observedAt: new Date().toISOString(), pageUrl: this.page.url()
    };
  }
  async observe({shouldStop,onProgress}={}) {
    const previous=this.readOnlyWaitControls;
    this.readOnlyWaitControls={shouldStop,onProgress};
    try { return await this.observeStable(); }
    finally { this.readOnlyWaitControls=previous; }
  }
  async observeStable() {
    // Validate each reading before comparing. A normal join can change two safe
    // snapshots; wrong identity, workspace or purchased capacity must still stop.
    const a = validateObservation(await this.snapshot(), this.config);
    const b = validateObservation(await this.snapshot(), this.config);
    const canonical = s => JSON.stringify({ totalSeats: s.totalSeats,
      members: s.members.slice().sort((x, y) => x.email.localeCompare(y.email)),
      invites: s.invites.slice().sort((x, y) => x.email.localeCompare(y.email)) });
    if (canonical(a) !== canonical(b))
      throw new OfficialPageError("两次完整快照发生变化，未采纳不稳定名单，稍后只读复核。", "browser_unavailable");
    return b;
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
    // Seat pickers also use role=dialog and remain visible during close animation.
    // Bind the invitation surface to its email field, not every dialog on the page.
    const dialog = await readyOnly(p.getByRole("dialog").filter({
      has: p.getByRole("textbox", { name: /电子邮箱|Email/i }) }), "邀请对话框");
    const invitationText = await dialog.innerText();
    // Current console uses the generic title "邀请团队成员". In that variant,
    // the exact URL and global workspace selector provide workspace identity.
    if (!invitationText.includes(this.config.workspaceName) &&
        invitationText.split(/\r?\n/)[0].trim() !== "邀请团队成员") throw new Error("邀请工作空间不匹配。");
    await this.guard();
    await (await only(dialog.getByRole("textbox", { name: /电子邮箱|Email/i }), "邀请邮箱")).fill(email);
    // Select the already-paid configured pool. Never change an existing member's seat.
    const seats = dialog.getByRole("combobox", { name: /席位类型|Seat type/i })
      .or(dialog.getByRole("button", { name: /席位类型|Seat type/i }));
    const seat = await only(seats, "席位类型选择器");
    if (!(await seat.innerText()).includes(this.config.seatLabel)) {
      await seat.click();
      await (await readyOnly(p.getByRole("option", { name: new RegExp(`^${escape(this.config.seatLabel)}(?:\\s|$)`) }), "已购席位类型")).click();
    }
    const role = dialog.getByRole("combobox", { name: /角色|Role/i })
      .or(dialog.getByRole("button", { name: /^(?:角色(?:类型)?|Role(?: type)?)(?:\s|$)/i }));
    const roleText = (await (await only(role, "邀请角色")).innerText()).replace(/角色类型|角色|Role type|Role/gi, "").trim();
    if (!/^(成员|Member)$/i.test(roleText)) throw new Error("只允许邀请普通成员。");
    if ((await seat.innerText()).replace(/席位类型|Seat type/gi, "").trim() !== this.config.seatLabel)
      throw new Error("最终席位类型未确认是已购席位，禁止发送。");
    const text = await dialog.innerText();
    if (/需要增加|需要购买|额外费用|add \d+ seats?|additional charge|purchase|buy seats/i.test(text))
      throw new Error("邀请将引起加购或费用变化，禁止继续。");
    if ((await dialog.getByRole("textbox", { name: /电子邮箱|Email/i }).inputValue()).trim().toLowerCase() !== email)
      throw new Error("邀请邮箱发生变化。");
    await this.guard();
    await this.onExternalAction("invite", email);
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
      await this.waitForRows();
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
    let stage='permission';
    try {
      this.permit(email, before);
      const original = presence(before, email); if (original === "absent") return;
      stage='load';
      await this.load(original === "member" ? "members" : "invites");
      stage='target_row';
      const p = this.page, row = await this.locateRow(email);
      const parsed = parseRow(await row.getByRole("cell").allInnerTexts(), this.config.seatLabel);
      if (parsed.email !== email || parsed.role !== "member" || parsed.self) throw new Error("目标身份或角色不安全。");
      stage='menu_open';
      await (await only(row.getByRole("button", { name: /打开.+的操作|Open .+ actions|Actions for/i }), "成员操作菜单")).click();
      // Some UI variants apply invite revocation directly from the menu. Mark the
      // outcome as potentially external before that click so an unexpected UI
      // transition cannot be recorded as an operation that never started.
      stage='menu_action';
      const menuAction = await readyOnly(p.getByRole("menuitem", {
        name: original === "member" ? ui.removeMenu : ui.revoke,
      }), "成员移除或撤销邀请菜单");
      await this.onExternalAction("remove", email);
      await menuAction.click();
      stage='confirmation_wait';
      const confirmName = original === "member" ? ui.removeConfirm : ui.revoke;
      const dialog = await readyOnly(p.getByRole("dialog").filter({
        has: p.getByRole("button", { name: confirmName }) }), "移除确认对话框");
      stage='confirmation_validate';
      const dialogText = await dialog.innerText();
      // The official dialog may show display name rather than email; retain exact row identity and workspace.
      if (!dialogText.includes(this.config.workspaceName)) throw new Error("移除确认的工作空间不匹配。");
      if (/删除数据|Delete data|permanently delete/i.test(dialogText)) throw new Error("检测到删除数据流程，禁止操作。");
      await this.guard();
      stage='confirmation_click';
      await (await only(dialog.getByRole("button", { name: confirmName }), "最终确认按钮")).click();
      if (original === "member") {
        const keep = p.getByRole("button", { name: ui.keepSeats });
        stage='retention_wait';
        // Closing the first dialog is not completion: the paid-seat retention
        // dialog can arrive later. Wait for its known control, never the empty
        // interval between dialogs, and never choose a purchase/reduction action.
        // A UI variant with no retention prompt fails closed here; core may only
        // reconcile it with fresh complete official evidence, without a re-click.
        await keep.filter({visible:true}).waitFor({state:'visible',timeout:25_000});
        stage='retention_validate';
        await this.guard();
        const keepControl=await only(keep,"保留付费席位");
        stage='retention_click';
        await keepControl.click();
      }
      stage='dialogs_closed';
      await p.waitForFunction(() => ![...document.querySelectorAll('dialog,[role="dialog"]')]
        .some(e => e.getClientRects().length), null, { timeout: 20_000 });
    } catch(error) {
      // Fixed diagnostic fields only. Preserve the original exception and its
      // failure policy; no page text, selectors, URLs, credentials, or messages.
      try {
        if(error && typeof error==='object' && Object.isExtensible(error))
          error.operationDiagnostic=Object.freeze({kind:'remove',stage,
            category:error.name==='TimeoutError'?'timeout':'other',observedAt:new Date().toISOString()});
      } catch { /* Diagnostics cannot replace the original operation failure. */ }
      throw error;
    }
  }
  async close() { if (this.context) await this.context.close(); this.context = null; this.page = null; }
}
