import type { User } from "@supabase/supabase-js";
import { memoRender } from "@/lib/cache/render-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getBearerToken } from "@/lib/supabase/from-request";

/**
 * The signed-in user, or null. Reads the session from the request — cookies for
 * the web app, an `Authorization: Bearer` token for the tablet app.
 *
 * `getUser()` (not `getSession()`) re-validates the JWT against Supabase Auth,
 * so this is safe to trust on the server. The bearer token is passed explicitly
 * because the client has no stored session to read it from; `getUser(jwt)` hits
 * the Auth server the same way, so a forged or expired token yields null rather
 * than a trusted user.
 */
export function getSessionUser(): Promise<User | null> {
  // Memoized for the whole render, so the layout and the page share ONE Auth
  // round trip instead of one each (see `memoRender`). Within a subtree it also
  // covers the four callers the layout makes directly and through getProfile /
  // getCurrentPermissions / hasEarlyAccess.
  return sessionUser();
}

const sessionUser = memoRender("session-user", loadSessionUser);

async function loadSessionUser(): Promise<User | null> {
  const sb = await getSupabaseServer();
  const bearer = await getBearerToken();
  const {
    data: { user },
  } = bearer ? await sb.auth.getUser(bearer) : await sb.auth.getUser();
  return user ?? null;
}

/**
 * Hard auth gate for server code (server actions, page/layout loaders). Returns
 * the user or redirects to /auth. This is the real boundary; Proxy only does
 * the cheap optimistic redirect.
 */
export async function requireUser(): Promise<User> {
  const user = await getSessionUser();
  if (user) return user;
  // Lazy import so this module doesn't pull `next/navigation` into the static
  // graph (its app-router context calls React.createContext, unavailable under
  // the `react-server` condition our unit tests load with).
  const { redirect } = await import("next/navigation");
  redirect("/auth");
  // `redirect` throws to perform the navigation, so this never runs — it just
  // proves to the type checker that this branch doesn't fall through.
  throw new Error("unreachable");
}

/**
 * Server-action guard: throws unless someone is signed in.
 *
 * The throwing sibling of {@link requireUser}. A server action must NOT redirect
 * — the caller is a fetch from an already-rendered page, and a redirect there
 * surfaces as an opaque failure rather than a navigation — so this raises a
 * message the client can show instead.
 */
export async function assertSignedIn(): Promise<User> {
  const user = await getSessionUser();
  if (user) return user;
  throw new Error("Sign in required.");
}

/**
 * API-route guard. Returns a 401 when nobody is signed in, or `null` when the
 * request may proceed:
 *
 *   const denied = await forbidUnlessSignedIn();
 *   if (denied) return denied;
 *
 * Scout's routes need this and not a capability check. They read PUBLIC state
 * records — the Texas RRC's own filings — so there is no per-tenant row to
 * protect and no capability that means "may see public data". What there IS to
 * protect is the credential: those routes reach Archon's dataset and the Tiger
 * mirror through service-role connections that bypass RLS entirely, so leaving
 * them open would hand an anonymous caller a scraping endpoint onto someone
 * else's database. Signed-in is the floor, not the ceiling.
 */
export async function forbidUnlessSignedIn(): Promise<Response | null> {
  if (await getSessionUser()) return null;
  return Response.json({ error: "Sign in required." }, { status: 401 });
}
