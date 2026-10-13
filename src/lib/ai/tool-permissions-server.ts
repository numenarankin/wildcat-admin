/**
 * Reads an org's Orion tool permissions and turns them into the denial the tool
 * gate returns. Server-only (request-scoped Supabase); the catalog and the
 * predicate it uses are pure and live in `tool-permissions.ts`.
 *
 * Called from `resilient()` in `tools.ts` on every tool call, so the read is
 * memoized per request: one query for a turn no matter how many tools it uses.
 */

import { hasSupabase } from "@/lib/env";
import { memoScope } from "@/lib/cache/request-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getActiveOrgId } from "@/lib/auth/orgs";
import {
  AI_TOOL_AREAS,
  ALL_TOOLS_ALLOWED,
  NO_TOOLS_ALLOWED,
  TOOL_CELLS,
  isToolAllowed,
  permissionsFromRows,
  type ToolPermissions,
} from "@/lib/ai/tool-permissions";

/**
 * Postgres and PostgREST's two ways of saying "that table isn't there":
 * `42P01` from the database, `PGRST205` from the schema cache.
 */
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

/** The org's permission set for this request. */
export function toolPermissions(): Promise<ToolPermissions> {
  return memoScope("ai-tool-permissions", loadToolPermissions);
}

async function loadToolPermissions(): Promise<ToolPermissions> {
  // No Supabase is local dev with no data layer at all, where
  // `getCurrentPermissions` likewise grants everything so the app is usable.
  if (!hasSupabase()) return ALL_TOOLS_ALLOWED;
  try {
    const orgId = await getActiveOrgId();
    if (!orgId) return NO_TOOLS_ALLOWED;
    const sb = await getSupabaseServer();
    // RLS already confines this to the caller's org; the filter is explicit so
    // the query says what it means.
    const { data, error } = await sb
      .from("ai_tool_permissions")
      .select("area, action, enabled")
      .eq("org_id", orgId);
    // The table is not there yet: this deployment is running ahead of its
    // migrations, which happens here often enough to have its own note in the
    // project docs. Nothing can have been turned off in a table that does not
    // exist, so the honest answer is "no restrictions", not "no tools". Every
    // other error still fails closed below.
    if (error && MISSING_TABLE.has(error.code)) {
      console.warn("toolPermissions: ai_tool_permissions not deployed yet");
      return ALL_TOOLS_ALLOWED;
    }
    if (error) throw new Error(error.message);
    return permissionsFromRows(data ?? []);
  } catch (error) {
    // Fail CLOSED. Falling back to "everything allowed" would turn a transient
    // database error into a way through the gate, and this read shares the
    // request's Supabase client with the tool that is about to run: if it is
    // unreachable, the tool had nothing to work with anyway.
    console.error("toolPermissions failed", error);
    return NO_TOOLS_ALLOWED;
  }
}

const AREA_LABELS = new Map(AI_TOOL_AREAS.map((a) => [a.id, a.label]));

const ACTION_WORDS: Record<string, string> = {
  read: "reading",
  add: "adding",
  edit: "editing",
  delete: "deleting",
};

/**
 * `null` when the tool may run, otherwise the result to hand back INSTEAD of
 * running it. Phrased for the model: say what is off, do not route around it.
 */
export async function toolDenial(
  name: string,
): Promise<{ ok: false; error: string } | null> {
  const perms = await toolPermissions();
  if (isToolAllowed(name, perms)) return null;

  const cell = TOOL_CELLS[name];
  const what = cell
    ? `${ACTION_WORDS[cell.action]} ${AREA_LABELS.get(cell.area) ?? cell.area}`
    : `the ${name} tool`;
  const why =
    perms.kind === "none"
      ? `Orion's permissions could not be read, so every tool is held closed until that clears.`
      : `An admin has turned ${what} off for this workspace in Settings -> AI -> Permissions.`;
  return {
    ok: false,
    error: `${why} Tell the user plainly that you are not allowed to do this here. Do not attempt it through another tool.`,
  };
}

/** Drop the tools this org may not use from a registry. */
export function filterAllowed<T extends Record<string, unknown>>(
  tools: T,
  perms: ToolPermissions,
): T {
  const kept: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isToolAllowed(name, perms)) kept[name] = tool;
  }
  return kept as T;
}
