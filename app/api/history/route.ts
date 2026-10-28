import { portalHistory } from "@/lib/portal-service";
import { PortalAccessError } from "@/lib/portal-access";
import type { HistoryKind } from "@/lib/history-policy";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Vary": "Cookie" };
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const kind = (url.searchParams.get("kind") ?? "request") as HistoryKind;
    const value = await portalHistory(kind, url.searchParams.get("cursor"), Number(url.searchParams.get("limit") ?? 50));
    return Response.json(value, { status: value.access === "signin_required" ? 401 : value.access === "not_authorized" ? 403 : 200, headers });
  } catch (error) {
    if (error instanceof PortalAccessError) return Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: "无法读取历史记录，请检查查询参数或稍后重试。" }, { status: 400, headers });
  }
}
