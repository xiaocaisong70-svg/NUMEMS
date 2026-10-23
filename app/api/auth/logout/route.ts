import { safeReturnTo } from "@/lib/oauth-flow";
import { serializeCookie } from "@/lib/oauth-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("return_to");
  const target = requested ? safeReturnTo(requested) : "/login";
  const headers = new Headers({
    Location: new URL(target, url.origin).toString(),
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    serializeCookie("portal_session", "", {
      maxAge: 0,
      secure: url.protocol === "https:",
    }),
  );
  return new Response(null, { status: 302, headers });
}
