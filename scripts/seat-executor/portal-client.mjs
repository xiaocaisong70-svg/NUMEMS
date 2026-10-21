// Calls only this project's existing administrator-gated /api/codex route.
// The Sites front door supplies the signed-in ChatGPT identity; this client
// neither copies cookies nor accepts caller-supplied identity headers.
export class PortalClient {
  constructor(context, config) {
    this.context = context;
    this.config = config;
    this.sequence = 0;
  }

  async open() {
    if (!this.page) this.page = await this.context.newPage();
    if (new URL(this.page.url()).origin !== new URL(this.config.siteUrl).origin)
      await this.page.goto(this.config.siteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const identity = await this.page.evaluate(async () => {
      const response = await fetch("/api/portal", { cache: "no-store", credentials: "same-origin" });
      return { status: response.status, body: await response.json() };
    });
    if (identity.status !== 200 || identity.body.access !== "allowed" ||
        identity.body.user?.email?.toLowerCase() !== this.config.adminEmail)
      throw new Error("门户管理员登录失效或身份不符，执行器已停止。");
    return this.page;
  }

  async call(name, args = {}) {
    const allowed = new Set(["process_seat_queue", "seat_portal_status", "observe_workspace",
      "claim_seat_operation", "complete_seat_operation", "defer_seat_operation",
      "record_codex_schedule"]);
    if (!allowed.has(name)) throw new Error("执行器不允许调用该门户操作。");
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
    const content = result.body.result?.content?.find(item => item.type === "text")?.text;
    try { return JSON.parse(content); }
    catch { throw new Error(`门户 ${name} 返回非预期回执；不得盲目重试。`); }
  }
}

export class UnavailableOfficialMemberApi {
  constructor({ verified = false } = {}) { this.verified = verified; }
  async probe() { return { available: false, reason: "当前 Business 工作空间未验证官方成员管理 API、权限和 Admin 凭据。" }; }
  async observe() { throw new Error("官方成员管理 API 尚不可用。"); }
  async invite() { throw new Error("官方成员管理 API 尚不可用。"); }
  async revokeInvite() { throw new Error("官方成员管理 API 尚不可用。"); }
  async remove() { throw new Error("官方成员管理 API 尚不可用。"); }
}
