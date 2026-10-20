import { env } from "cloudflare:workers";
import { runJobs } from "@/lib/jobs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = env.PORTAL_WORKER_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`)
    return Response.json({ error: "调度凭据无效或尚未配置。" }, { status: 401 });
  try {
    return Response.json(await runJobs(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "调度未完成，请检查服务状态。" }, { status: 503 });
  }
}
