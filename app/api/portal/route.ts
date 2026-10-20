import { currentActor, portalData, runCommand } from "@/lib/portal-service";

export const dynamic = "force-dynamic";
const allowed = new Set([
  "apply", "cancel", "release", "renew", "configure", "sync_inventory",
  "confirm_invited", "confirm_active", "confirm_removed", "tick",
]);
const privateHeaders = { "Cache-Control": "no-store", "Vary": "Cookie" };

export async function GET() {
  try { return Response.json(await portalData(), { headers: privateHeaders }); }
  catch { return Response.json({ error: "暂时无法读取数据，请稍后再试。" }, { status: 503, headers: privateHeaders }); }
}

export async function POST(request: Request) {
  try {
    // A session cookie must never authorize a cross-origin write.
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return Response.json({ error: "请从本站提交操作。" }, { status: 403 });
    const actor = await currentActor();
    if (!actor) return Response.json({ error: "请先登录。" }, { status: 401 });
    const raw = await request.text();
    if (raw.length > 32_000) return Response.json({ error: "提交内容过大。" }, { status: 413 });
    const command = JSON.parse(raw);
    if (!command || !allowed.has(command.type)) return Response.json({ error: "不支持的操作。" }, { status: 400 });
    await runCommand(actor, command);
    return Response.json(await portalData(), { headers: privateHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "操作未完成。" },
      { status: 400, headers: privateHeaders });
  }
}
