import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Secrets for cloud connections, keyed off ONE env value, `CLOUD_TOKEN_KEY`
 * (32 random bytes, base64). Two independent subkeys are derived from it with
 * HKDF so the token cipher and the OAuth state signature never share a key:
 *
 *  - `sealToken` / `openToken`: AES-256-GCM for refresh and access tokens at
 *    rest. The key lives only in the environment, never in the database, so a
 *    dump of `cloud_connection_secrets` alone is useless.
 *  - `signState` / `verifyState`: an HMAC-signed, expiring payload for the
 *    OAuth `state` cookie, binding the round trip to the user and org that
 *    started it.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function masterKey(): Buffer {
  const raw = process.env.CLOUD_TOKEN_KEY;
  if (!raw) throw new Error("CLOUD_TOKEN_KEY is not set.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CLOUD_TOKEN_KEY must be 32 bytes, base64-encoded.");
  }
  return key;
}

function subkey(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey(), Buffer.alloc(0), info, 32));
}

/** Encrypt a token for storage: base64(iv | tag | ciphertext). */
export function sealToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", subkey("wildcat-cloud-token-v1"), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Decrypt a stored token. Throws on a wrong key or any tampering. */
export function openToken(sealed: string): string {
  const buf = Buffer.from(sealed, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed token is truncated.");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", subkey("wildcat-cloud-token-v1"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function stateMac(body: string): Buffer {
  return createHmac("sha256", subkey("wildcat-cloud-state-v1")).update(body).digest();
}

/**
 * Sign a payload for the OAuth state cookie, valid for `ttlSeconds`.
 * Format: base64url(json) "." base64url(hmac).
 */
export function signState<T extends object>(payload: T, ttlSeconds: number, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds })
  ).toString("base64url");
  return `${body}.${stateMac(body).toString("base64url")}`;
}

/** The signed payload, or null when the signature is wrong or it has expired. */
export function verifyState<T extends object>(token: string | undefined | null, now = Date.now()): T | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = stateMac(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: (T & { exp?: number }) | null = null;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.exp !== "number" || parsed.exp < Math.floor(now / 1000)) {
    return null;
  }
  return parsed;
}
