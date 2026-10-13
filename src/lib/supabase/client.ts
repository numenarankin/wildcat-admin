"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client for auth (sign in / sign up / session). Uses the
 * **publishable** key, which is safe to ship to the browser (unlike the secret
 * key used in `server.ts`).
 *
 * `createBrowserClient` from `@supabase/ssr` stores the session in **cookies**
 * (not localStorage) so the server — Proxy, server components, and the
 * request-scoped client in `server.ts` — can read it and run RLS as the
 * signed-in user. Cached as a singleton so we don't spin up multiple clients.
 */
let cached: SupabaseClient | null = null;

export function getSupabaseBrowser(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase browser env missing: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env"
    );
  }
  cached = createBrowserClient(url, key);
  return cached;
}
