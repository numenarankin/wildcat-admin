import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseUrl } from "@/lib/env";
import { getBearerToken, getRequestOrgId } from "@/lib/supabase/from-request";

/**
 * Request-scoped Supabase client bound to the signed-in user's session.
 *
 * Uses the **publishable** (anon) key + the user's JWT, so every query runs as
 * that user and **Row Level Security applies**. This is the default client for
 * all data access (server components, server actions, route handlers).
 *
 * Created fresh per call — never cached — because the session differs per
 * request. (Do NOT memoize it here: this module is transitively imported by
 * client components for its types/constants, so it must not pull in
 * `server-only` or `node:async_hooks`. Aggregations that want one shared client
 * create it once and pass it down.)
 *
 * The JWT comes from one of two places, in order:
 *
 * 1. An `Authorization: Bearer <token>` header, used by the tablet app, which
 *    holds its own Supabase session and has no cookie jar. Checked first so an
 *    explicit token always wins over any cookies that happen to be present.
 * 2. The request's session cookies, used by the web app.
 *
 * Both paths produce a client with the same RLS scoping, so callers never need
 * to know which one authenticated the request.
 */
/**
 * The `fetch` every client made here issues its requests through when the
 * caller passes none. Registered by `@/lib/supabase/request-client` at import
 * so the request timeline sees EVERY Supabase call a render makes, not only the
 * ones through the shared client. `/leases` spent 1.8s of a 3.5s render in
 * reads the timeline could not show because they went through clients built
 * here directly. Registration rather than an import: this module is reachable
 * from client bundles and must not pull in `server-only` or `node:async_hooks`.
 */
let defaultFetch: typeof fetch | undefined;
export function setDefaultSupabaseFetch(f: typeof fetch): void {
  defaultFetch = f;
}

export async function getSupabaseServer(
  /**
   * Optional `fetch` for the client to issue its requests through. Exists so the
   * perf probe can time the wire without this module importing `server-only` or
   * `node:async_hooks` (see the note above about client bundles). Omitted
   * everywhere except `@/lib/supabase/request-client` under `PERF_LOG=1`.
   */
  fetchImpl?: typeof fetch
): Promise<SupabaseClient> {
  fetchImpl ??= defaultFetch;
  const url = getSupabaseUrl();
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured: set SUPABASE_PROJECT_ID and SUPABASE_PUBLISHABLE_KEY in .env"
    );
  }

  // Bearer path: bind the client to the caller's token. `persistSession` and
  // `autoRefreshToken` are off because there is no storage to persist into and
  // no session to refresh — the client owns its token and sends a fresh one.
  const bearer = await getBearerToken();
  if (bearer) {
    // The org the phone means, forwarded so `current_org_id()` sees it on
    // every query this client makes (`from-request.ts`, `getRequestOrgId`).
    const orgId = await getRequestOrgId();
    return createClient(url, key, {
      global: {
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(orgId ? { "x-org-id": orgId } : {}),
        },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  // Imported lazily so `next/headers` never enters the STATIC module graph.
  // Several data modules that import this file also export constants/types used
  // by client components; a top-level `next/headers` import would poison those
  // client bundles. getSupabaseServer is only ever CALLED on the server.
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` is called from a Server Component where cookies are
          // read-only. Safe to ignore — Proxy refreshes the session cookie.
        }
      },
    },
  });
}

/**
 * Server-only Supabase client using the **secret** (service-role) key.
 *
 * The secret key **bypasses Row Level Security**, so it must ONLY be used for
 * privileged operations that legitimately need to: account creation on sign-up,
 * org provisioning, referral-code lookup, and validating/accepting member
 * invites. Never use it for normal user data access — use `getSupabaseServer()`
 * so RLS enforces ownership.
 */
let cachedAdmin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  const url = getSupabaseUrl();
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error(
      "Supabase is not configured: set SUPABASE_PROJECT_ID and SUPABASE_SECRET_KEY in .env"
    );
  }
  cachedAdmin ??= createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAdmin;
}
