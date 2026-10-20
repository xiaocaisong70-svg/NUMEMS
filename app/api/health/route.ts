import { readState } from "@/lib/portal-service";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await readState();
    return Response.json({ ok: true, variant: "numems-original-v1", faultIsolationVersion: 1, storage: "ready" },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, storage: "unavailable" }, { status: 503 });
  }
}
