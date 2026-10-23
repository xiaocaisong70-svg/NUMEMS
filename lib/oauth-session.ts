const textEncoder = new TextEncoder();

export type PortalSession = {
  email: string;
  name: string | null;
  provider: "google" | "microsoft";
  exp: number;
};

export type OAuthTransaction = {
  state: string;
  verifier: string;
  returnTo: string;
  provider: "google" | "microsoft";
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function encodeJson(value: unknown): string {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)));
}

export function decodeJson<T>(value: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
  } catch {
    return null;
  }
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(data));
  return bytesToBase64Url(new Uint8Array(signature));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function signSession(
  session: PortalSession,
  secret: string,
): Promise<string> {
  const payload = encodeJson(session);
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifySession(
  token: string,
  secret: string,
): Promise<PortalSession | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!timingSafeEqual(await sign(secret, payload), signature)) return null;

  const session = decodeJson<PortalSession>(payload);
  if (!session || typeof session.email !== "string" || !session.email.includes("@"))
    return null;
  if (session.provider !== "google" && session.provider !== "microsoft") return null;
  if (!Number.isFinite(session.exp) || session.exp <= Math.floor(Date.now() / 1000))
    return null;
  return session;
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToBase64Url(buffer);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return null;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; secure?: boolean; path?: string } = {},
): string {
  let cookie = `${name}=${value}; Path=${options.path ?? "/"}; SameSite=Lax; HttpOnly`;
  if (options.secure) cookie += "; Secure";
  if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
  return cookie;
}
