import { currentActor, readState } from "@/lib/portal-service";
import { runJobs } from "@/lib/jobs";
export const dynamic = "force-dynamic";

const tools = [
  {
    name: "seat_portal_status",
    description: "查看席位门户调度状态与待处理数量。仅门户管理员可以使用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "process_seat_queue",
    description: "按既定规则处理排队、到期状态和提醒；不会邀请或移除真实 ChatGPT 成员。仅门户管理员可以使用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return new Response("Cross-origin requests are not permitted.", { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json"))
    return new Response("JSON is required.", { status: 415 });
  let id: unknown = null;
  try {
    const raw = await request.text();
    if (raw.length > 8000) return new Response("Request too large", { status: 413 });
    const body = JSON.parse(raw);
    id = body.id ?? null;
    let result: unknown;
    if (body.method === "server/discover") {
      result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
        serverInfo: { name: "numems-seat-portal", version: "1.0.0" } };
    } else if (body.method === "initialize") {
      result = { protocolVersion: "2025-03-26", capabilities: { tools: {} },
        serverInfo: { name: "numems-seat-portal", version: "1.0.0" } };
    } else if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    } else if (body.method === "tools/list") {
      result = { tools };
    } else if (body.method === "tools/call") {
      const actor = await currentActor();
      if (!actor?.isAdmin) throw new Error("只有已登录的门户管理员可以运行此工具。");
      if (body.params?.name === "process_seat_queue") {
        result = { content: [{ type: "text", text: JSON.stringify(await runJobs()) }] };
      } else if (body.params?.name === "seat_portal_status") {
        const { state } = await readState();
        result = { content: [{ type: "text", text: JSON.stringify({
          requests: state.requests.length,
          pendingNotices: state.notices.filter(n => n.status === "pending").length,
          inventoryVerified: state.config.inventoryVerified,
          memberAdapter: "not_connected",
        }) }] };
      } else throw new Error("未知工具。");
    } else {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
    return Response.json({ jsonrpc: "2.0", id, result },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ jsonrpc: "2.0", id, result: {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : "操作失败。" }],
    } }, { headers: { "Cache-Control": "no-store" } });
  }
}
