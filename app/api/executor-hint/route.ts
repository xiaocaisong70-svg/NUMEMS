import { readState } from "@/lib/portal-service";
export const dynamic = "force-dynamic";

// 供本地执行器做「有无待办」预检，避免空闲时启动浏览器。
// 只返回数量，不含任何邮箱、成员或申请细节。
const PENDING = ["queued", "pending_invite", "invited", "pending_removal"];

export async function GET() {
  const { state } = await readState();
  const pending = (state.requests ?? []).filter(item => PENDING.includes(item.status)).length;
  return Response.json({ pending }, { headers: { "Cache-Control": "no-store" } });
}
