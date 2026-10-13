/**
 * Bearer-token auth for non-browser clients.
 *
 * The web app authenticates with Supabase session cookies. The tablet app
 * (`wildcat_mobile`) has no cookie jar — it holds the user's Supabase session
 * itself and sends `Authorization: Bearer <access token>` on every call to our
 * API routes.
 *
 * Rather than thread a `Request` through every auth helper, the token is read
 * from the ambient request here and consumed by `getSupabaseServer()` (which
 * binds the client to it) and `getSessionUser()` (which validates it). That
 * makes every existing route bearer-capable without changing its signature —
 * `forbidUnlessPermitted()`, `gateAI()`, and RLS-scoped queries all resolve the
 * same user either way.
 */

/**
 * The bearer token on the incoming request, or null when there isn't one
 * (browser requests, server components, static generation).
 *
 * `next/headers` is imported lazily for the same reason `getSupabaseServer()`
 * does it: keeping it out of the static module graph so modules that also
 * export values used by client components don't pull it into client bundles.
 */
export async function getBearerToken(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const raw = (await headers()).get("authorization");
    if (!raw) return null;
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
    return match?.[1]?.trim() || null;
  } catch {
    // `headers()` throws outside a request scope (e.g. static generation).
    // No request means no bearer token; fall back to the cookie session.
    return null;
  }
}

/**
 * The org the caller names, or null.
 *
 * The phone mirrors every org a member belongs to and sends `x-org-id` on each
 * request to say which one it means; `current_org_id()` honours the header
 * (`2026091400100_org_header.sql`), so the client built by `getSupabaseServer()`
 * has to carry it through to PostgREST. Read here, next to the bearer token, for
 * the same reason: the ambient request, not a `Request` threaded through every
 * helper. The web never sends it.
 */
export async function getRequestOrgId(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const raw = (await headers()).get("x-org-id");
    return raw?.trim() || null;
  } catch {
    return null;
  }
}
