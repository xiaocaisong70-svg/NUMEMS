"use client";
import { useEffect } from "react";

const operations = ["seat_portal_status", "process_seat_queue", "observe_workspace",
  "prepare_test_request", "claim_seat_operation", "complete_seat_operation",
  "release_test_request", "set_test_deadline", "set_codex_live", "record_codex_schedule"];
type Registry = { registerTool(tool: {
  name: string; description: string; inputSchema: object;
  execute(input: unknown): unknown | Promise<unknown>;
}, options?: { signal?: AbortSignal }): void | Promise<void> };

export function useCodexTools<T>(enabled: boolean, update: (data: T) => void) {
  useEffect(() => {
    if (!enabled) return;
    const registry = (document as Document & { modelContext?: Registry }).modelContext;
    if (!registry?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(registry.registerTool({
      name: "portal_codex_action",
      description: "管理员席位自动化工具。operation必须是已列出的门户操作；arguments须遵守站点MCP契约。操作仅更新门户记录，真实成员动作由官方后台完成后提交证据。",
      inputSchema: { type: "object", properties: {
        operation: { type: "string", enum: operations },
        arguments: { type: "object" },
      }, required: ["operation", "arguments"], additionalProperties: false },
      async execute(input: unknown) {
        const value = input as { operation?: string; arguments?: Record<string, unknown> };
        if (!value || !operations.includes(value.operation ?? "") || !value.arguments ||
            typeof value.arguments !== "object" || Array.isArray(value.arguments))
          throw new Error("自动化工具参数无效。");
        const response = await fetch("/mcp", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
            params: { name: value.operation, arguments: value.arguments } }),
        });
        const body = await response.json() as { result?: { isError?: boolean; content?: {text?: string}[] }; error?: unknown };
        if (!response.ok || body.error || body.result?.isError)
          throw new Error(body.result?.content?.[0]?.text || "门户操作未完成。");
        const data = await fetch("/api/portal", { cache: "no-store" });
        if (data.ok) update(await data.json() as T);
        return body.result;
      },
    }, { signal: lifecycle.signal })).catch(() => { /* Normal UI stays usable. */ });
    return () => lifecycle.abort();
  }, [enabled, update]);
}
