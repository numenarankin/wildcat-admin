import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { memoScope } from "@/lib/cache/request-cache";
import {
  DEFAULT_CATEGORIES,
  categoriesSchema,
  type Category,
} from "@/lib/accounting/categories";

/**
 * The caller's organization chart of accounts, or the built-in sample list when
 * the org hasn't configured one (or has stored something invalid). Resolved via
 * RLS — no need to pass the org id.
 *
 * `scope` is for service-role callers with no RLS org context (the digest cron),
 * which must name the org they mean. Without it a service-role read would match
 * every organization row and `maybeSingle` would fail or, worse, answer with
 * somebody else's chart of accounts.
 */
export async function getAccountingCategories(scope?: {
  client: SupabaseClient;
  orgId: string;
}): Promise<Category[]> {
  if (!scope && !hasSupabase()) return DEFAULT_CATEGORIES;
  // The RLS read is memoized per request: the ledger asks for it from three
  // projections in one render (payments, expenses, statement revenue) and the
  // dashboard paid three round trips for one row.
  if (!scope) return memoScope("accounting-categories", () => loadCategories(undefined));
  return loadCategories(scope);
}

async function loadCategories(scope?: {
  client: SupabaseClient;
  orgId: string;
}): Promise<Category[]> {
  try {
    const sb = scope?.client ?? (await getSupabaseServer());
    let query = sb.from("organizations").select("accounting_categories");
    if (scope) query = query.eq("id", scope.orgId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;

    const stored = data?.accounting_categories;
    if (!stored) return DEFAULT_CATEGORIES;

    const parsed = categoriesSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_CATEGORIES;
  } catch (error) {
    console.error("getAccountingCategories failed", error);
    return DEFAULT_CATEGORIES;
  }
}
