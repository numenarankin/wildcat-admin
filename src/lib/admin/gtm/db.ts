import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The GTM database: its own Supabase project (migrations in
 * `supabase/migrations`), holding the landing's traffic and what Snitcher
 * identifies. Every table is RLS-on with no policies, so only this secret-key
 * client reads or writes it, and every caller does its own admin check
 * (`assertAdminPage("gtm")`, the webhook's signature).
 */
let cached: SupabaseClient | null = null;

export function hasGtmDb(): boolean {
  return Boolean(process.env.GTM_SUPABASE_URL && process.env.GTM_SUPABASE_SECRET_KEY);
}

export function getGtmDb(): SupabaseClient {
  const url = process.env.GTM_SUPABASE_URL;
  const key = process.env.GTM_SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("GTM database not configured: set GTM_SUPABASE_URL and GTM_SUPABASE_SECRET_KEY");
  cached ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
