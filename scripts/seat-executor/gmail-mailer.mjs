import { AppServerClient } from "../app-server-client.mjs";
import { root } from "./config.mjs";

export function reminderText(notice, expiry, siteUrl) {
  const url = new URL(siteUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash ||
      url.username || url.password ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiry) ||
      !Number.isFinite(Date.parse(expiry)) ||
      !/^[A-Za-z0-9_-]{5,200}$/.test(notice?.id ?? "") ||
      typeof notice?.title !== "string" || !notice.title.trim() ||
      notice.title.length > 120 || /[\r\n]/.test(notice.title))
    throw new Error("提醒截止时间、通知标识、标题或门户地址无效。");
  return {
    subject: `${notice.title} [NUMEMS:${notice.id}]`,
    text: `你的 ChatGPT Business 席位即将到期。\n截止时间（UTC）：${expiry}\n续期：${url.origin}/\n如已续期，请以网页当前截止时间为准。`,
  };
}

// The connected Gmail app is a transport, not a Codex turn. No model is run.
// If sending is ambiguous, the caller isolates the notice and never retries.
export class GmailConnectorMailer {
  constructor(config) { this.config = config; }
  async send(notice, expiry) {
    if (!this.config.codexCli) throw new Error("尚未配置无模型 Gmail 连接器。");
    const { subject, text } = reminderText(notice, expiry, this.config.siteUrl);
    const cleanEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(CODEX|OPENAI|MCP|CXX|RUST)/i.test(key)));
    const client = new AppServerClient(this.config.codexCli, { cwd: root, env: cleanEnv });
    let interactive = false;
    client.on("interactiveRequest", () => { interactive = true; });
    try {
      await client.initialize();
      const session = await client.createToolSession(root);
      const result = await client.connector(session, "gmail.send_email", {
        to: notice.email, subject,
        payload: { mime_type: "text/plain", charset: "UTF-8", body: { content: text } },
        response_fields: ["id"],
      });
      if (interactive) throw new Error("Gmail 连接器要求人工授权。");
      const id = result?.id ?? result?.message_id ?? result?.message?.id;
      if (!/^[a-zA-Z0-9_-]{5,200}$/.test(id ?? ""))
        throw new Error("Gmail 未返回可核对的消息 ID。");
      return id;
    } finally { await client.close(); }
  }
}
