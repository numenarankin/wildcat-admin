import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Every facility owns a folder in the file tree, so the files hanging off a
 * tank on `/production` and the files under `Tanks / Tank 5` on `/files` are
 * the same rows rather than two stores that drift.
 *
 * The folder is found by `(entity_type, entity_id)` — its own columns, added in
 * `2026080902000_facility_folders.sql` — not by name. Wells used to encode the
 * id INTO the name to survive renames, which worked because well ids are
 * slugs; generalized to uuid-keyed tanks and meters it would fill the Files
 * page with `9f3c1a8e-…`. With the link on its own columns, `name` is free to
 * be the display name and to follow the facility when it is renamed.
 *
 * Same polymorphic pair `facility_comments` uses, for the same reason: no
 * foreign key is possible across five parent tables.
 */

/** The facilities that own a folder. Mirrors the SQL check constraint. */
export type FacilityKind = "well" | "tank" | "meter" | "battery" | "lease";

/**
 * Top-level folder each kind's folders live under. These names are also in
 * `SYSTEM_FOLDERS` (`lib/files/system-folders-seed.ts`), which seeds them at
 * sign-in; the get-or-create below does not depend on that having run.
 */
export const FACILITY_ROOT: Record<FacilityKind, string> = {
  well: "Wells",
  tank: "Tanks",
  meter: "Meters",
  battery: "Batteries",
  lease: "Leases",
};

/** Where each kind's display name comes from when the caller does not pass one. */
const FACILITY_TABLE: Record<FacilityKind, string> = {
  well: "wells",
  tank: "tanks",
  meter: "meters",
  battery: "tank_batteries",
  lease: "leases",
};

/**
 * A facility's group: the raw value of the column that splits its kind. What a
 * tank holds, what a meter measures, what a well does. The DB's own vocabulary.
 */
export type FacilityGroup =
  | "oil"
  | "gas"
  | "water"
  | "producer"
  | "injection";

/**
 * Tanks, meters and wells sit one level deeper, under what they are for.
 *
 * A `Tanks` folder listing every oil tank next to every saltwater tank is two
 * unrelated jobs in one list — someone after a run ticket and someone after a
 * haul manifest are not browsing the same thing — and the same is true of a
 * producing well next to a disposal well. Batteries and leases have no such
 * split, so they stay directly under their root.
 *
 * The folder names are the words the business uses, not the column values:
 * `water` files as "Saltwater", `producer` as "Production", `injection` as
 * "Disposal". The columns are untouched.
 */
const GROUP_FOLDER: Partial<Record<FacilityKind, Record<string, string>>> = {
  tank: { oil: "Oil", water: "Saltwater" },
  meter: { gas: "Gas", water: "Saltwater" },
  well: { producer: "Production", injection: "Disposal" },
};

/**
 * The column carrying each kind's group, for the kinds that have one. Absent
 * means the kind's folders hang directly off its root.
 */
const GROUP_COLUMN: Partial<Record<FacilityKind, string>> = {
  tank: "product",
  meter: "substance",
  well: "type",
};

/** The value used when the row's own is missing — each column's DB default. */
const GROUP_FALLBACK: Partial<Record<FacilityKind, FacilityGroup>> = {
  tank: "oil",
  meter: "gas",
  well: "producer",
};

/** Does this kind file its folders under a group subfolder? */
export function hasGroupFolder(kind: FacilityKind): boolean {
  return GROUP_COLUMN[kind] !== undefined;
}

/** The subfolder name for a kind's group value, or null if the kind is flat. */
export function groupFolderName(
  kind: FacilityKind,
  group?: FacilityGroup | null
): string | null {
  const names = GROUP_FOLDER[kind];
  if (!names) return null;
  return names[group ?? ""] ?? names[GROUP_FALLBACK[kind] as string];
}

/** Postgres unique-violation, i.e. someone else created this folder first. */
const UNIQUE_VIOLATION = "23505";

/**
 * Resolve a kind's top-level folder, creating it if missing.
 *
 * `limit(1)` rather than `maybeSingle()`: root folders are matched by name and
 * carry no unique constraint, so a duplicate created by an older code path
 * would make `maybeSingle()` throw and take the whole page down over a
 * cosmetic problem. Picking one is the better failure.
 */
async function getOrCreateRootId(
  sb: SupabaseClient,
  kind: FacilityKind
): Promise<string> {
  const name = FACILITY_ROOT[kind];
  const { data, error } = await sb
    .from("folders")
    .select("id")
    .eq("name", name)
    .is("parent_folder_id", null)
    .limit(1);
  if (error) throw new Error(`getOrCreateRootId(${name}): ${error.message}`);
  if (data?.[0]?.id) return data[0].id as string;

  const { data: created, error: insErr } = await sb
    .from("folders")
    .insert({ name, parent_folder_id: null, is_system: true })
    .select("id")
    .single();
  if (insErr) throw new Error(`getOrCreateRootId(${name}): ${insErr.message}`);
  return created.id as string;
}

