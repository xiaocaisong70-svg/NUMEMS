import Portal from "./portal";
import { portalData } from "@/lib/portal-service";
export const dynamic = "force-dynamic";
export default async function Home() {
  let data;
  try { data = await portalData(); }
  catch { data = { user: null, access: "unavailable" as const, view: null }; }
  return <Portal initialData={data} />;
}
