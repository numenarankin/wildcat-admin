"use server";

/**
 * The org's own well info sheet: read it, seed it, edit it.
 *
 * `well_info_fields` (2026081200300) holds one row per field per well type. The
 * hardcoded templates in `./well-info-template` are the DEFAULTS an org is
 * seeded with at sign-up, not the source of truth — once rows exist they decide
 * what the well page's Info tab, the Settings catalog and the printable sheet
 * all show.
 *
 * Reads fall back to the defaults when an org has no rows (a workspace created
 * before this table existed, until an admin opens Settings and it seeds). The
 * fallback fields carry `default:`-prefixed ids: they are not editable rows and
 * an action handed one will say so rather than silently no-op.
 *
 * Writing is admin-only, in the DB (RLS) and here (`requireAdmin`), because it
 * changes the sheet for every well in the workspace.
 */

import { getRequestSupabase } from "@/lib/supabase/request-client";
import { requireAdmin } from "@/lib/auth/permissions";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { defaultFieldRows } from "@/lib/wells/well-info-seed";
import {
  DEFAULT_FIELD_ID_PREFIX,
  defaultInfoFieldList,
  type WellInfoField,
} from "@/lib/wells/well-info-template";
import type { WellType } from "@/lib/wells/wells";

interface Row {
  id: string;
  label: string;
  aliases: string[] | null;
  sort_order: number;
  kind: string;
}

function mapRow(r: Row): WellInfoField {
  return {
    id: r.id,
    label: r.label,
    aliases: r.aliases ?? [],
    sortOrder: r.sort_order,
    // Anything unrecognised is an ordinary row: a bad `kind` must not turn a
    // field into a second tally on every well page.
    kind: r.kind === "tally" ? "tally" : "field",
  };
}

/** The defaults as fields, for an org with nothing stored yet. */
function fallbackFields(type: WellType): WellInfoField[] {
  return defaultInfoFieldList(type);
}

/**
 * The org's sheet for one well type, in print order — or the defaults when the
 * org has none. Safe to call from any page: reading is org-wide.
 */
export async function listWellInfoFields(
  type: WellType
): Promise<WellInfoField[]> {
  if (!hasSupabase()) return fallbackFields(type);
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("well_info_fields")
    .select("id, label, aliases, sort_order, kind")
    .eq("well_type", type)
    .order("sort_order")
    .order("label");
  if (error) throw new Error(`listWellInfoFields: ${error.message}`);
  const rows = (data ?? []) as Row[];
  return rows.length > 0 ? rows.map(mapRow) : fallbackFields(type);
}

/**
 * Seed both sheets from the defaults if this org has none.
 *
 * Idempotent and safe to call on every Settings load: it inserts only when the
 * org has no rows for that well type, so an org that has deleted fields down to
 * a short sheet is left alone. Sign-up seeds through `./well-info-seed` instead:
 * it has no session to resolve the org from, only the row it just inserted.
 */
export async function seedWellInfoFields(): Promise<void> {
  if (!hasSupabase()) return;
  await requireAdmin();
  const sb = await getSupabaseServer();
  for (const type of ["producer", "injection"] as const) {
    const { count, error } = await sb
      .from("well_info_fields")
      .select("id", { count: "exact", head: true })
      .eq("well_type", type);
    if (error) throw new Error(`seedWellInfoFields: ${error.message}`);
    if ((count ?? 0) > 0) continue;
    const { error: insertError } = await sb
      .from("well_info_fields")
      .insert(defaultFieldRows(type));
    // A concurrent seed (two tabs) trips the unique index; that is success.
    if (insertError && insertError.code !== "23505") {
      throw new Error(`seedWellInfoFields: ${insertError.message}`);
    }
  }
}

/** Append a field to a sheet. Returns the stored row. */
export async function addWellInfoField(
  type: WellType,
  label: string
): Promise<WellInfoField> {
  await requireAdmin();
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Give the field a name.");
  const sb = await getSupabaseServer();

  // Land it at the end of the sheet. Read the current tail rather than counting
  // rows: fields deleted from the middle would make a count collide.
  const { data: last } = await sb
    .from("well_info_fields")
    .select("sort_order")
    .eq("well_type", type)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await sb
    .from("well_info_fields")
    .insert({
      well_type: type,
      label: trimmed,
      sort_order: ((last?.sort_order as number | undefined) ?? 0) + 10,
      // Ordinary row: there is one tally per sheet and it is seeded, never added.
      kind: "field",
    })
    .select("id, label, aliases, sort_order, kind")
    .single();
  if (error) throw new Error(fieldWriteMessage(error, trimmed));
  return mapRow(data as Row);
}

/** Rename a field. The stored values on wells are untouched — see the migration. */
export async function renameWellInfoField(
  id: string,
  label: string
): Promise<void> {
  await requireAdmin();
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Give the field a name.");
  if (id.startsWith(DEFAULT_FIELD_ID_PREFIX)) throw new Error(NOT_SEEDED);
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("well_info_fields")
    .update({ label: trimmed })
    .eq("id", id);
  if (error) throw new Error(fieldWriteMessage(error, trimmed));
}

/**
 * Put a sheet in the order the ids arrive in.
 *
 * Renumbers by 10s from the top, so the gaps that let `addWellInfoField` append
 * survive a reorder. One UPDATE per row: a sheet is a dozen fields, and the
 * alternative (an upsert of the whole list) would have to send every column to
 * avoid nulling one. `well_type` is matched as well as `id` so a bad list can
 * only ever renumber the sheet it names.
 */
export async function reorderWellInfoFields(
  type: WellType,
  orderedIds: string[]
): Promise<void> {
  await requireAdmin();
  if (orderedIds.some((id) => id.startsWith(DEFAULT_FIELD_ID_PREFIX))) {
    throw new Error(NOT_SEEDED);
  }
  const sb = await getSupabaseServer();
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      sb
        .from("well_info_fields")
        .update({ sort_order: (index + 1) * 10 })
        .eq("id", id)
        .eq("well_type", type)
    )
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    throw new Error(`reorderWellInfoFields: ${failed.error.message}`);
  }
}

/** Drop a field from a sheet. */
export async function deleteWellInfoField(id: string): Promise<void> {
  await requireAdmin();
  if (id.startsWith(DEFAULT_FIELD_ID_PREFIX)) throw new Error(NOT_SEEDED);
  const sb = await getSupabaseServer();
  const { error } = await sb.from("well_info_fields").delete().eq("id", id);
  if (error) throw new Error(`deleteWellInfoField: ${error.message}`);
}

const NOT_SEEDED =
  "This sheet hasn't been saved yet. Reload the page and try again.";

/** Turn a write failure into something an admin can act on. */
function fieldWriteMessage(
  error: { code?: string; message: string },
  label: string
): string {
  // unique (org_id, well_type, label)
  if (error.code === "23505") return `"${label}" is already on this sheet.`;
  return error.message;
}