/**
 * The folder a facility's own folder belongs in: the kind's root, or the group
 * subfolder beneath it for tanks, meters and wells.
 *
 * Marked `is_system` like the roots, so the UI protects it: a user who deletes
 * "Saltwater" would take every saltwater tank's documents with it, since
 * `parent_folder_id` cascades.
 */
export async function getOrCreateParentId(
  sb: SupabaseClient,
  kind: FacilityKind,
  group?: FacilityGroup | null
): Promise<string> {
  const rootId = await getOrCreateRootId(sb, kind);
  const name = groupFolderName(kind, group);
  if (!name) return rootId;
  const { data, error } = await sb
    .from("folders")
    .select("id")
    .eq("name", name)
    .eq("parent_folder_id", rootId)
    .limit(1);
  if (error) throw new Error(`getOrCreateParentId(${name}): ${error.message}`);
  if (data?.[0]?.id) return data[0].id as string;

  const { data: created, error: insErr } = await sb
    .from("folders")
    .insert({ name, parent_folder_id: rootId, is_system: true })
    .select("id")
    .single();
  if (insErr) throw new Error(`getOrCreateParentId(${name}): ${insErr.message}`);
  return created.id as string;
}

/**
 * The facility's display name and group, for a folder about to be created.
 *
 * One read for both: the name titles the folder and the group decides which
 * subfolder it goes in, and they always come from the same row.
 */
async function facilityRow(
  sb: SupabaseClient,
  kind: FacilityKind,
  entityId: string
): Promise<{ name: string | null; group: FacilityGroup | null }> {
  const column = GROUP_COLUMN[kind];
  const { data, error } = await sb
    .from(FACILITY_TABLE[kind])
    .select(column ? `name, ${column}` : "name")
    .eq("id", entityId)
    .maybeSingle();
  if (error) throw new Error(`facilityRow(${kind}): ${error.message}`);
  const row = data as Record<string, unknown> | null;
  return {
    name: (row?.name as string | undefined) ?? null,
    group: column
      ? ((row?.[column] as FacilityGroup | undefined) ?? null)
      : null,
  };
}

/** The folder holding a facility's files, or null if it has none yet. */
export async function findFacilityFolderId(
  sb: SupabaseClient,
  kind: FacilityKind,
  entityId: string
): Promise<string | null> {
  const { data, error } = await sb
    .from("folders")
    .select("id")
    .eq("entity_type", kind)
    .eq("entity_id", entityId)
    .maybeSingle();
  if (error) throw new Error(`findFacilityFolderId(${kind}): ${error.message}`);
  return (data?.id as string | undefined) ?? null;
}

/**
 * Resolve a facility's folder, creating it (and its root) on first use.
 *
 * Pass `name` when you already have it — a create action does — to save the
 * lookup. Omit it and the display name is read from the facility's own table,
 * which is what keeps existing call sites down to `(sb, kind, id)`.
 *
 * The backfill migration means this should almost always find an existing row;
 * it still creates, because a facility added between the migration and this
 * deploy, or by a path that forgot its hook, must not lose its files.
 */
export async function getOrCreateFacilityFolderId(
  sb: SupabaseClient,
  kind: FacilityKind,
  entityId: string,
  name?: string,
  /** The row's group column (product / substance / type); read when omitted. */
  group?: FacilityGroup | null
): Promise<string> {
  const existing = await findFacilityFolderId(sb, kind, entityId);
  if (existing) return existing;

  // One read covers both, and only on the create path — after the backfill this
  // is close to dead code.
  const needsRow = !name || (hasGroupFolder(kind) && group === undefined);
  const row = needsRow
    ? await facilityRow(sb, kind, entityId)
    : { name: null, group: null };
  const label = name ?? row.name ?? entityId;
  const parentId = await getOrCreateParentId(sb, kind, group ?? row.group);

  const { data, error } = await sb
    .from("folders")
    .insert({
      name: label,
      parent_folder_id: parentId,
      is_system: false,
      entity_type: kind,
      entity_id: entityId,
    })
    .select("id")
    .single();

  if (error) {
    // Someone created it between our select and our insert. The unique index on
    // (org_id, entity_type, entity_id) is what makes that a caught race rather
    // than two folders for one tank, so re-read instead of failing.
    if (error.code === UNIQUE_VIOLATION) {
      const raced = await findFacilityFolderId(sb, kind, entityId);
      if (raced) return raced;
    }
    throw new Error(`getOrCreateFacilityFolderId(${kind}): ${error.message}`);
  }
  return data.id as string;
}

/**
 * Create a facility's folder as part of creating the facility.
 *
 * Swallows its errors on purpose. A tank that refuses to save because its
 * folder could not be written would be a worse outcome than a tank whose folder
 * appears the first time someone uploads to it — which is exactly what
 * {@link getOrCreateFacilityFolderId} does. The same applies to a caller
 * holding `manage_wells` but not `manage_files`: they can still add the tank,
 * and the folder appears when someone who can write files touches it.
 */
