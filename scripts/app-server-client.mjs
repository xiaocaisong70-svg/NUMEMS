import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

// Protocol client only: initialize and MCP/queue calls do not run inference.
export class AppServerClient extends EventEmitter {
  constructor(cli, { cwd, env = process.env, timeoutMs = 60_000 } = {}) {
    super();
    this.pending = new Map(); this.sequence = 0; this.timeoutMs = timeoutMs;
    this.child = spawn(cli, ["app-server"], { cwd, env, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 20_000_000) { this.close(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        const pending = this.pending.get(message.id);
        if (pending && !message.method) {
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        } else if (message.method && message.id !== undefined) {
          // The checker cannot grant permissions or answer human approvals.
          this.emit("interactiveRequest", message.method);
          this.child.stdin.write(JSON.stringify({ id: message.id, error: {
            code: -32601, message: "Queue checker cannot approve interactive actions.",
          } }) + "\n");
        }
      }
    });
    // Never log server stderr: it can contain private connector metadata.
    this.child.stderr.resume();
    this.child.on("error", () => this.fail("Codex App Server could not start."));
    this.child.on("exit", () => this.fail("Codex App Server connection closed."));
  }
  fail(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error(message));
    }
    this.pending.clear();
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out; result may be unknown.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error("App Server request failed."));
      });
    });
  }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "numems_queue_checker",
      title: "NUMEMS deterministic queue checker", version: "1.0.0" },
      capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  async createToolSession(cwd) {
    const result = await this.request("thread/start", { cwd, ephemeral: true });
    return result.thread.id;
  }
  async portal(toolThreadId, tool, args = {}) {
    const result = await this.request("mcpServer/tool/call", { threadId: toolThreadId,
      server: "codex_apps", tool: `numems.${tool}`, arguments: args });
    if (result.isError) throw new Error(`NUMEMS ${tool} was rejected.`);
    const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("");
    try { return JSON.parse(text); } catch { throw new Error(`NUMEMS ${tool} returned invalid data.`); }
  }
  async connector(toolThreadId, tool, args = {}) {
    const result = await this.request("mcpServer/tool/call", { threadId: toolThreadId,
      server: "codex_apps", tool, arguments: args });
    if (result.isError) throw new Error(`Connected app ${tool} rejected the request.`);
    const value = result.structuredContent ?? result.content?.find(item => item.type === "text")?.text;
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { throw new Error(`Connected app ${tool} returned invalid data.`); }
  }
  async queued(threadId) {
    const entries = []; let cursor;
    do {
      const page = await this.request("thread/queue/list", { threadId, limit: 100,
        ...(cursor ? { cursor } : {}) });
      entries.push(...page.data); cursor = page.nextCursor;
      if (entries.length > 1000) throw new Error("Too many queued messages; review required.");
    } while (cursor);
    return entries;
  }
  enqueue(threadId, clientUserMessageId, text) {
    return this.request("thread/queue/add", { threadId, clientUserMessageId,
      input: [{ type: "text", text }] });
  }
  async close() {
    this.fail("App Server client stopped.");
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
