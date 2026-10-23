import { env } from "cloudflare:workers";
import {
  decodeJson,
  encodeJson,
  pkceChallenge,
  randomToken,
  readCookie,
  serializeCookie,
  signSession,
  type OAuthTransaction,
} from "./oauth-session";

export type OAuthProvider = "google" | "microsoft";

type ProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  scope: string;
};

function providerConfig(provider: OAuthProvider): ProviderConfig {
  if (provider === "google")
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      scope: "openid email profile",
    };
  return {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    scope: "openid email profile User.Read",
  };
}

function siteOrigin(request: Request): string {
  return env.PUBLIC_ORIGIN?.replace(/\/+$/, "") || new URL(request.url).origin;
}

function redirect(request: Request, path: string, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: new URL(path, siteOrigin(request)).toString(),
    "Cache-Control": "no-store",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local") return "/";
    if (url.pathname === "/login" || url.pathname.startsWith("/api/auth")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function callbackUrl(request: Request, provider: OAuthProvider): string {
  return `${siteOrigin(request)}/api/auth/${provider}/callback`;
}

export async function startOAuth(
  request: Request,
  provider: OAuthProvider,
): Promise<Response> {
  const config = providerConfig(provider);
  if (!config.clientId || !config.clientSecret || !env.SESSION_SECRET)
    return redirect(request, "/login?error=not_configured");

  const url = new URL(request.url);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const transaction: OAuthTransaction = {
    state,
    verifier,
    returnTo: safeReturnTo(url.searchParams.get("return_to")),
    provider,
  };

  const transactionCookie = serializeCookie(
    "portal_oauth",
    encodeJson(transaction),
    { maxAge: 600, secure: url.protocol === "https:" },
  );

  const authorize = new URL(config.authorizeUrl);
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(request, provider));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", config.scope);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  if (provider === "google") authorize.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": transactionCookie,
      "Cache-Control": "no-store",
    },
  });
}

export async function finishOAuth(
  request: Request,
  provider: OAuthProvider,
): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const clearCookie = serializeCookie("portal_oauth", "", { maxAge: 0, secure });
  const failure = (code: string) => redirect(request, `/login?error=${code}`, [clearCookie]);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state) return failure("oauth_failed");

  const transaction = decodeJson<OAuthTransaction>(
    readCookie(request.headers.get("cookie"), "portal_oauth") ?? "",
  );
  if (
    !transaction ||
    transaction.provider !== provider ||
    transaction.state !== state ||
    !transaction.verifier
  )
    return failure("state_mismatch");

  const config = providerConfig(provider);
  if (!config.clientId || !config.clientSecret || !env.SESSION_SECRET)
    return failure("not_configured");

  let tokens: { access_token?: string };
  try {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: transaction.verifier,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl(request, provider),
      }),
    });
    tokens = (await response.json()) as { access_token?: string };
    if (!response.ok || !tokens.access_token) return failure("token_failed");
  } catch {
    return failure("token_failed");
  }

  let profile: { email?: string; email_verified?: boolean | string; name?: string; preferred_username?: string };
  try {
    const response = await fetch(config.userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!response.ok) return failure("profile_failed");
    profile = (await response.json()) as typeof profile;
  } catch {
    return failure("profile_failed");
  }

  if (provider === "microsoft" && !profile.email)
    profile.email =
      (await microsoftEmail(tokens.access_token)) || profile.preferred_username;

  const email = profile.email?.trim().toLowerCase();
  const verified =
    provider === "google"
      ? profile.email_verified === true || profile.email_verified === "true"
      : true;
  if (!email || !email.includes("@") || !verified) return failure("email_unverified");

  const session = await signSession(
    {
      email,
      name: profile.name?.trim() || null,
      provider,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    },
    env.SESSION_SECRET,
  );

  return redirect(request, safeReturnTo(transaction.returnTo), [
    clearCookie,
    serializeCookie("portal_session", session, {
      maxAge: 7 * 24 * 60 * 60,
      secure,
    }),
  ]);
}

async function microsoftEmail(accessToken: string | undefined): Promise<string | undefined> {
  if (!accessToken) return undefined;
  try {
    const response = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) return undefined;
    const profile = (await response.json()) as { mail?: string; userPrincipalName?: string };
    return profile.mail || profile.userPrincipalName;
  } catch {
    return undefined;
  }
}