export async function ensureFacilityFolder(
  sb: SupabaseClient,
  kind: FacilityKind,
  entityId: string,
  name?: string,
  group?: FacilityGroup | null
): Promise<void> {
  try {
    await getOrCreateFacilityFolderId(sb, kind, entityId, name, group);
  } catch (error) {
    console.error(`ensureFacilityFolder(${kind}, ${entityId})`, error);
  }
}

/**
 * Folders for a batch of facilities of one kind, in one round trip.
 *
 * The per-facility {@link ensureFacilityFolder} is a select-then-insert, which
 * is the wrong shape for `rrc/fleet-import.ts` — a module written specifically
 * to stop doing seven round trips per well on a 500-well import. This resolves
 * the root once and hands the whole batch to one upsert.
 *
 * `ignoreDuplicates` leans on the unique index over
 * (org_id, entity_type, entity_id), so re-importing a fleet adds nothing and
 * does not clobber a folder whose name the user has since changed.
 */
export async function ensureFacilityFolders(
  sb: SupabaseClient,
  kind: FacilityKind,
  facilities: { id: string; name: string; group?: FacilityGroup | null }[]
): Promise<void> {
  if (facilities.length === 0) return;
  try {
    // Bucketed by group so each parent is resolved once, not per facility.
    const byParent = new Map<FacilityGroup | null, typeof facilities>();
    for (const f of facilities) {
      const key = hasGroupFolder(kind) ? f.group ?? null : null;
      byParent.set(key, [...(byParent.get(key) ?? []), f]);
    }

    for (const [group, bucket] of byParent) {
      const parentId = await getOrCreateParentId(sb, kind, group);
      const { error } = await sb.from("folders").upsert(
        bucket.map((f) => ({
          name: f.name,
          parent_folder_id: parentId,
          is_system: false,
          entity_type: kind,
          entity_id: f.id,
        })),
        { onConflict: "org_id,entity_type,entity_id", ignoreDuplicates: true }
      );
      if (error) throw error;
    }
  } catch (error) {
    // Same posture as the singular version: an import must not fail over its
    // folders, and get-or-create heals whatever is missing on first use.
    console.error(`ensureFacilityFolders(${kind}, ${facilities.length})`, error);
  }
}

/**
 * Move a facility's folder when its group changes.
 *
 * A tank can be switched from oil to water (`updateTank` takes `product`) and a
 * well can be reclassified producer ↔ injection (`updateWell` takes `type`).
 * The folder has to follow, or an SWD well's files sit under "Production". It
 * keeps its id and its files — only the parent changes — so nothing linking to
 * it breaks.
 *
 * Best-effort, like the rename: reclassifying a well must not fail because of
 * its folder.
 */
export async function moveFacilityFolder(
  sb: SupabaseClient,
  kind: FacilityKind,
  entityId: string,
  group: FacilityGroup
): Promise<void> {
  if (!hasGroupFolder(kind)) return;
  try {
    const folderId = await findFacilityFolderId(sb, kind, entityId);
    if (!folderId) return; // Nothing to move; it will be created in the right place.
    const parentId = await getOrCreateParentId(sb, kind, group);
    const { error } = await sb
      .from("folders")
      .update({ parent_folder_id: parentId })
      .eq("id", folderId);
    if (error) throw error;
  } catch (error) {
    console.error(`moveFacilityFolder(${kind}, ${entityId})`, error);
  }
}

/**
 * Keep the folder's name in step with the facility's.
 *
 * Best-effort by design: renaming a tank must not fail because its folder is
 * missing or the caller lacks `manage_files`. The link is the id columns, so a
 * stale name costs nothing but a stale label.
 */
export async function renameFacilityFolder(
  sb: SupabaseClient,
  kind: FacilityKind,
  entityId: string,
  name: string
): Promise<void> {
  const { error } = await sb
    .from("folders")
    .update({ name })
    .eq("entity_type", kind)
    .eq("entity_id", entityId);
  if (error) {
    console.error(`renameFacilityFolder(${kind}, ${entityId})`, error);
  }
}

/**
 * Place one file in each of several facilities' folders, creating the folders
 * where missing and skipping placements that already exist. One `files` row,
 * N placements: the same document under `Tanks / 5` and `Meters / M-2` when it
 * held both devices' history.
 */
export async function placeInFacilityFolders(
  sb: SupabaseClient,
  fileId: string,
  facilities: { kind: FacilityKind; entityId: string }[]
): Promise<void> {
  const seen = new Set<string>();
  for (const f of facilities) {
    const key = `${f.kind}:${f.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const folderId = await getOrCreateFacilityFolderId(sb, f.kind, f.entityId);
    const { data: exists } = await sb
      .from("file_placements")
      .select("id")
      .eq("file_id", fileId)
      .eq("folder_id", folderId)
      .maybeSingle();
    if (exists) continue;
    const { error } = await sb
      .from("file_placements")
      .insert({ file_id: fileId, folder_id: folderId });
    if (error) throw new Error(`placeInFacilityFolders(${key}): ${error.message}`);
  }
}
