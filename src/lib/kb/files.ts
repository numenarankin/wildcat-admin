import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { folderPath } from "@/lib/files/tree";
import { listAttachedDocuments } from "@/lib/files/attached-documents";
import {
  ticketFileName,
  ticketIdFromFileId,
  typeFromMime,
  type AttachedDocument,
} from "@/lib/files/attached-pure";
import { ticketObjectMeta } from "@/lib/files/attached-documents";
import {
  getOrCreateFacilityFolderId,
  type FacilityKind,
} from "@/lib/files/facility-folder";
import type { RepoFile, RepoFolder } from "@/lib/kb/types";
import type { KBFile, KBFileType } from "@/lib/kb/types";

const EMPTY_ROOT: RepoFolder = {
  id: "root",
  name: "Files",
  modified: "",
  folders: [],
  files: [],
};

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = value < 10 && i > 0 ? value.toFixed(1) : String(Math.round(value));
  return `${rounded} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

interface FolderRow {
  id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string | null;
  /** Set on a facility's own folder (`Wells / Smith 1`); null elsewhere. */
  entity_type: string | null;
  entity_id: string | null;
}

interface FileRow {
  id: string;
  name: string;
  type: string;
  size: number | null;
  updated_at: string | null;
  created_at: string | null;
}

/**
 * Root folder of the file tree shown on the Files page, rebuilt from the
 * `folders` + `files` + `file_placements` tables, plus every document a
 * domain row attaches to a facility (`lib/files/attached-pure.ts`): an
 * invoice filed against a well sits under `Wells / <well>` beside the files
 * dragged there, a run ticket's photo under `Tanks / <tank>`. Empty until
 * files exist.
 */
export async function getFilesRoot(): Promise<RepoFolder> {
  if (!hasSupabase()) return EMPTY_ROOT;
  const sb = await getRequestSupabase();

  const [foldersRes, filesRes, placementsRes, attached] = await Promise.all([
    sb.from("folders").select("id, name, parent_folder_id, created_at, entity_type, entity_id"),
    sb.from("files").select("id, name, type, size, updated_at, created_at"),
    sb.from("file_placements").select("file_id, folder_id, pinned"),
    listAttachedDocuments(sb).catch((error: unknown) => {
      // The tree must not fail over its attachments; they are additive.
      console.error("getFilesRoot: attached documents", error);
      return [] as AttachedDocument[];
    }),
  ]);
  if (foldersRes.error) throw new Error(`getFilesRoot: ${foldersRes.error.message}`);
  if (filesRes.error) throw new Error(`getFilesRoot: ${filesRes.error.message}`);
  if (placementsRes.error)
    throw new Error(`getFilesRoot: ${placementsRes.error.message}`);

  const folderRows = (foldersRes.data ?? []) as FolderRow[];
  const fileRows = (filesRes.data ?? []) as FileRow[];
  await ensureFoldersFor(sb, attached, folderRows);

  const root: RepoFolder = { ...EMPTY_ROOT, folders: [], files: [] };

  const nodes = new Map<string, RepoFolder>();
  for (const f of folderRows) {
    nodes.set(f.id, {
      id: f.id,
      name: f.name,
      modified: formatDate(f.created_at),
      folders: [],
      files: [],
    });
  }
  for (const f of folderRows) {
    const node = nodes.get(f.id);
    if (!node) continue;
    const parent = f.parent_folder_id ? nodes.get(f.parent_folder_id) : null;
    if (parent) parent.folders.push(node);
    else root.folders.push(node);
  }

  const filesById = new Map<string, FileRow>();
  for (const file of fileRows) filesById.set(file.id, file);

  for (const p of placementsRes.data ?? []) {
    const file = filesById.get(p.file_id);
    if (!file) continue;
    // A null folder_id means the file lives at the (synthetic) root.
    const folder = p.folder_id ? nodes.get(p.folder_id) : root;
    if (!folder) continue;
    const repoFile: RepoFile = {
      id: file.id,
      name: file.name,
      path: file.name,
      type: file.type as KBFileType,
      folder_id: p.folder_id ?? "root",
      size: formatSize(file.size),
      modified: formatDate(file.updated_at),
      createdAt: file.created_at,
      pinned: p.pinned ?? false,
    };
    folder.files.push(repoFile);
  }

  // The attached documents, in their facility's folder, unless the same file
  // is already placed there (a service source attached from the well page is
  // both). No placement row stands behind these, so they carry `attached` and
  // the browser offers open and download only.
  const byEntity = new Map<string, RepoFolder>();
  for (const f of folderRows) {
    const node = nodes.get(f.id);
    if (node && f.entity_type && f.entity_id) {
      byEntity.set(`${f.entity_type}:${f.entity_id}`, node);
    }
  }
  for (const d of attached) {
    const folder = byEntity.get(`${d.kind}:${d.entityId}`);
    if (!folder || folder.files.some((f) => f.id === d.fileId)) continue;
    folder.files.push({
      id: d.fileId,
      name: d.name,
      path: d.name,
      type: d.type as KBFileType,
      folder_id: folder.id,
      size: formatSize(d.size),
      modified: formatDate(d.addedAt),
      createdAt: d.addedAt,
      pinned: false,
      attached: true,
    });
  }

  // Files read newest first, pinned ahead: the document wanted is almost
  // always the one just added, and a ticket scanned an hour ago was landing
  // at the bottom of an alphabetical list under a year of older ones. Folders
  // stay alphabetical; they are places, not events.
  const newestFirst = (a: RepoFile, b: RepoFile) =>
    Number(b.pinned) - Number(a.pinned) ||
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
    a.name.localeCompare(b.name);
  const sortNode = (n: RepoFolder) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort(newestFirst);
    n.folders.forEach(sortNode);
  };
  sortNode(root);

  return root;
}

/**
 * A facility with an attached document but no folder yet gets one, so the
 * document has a place in the tree. Facility folders are created at import
 * and on first visit, so after the backfill this is close to dead code; it
 * appends what it creates to `folderRows` so the tree below sees them.
 */
async function ensureFoldersFor(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  attached: AttachedDocument[],
  folderRows: FolderRow[]
): Promise<void> {
  const have = new Set(
    folderRows
      .filter((f) => f.entity_type && f.entity_id)
      .map((f) => `${f.entity_type}:${f.entity_id}`)
  );
  const missing = new Map<string, { kind: FacilityKind; entityId: string }>();
  for (const d of attached) {
    const key = `${d.kind}:${d.entityId}`;
    if (!have.has(key)) missing.set(key, { kind: d.kind, entityId: d.entityId });
  }
  if (missing.size === 0) return;
  const created = await Promise.all(
    [...missing.values()].map(async ({ kind, entityId }) => {
      try {
        return await getOrCreateFacilityFolderId(sb, kind, entityId);
      } catch (error) {
        console.error(`getFilesRoot: folder for ${kind} ${entityId}`, error);
        return null;
      }
    })
  );
  if (!created.some(Boolean)) return;
  const { data } = await sb
    .from("folders")
    .select("id, name, parent_folder_id, created_at, entity_type, entity_id")
    .in("id", created.filter((id): id is string => id !== null));
  folderRows.push(...((data ?? []) as FolderRow[]));
}

/**
 * One file, for its own page at `/files/docs/[id]`.
 *
 * A direct read rather than a walk of `getFilesRoot()`: that route renders only
 * the viewer, so it has no use for the tree, and a file with no placement row
 * would be invisible to a walk while still being perfectly openable by id.
 *
 * `folder_id` is the file's OLDEST placement. A file can sit in several folders
 * (`file_placements` is many-to-many), and this is what the page's back button
 * returns to, so it has to be a stable property of the file itself rather than
 * of however the user happened to arrive: that is what makes back work
 * identically on a reload or a shared link, which is the point of the route.
 */
export async function getRepoFile(fileId: string): Promise<RepoFile | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();

  const ticketId = ticketIdFromFileId(fileId);
  if (ticketId) return getTicketRepoFile(sb, ticketId);

  const [fileRes, placementRes] = await Promise.all([
    sb
      .from("files")
      .select("id, name, type, size, updated_at")
      .eq("id", fileId)
      .maybeSingle(),
    sb
      .from("file_placements")
      .select("folder_id, pinned")
      .eq("file_id", fileId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (fileRes.error) throw new Error(`getRepoFile: ${fileRes.error.message}`);
  if (placementRes.error)
    throw new Error(`getRepoFile: ${placementRes.error.message}`);

  const file = fileRes.data as FileRow | null;
  if (!file) return null;

  return {
    id: file.id,
    name: file.name,
    path: file.name,
    type: file.type as KBFileType,
    // A null placement folder means the file lives at the synthetic root.
    folder_id: placementRes.data?.folder_id ?? "root",
    size: formatSize(file.size),
    modified: formatDate(file.updated_at),
    pinned: placementRes.data?.pinned ?? false,
  };
}

/**
 * A run ticket's photo as a file, for its own page. It has no `files` row;
 * its home is the tank's folder.
 */
async function getTicketRepoFile(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  ticketId: string
): Promise<RepoFile | null> {
  const { data, error } = await sb
    .from("run_tickets")
    .select("id, tank_id, ticket_no, ticket_date, ticket_type, image_ref, created_at")
    .eq("id", ticketId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`getRepoFile (ticket): ${error.message}`);
  const t = data as {
    tank_id: string;
    ticket_no: string | null;
    ticket_date: string | null;
    ticket_type: string | null;
    image_ref: string | null;
    created_at: string;
  } | null;
  if (!t?.image_ref) return null;
  const [meta, { data: folder }] = await Promise.all([
    ticketObjectMeta(sb, [t.image_ref]),
    sb
      .from("folders")
      .select("id")
      .eq("entity_type", "tank")
      .eq("entity_id", t.tank_id)
      .maybeSingle(),
  ]);
  const m = meta.get(t.image_ref);
  const name = ticketFileName({
    ticketType: t.ticket_type,
    ticketNo: t.ticket_no,
    ticketDate: t.ticket_date,
  });
  return {
    id: `ticket_${ticketId}`,
    name,
    path: name,
    type: typeFromMime(m?.mimetype),
    folder_id: (folder?.id as string | undefined) ?? "root",
    size: formatSize(m?.size ?? null),
    modified: formatDate(t.created_at),
    createdAt: t.created_at,
    pinned: false,
    attached: true,
  };
}

/**
 * The file tree rooted at one folder (e.g. a project), for the scoped file
 * browser. Returns the folder's subtree, or null if it no longer exists.
 */
export async function getFolderTree(
  folderId: string
): Promise<RepoFolder | null> {
  const path = folderPath(await getFilesRoot(), folderId);
  return path ? path[path.length - 1] : null;
}

/** Files placed directly in a given folder (a project). */
export async function getFolderFiles(folderId: string): Promise<KBFile[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();

  const { data: placements, error: pErr } = await sb
    .from("file_placements")
    .select("file_id")
    .eq("folder_id", folderId);
  if (pErr) throw new Error(`getFolderFiles: ${pErr.message}`);
  const ids = (placements ?? []).map((p) => p.file_id);
  if (ids.length === 0) return [];

  const { data: files, error: fErr } = await sb
    .from("files")
    .select("id, name, type")
    .in("id", ids)
    .order("name");
  if (fErr) throw new Error(`getFolderFiles: ${fErr.message}`);

  return (files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    path: f.name,
    type: f.type as KBFileType,
    folder_id: folderId,
  }));
}

/** A well log by extension: LAS, or a MainLog mud log. */
const WELL_LOG_NAME = /\.(las|mlw|ml_|td_)$/i;

/**
 * Every well log in the library, by name.
 *
 * The geology harness needs a fourth way to find a LAS. Its other three are the
 * page the user is on, a log already read in the thread, and the files in the
 * open project; outside a project, on any page that is not the file itself, all
 * three are empty and a question about a log by name resolved to nothing. See
 * `lib/ai/geology/subject.ts` and docs/plans/page-context-awareness.md.
 *
 * Matched on the FILENAME, because an uploaded log is typed `doc` rather than
 * `las` (the value exists in the union and is not what the uploader assigns), so
 * the type column cannot be trusted for this. RLS scopes it to the caller's org.
 * MainLog mud logs count: `loadText` hands back their LAS rendition.
 */
export async function getLasFiles(): Promise<{ id: string; name: string }[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("files")
    .select("id, name")
    .or("name.ilike.%.las,name.ilike.%.mlw,name.ilike.%.ml_,name.ilike.%.td_")
    .order("name");
  if (error) throw new Error(`getLasFiles: ${error.message}`);
  return (
    (data ?? [])
      .map((f) => ({ id: f.id as string, name: f.name as string }))
      // `_` is a one-character wildcard in ILIKE, so `%.ml_` also matches
      // `.mlx`. The exact extension is settled here.
      .filter((f) => WELL_LOG_NAME.test(f.name))
  );
}
