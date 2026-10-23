import { startOAuth } from "@/lib/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return startOAuth(request, "google");
}
