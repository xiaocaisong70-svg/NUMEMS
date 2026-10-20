import Portal from "./portal";
import { portalData } from "@/lib/portal-service";
export const dynamic = "force-dynamic";
export default async function Home() {
  let data;
  try { data = await portalData(); }
  catch { data = { user: null, view: null, connection: { memberAdapter: "not_connected", scheduler: false, mail: false }, error: "数据库尚未就绪。可先查看演示；真实申请将在部署完成后启用。" }; }
  return <Portal initialData={data} />;
}
