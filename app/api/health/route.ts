import { readState } from "@/lib/portal-service";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await readState();
    return Response.json({ ok: true, storage: "ready", memberAdapter: "not_connected" },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, storage: "unavailable" }, { status: 503 });
  }
}
