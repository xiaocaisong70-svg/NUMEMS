// 只通过管理员已登录的浏览器会话调用本项目自带的 /api/codex 路由。
// 不复制 Cookie、不伪造身份头、不调用任何私有接口，也不依赖 Codex。
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const allowedTools = new Set([
  "process_seat_queue", "seat_portal_status", "observe_workspace",
  "claim_seat_operation", "complete_seat_operation", "defer_seat_operation",
  "review_seat_failure", "record_codex_schedule",
]);

export class TraePortalClient {
  constructor(config) {
    this.config = config;
    this.sequence = 0;
    this.context = null;
    this.page = null;
  }

  async open() {
    if (this.page) return this.page;
    await mkdir(this.config.profile, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.config.profile, {
      headless: this.config.headless,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      acceptDownloads: false,
      ...(this.config.browserChannel ? { channel: this.config.browserChannel } : {}),
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(15_000);
    const origin = new URL(this.config.siteUrl).origin;
    if (new URL(this.page.url()).origin !== origin)
      await this.page.goto(this.config.siteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const identity = await this.page.evaluate(async () => {
      const response = await fetch("/api/portal", { cache: "no-store", credentials: "same-origin" });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
    });
    if (identity.status !== 200 || identity.body?.access !== "allowed" ||
        identity.body?.user?.email?.toLowerCase() !== this.config.adminEmail)
      throw new Error(`门户管理员登录失效或身份不符（HTTP ${identity.status}，access=${identity.body?.access ?? "unknown"}）；请先运行 scripts/trae/login.mjs。`);
    return this.page;
  }

  async call(name, args = {}) {
    if (!allowedTools.has(name)) throw new Error("执行器不允许调用该门户操作。");
    const page = await this.open();
    const body = { jsonrpc: "2.0", id: ++this.sequence,
      method: "tools/call", params: { name, arguments: args } };
    const result = await page.evaluate(async requestBody => {
      const response = await fetch("/api/codex", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody),
      });
      return { status: response.status, body: await response.json() };
    }, body);
    if (result.status !== 200 || result.body?.id !== body.id ||
        result.body?.result?.isError || result.body?.error)
      throw new Error(`门户 ${name} 未能确认执行结果；不得盲目重试。`);
    const text = result.body.result?.content?.find(item => item.type === "text")?.text;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`门户 ${name} 返回非预期回执；不得盲目重试。`);
    }
  }

  async close() {
    if (this.context) await this.context.close();
    this.context = null;
    this.page = null;
  }
}
