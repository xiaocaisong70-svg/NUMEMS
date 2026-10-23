import { env } from "cloudflare:workers";

export type CloudflareAccessUser = {
  userId: string;
  email: string;
};

type AccessClaims = {
  email?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iss?: string;
};

type AccessHeader = {
  kid?: string;
  alg?: string;
};

type AccessJwk = JsonWebKey & { kid?: string };

const KEY_CACHE_MS = 5 * 60_000;
const keyCache = new Map<string, { expiresAt: number; keys: AccessJwk[] }>();

function base64UrlToBytes(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return buffer;
}

function decodeSegment<T>(value: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
  } catch {
    return null;
  }
}

async function loadKeys(teamDomain: string): Promise<AccessJwk[]> {
  const cached = keyCache.get(teamDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(new URL("/cdn-cgi/access/certs", teamDomain), {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`Cloudflare Access 公钥获取失败（HTTP ${response.status}）。`);

  const body = (await response.json()) as { keys?: AccessJwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0)
    throw new Error("Cloudflare Access 公钥列表为空。");

  keyCache.set(teamDomain, { keys: body.keys, expiresAt: Date.now() + KEY_CACHE_MS });
  return body.keys;
}

/**
 * 校验 Cloudflare Access 签发的 JWT，并返回已验证的邮箱。
 * 未配置 CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD，或校验失败时返回 null。
 */
export async function getCloudflareAccessUser(
  assertion: string | null,
): Promise<CloudflareAccessUser | null> {
  if (!assertion) return null;

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "");
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !audience) return null;

  const parts = assertion.split(".");
  if (parts.length !== 3) return null;

  const header = decodeSegment<AccessHeader>(parts[0]);
  const claims = decodeSegment<AccessClaims>(parts[1]);
  if (!header || !claims || !header.kid || header.alg !== "RS256") return null;

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return null;
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
  if (claims.iss && claims.iss.replace(/\/+$/, "") !== teamDomain) return null;

  const email = claims.email?.trim().toLowerCase();
  if (!email) return null;

  const keys = await loadKeys(teamDomain);
  const jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  return { userId: `cf-access:${claims.sub?.trim() || email}`, email };
}
