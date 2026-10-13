import { formatTag } from "@/lib/logs/tag";

/**
 * An uncaught server error, as `onRequestError` sees it, printed as one tagged line
 * (`tag.ts`) with the stack under it. The drain stores it in `platform_logs` with the user it
 * happened to. Vercel's own lines carry no identity, so this is the only error line that
 * names one.
 *
 * The user comes from the Supabase auth cookie the request carried. The access token's `sub`
 * is decoded locally, with no network call and no signature check. That is enough to attribute
 * a log line. It is never used to authorize anything.
 */

export interface RequestErrorInput {
  error: unknown;
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> };
  context: { routePath?: string; routeType?: string };
}

export function requestErrorLine(input: RequestErrorInput): string {
  const { error, request, context } = input;
  const err = error instanceof Error ? error : null;
  const digest =
    typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : null;
  const route = `${context.routeType ?? "request"} ${context.routePath ?? request.path}${digest ? ` [digest ${digest}]` : ""}`;
  const body = err ? (err.stack ?? `${err.name}: ${err.message}`) : String(error);
  const user = userIdFromCookieHeader(headerValue(request.headers, "cookie"));
  return formatTag({ k: "error", user, route }, body);
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v || null;
}

const AUTH_COOKIE = /^sb-[^=]+-auth-token(?:\.(\d+))?$/;

/**
 * The signed-in user's id from a raw `cookie` header, or null. Supabase SSR stores the session
 * as `sb-<ref>-auth-token`. It may be split into `.0`, `.1`, ... chunks, and it is either raw
 * JSON or `base64-` followed by base64url JSON.
 */
export function userIdFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const chunks = new Map<number, string>();
  let whole: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const m = AUTH_COOKIE.exec(part.slice(0, eq).trim());
    if (!m) continue;
    const value = part.slice(eq + 1).trim();
    if (m[1] === undefined) whole = value;
    else chunks.set(Number(m[1]), value);
  }
  const raw =
    whole ??
    (chunks.size
      ? [...chunks.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v)
          .join("")
      : null);
  if (!raw) return null;
  try {
    let text = decodeURIComponent(raw);
    if (text.startsWith("base64-")) text = Buffer.from(text.slice(7), "base64url").toString("utf8");
    const session = JSON.parse(text) as unknown;
    const token = Array.isArray(session)
      ? session[0]
      : (session as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== "string") return null;
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && UUID.test(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
