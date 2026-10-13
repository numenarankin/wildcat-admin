import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ACCOUNTING_UPLOAD_BUCKET } from "@/lib/accounting/storage";
import type { FacilityKind } from "@/lib/files/facility-folder";
import {
  ticketFileId,
  ticketFileName,
  typeFromMime,
  type AttachedDocument,
} from "@/lib/files/attached-pure";

/** Postgres: relation does not exist (a table its migration has not reached). */
const UNDEFINED_TABLE = "42P01";

/**
 * Every document a domain row attaches to a facility. See `attached-pure.ts`
 * for what counts. Read through the caller's RLS client, so an org sees only
 * its own rows, and never written: the file list is a VIEW over what the
 * invoices, service and run-ticket paths already stored.
 *
 * `filter` narrows the read to one facility for a Files tab; the Files page
 * reads the whole org.
 */
export async function listAttachedDocuments(
  sb: SupabaseClient,
  filter?: { kind: FacilityKind; entityId: string }
): Promise<AttachedDocument[]> {
  const wantsKind = (k: FacilityKind) => !filter || filter.kind === k;

  const [docs, service, tickets] = await Promise.all([
    // Any kind: a document can be tagged to a tank, meter or battery too.
    readPidxDocuments(sb, filter),
    wantsKind("well") ? readServiceDocuments(sb, filter) : [],
    wantsKind("tank") ? readTicketPhotos(sb, filter) : [],
  ]);

  // Invoices and service entries point at real `files` rows; resolve those
  // once, in one read, for the name / type / size the list shows.
  const refs = [...docs, ...service];
  const files = await readFiles(sb, [...new Set(refs.map((r) => r.fileId))]);

  const out: AttachedDocument[] = [];
  for (const r of refs) {
    const f = files.get(r.fileId);
    if (!f) continue;
    out.push({
      fileId: f.id,
      name: f.name,
      type: f.type ?? "file",
      size: f.size,
      scanStatus: f.scan_status,
      addedAt: r.addedAt,
      kind: r.kind,
      entityId: r.entityId,
    });
  }
  out.push(...tickets);
  return out;
}

interface FileRef {
  fileId: string;
  addedAt: string;
  kind: FacilityKind;
  entityId: string;
}

interface FileRow {
  id: string;
  name: string;
  type: string | null;
  size: number | null;
  scan_status: string | null;
}

/**
 * Invoices and field tickets. A document belongs to a facility two ways:
 * a charge line names the well or lease it was for (`pidx_lines.well_id` /
 * `lease_id`), or the document is tagged to a facility outright
 * (`invoice_facilities`, any of the five kinds). Both count; a document
 * charging three wells is listed under all three.
 */
async function readPidxDocuments(
  sb: SupabaseClient,
  filter?: { kind: FacilityKind; entityId: string }
): Promise<FileRef[]> {
  const [lines, tags] = await Promise.all([
    readLineLinks(sb, filter),
    readFacilityTags(sb, filter),
  ]);
  const links = [...lines, ...tags];
  if (links.length === 0) return [];

  const docs = await readDocs(sb, [...new Set(links.map((l) => l.documentId))]);
  const seen = new Set<string>();
  const out: FileRef[] = [];
  for (const l of links) {
    const d = docs.get(l.documentId);
    if (!d) continue;
    const key = `${l.documentId}:${l.kind}:${l.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fileId: d.source_file_id, addedAt: d.created_at, kind: l.kind, entityId: l.entityId });
  }
  return out;
}

interface DocLink {
  documentId: string;
  kind: FacilityKind;
  entityId: string;
}

/** Charge lines resolved to a well or a lease. */
async function readLineLinks(
  sb: SupabaseClient,
  filter?: { kind: FacilityKind; entityId: string }
): Promise<DocLink[]> {
  if (filter && filter.kind !== "well" && filter.kind !== "lease") return [];
  let q = sb.from("pidx_lines").select("document_id, well_id, lease_id");
  if (filter?.kind === "well") q = q.eq("well_id", filter.entityId);
  else if (filter?.kind === "lease") q = q.eq("lease_id", filter.entityId);
  else q = q.or("well_id.not.is.null,lease_id.not.is.null");
  const { data, error } = await q;
  if (error) {
    if (error.code === UNDEFINED_TABLE) return [];
    throw new Error(`listAttachedDocuments (invoice lines): ${error.message}`);
  }
  const out: DocLink[] = [];
  for (const r of (data ?? []) as {
    document_id: string;
    well_id: string | null;
    lease_id: string | null;
  }[]) {
    if (r.well_id) out.push({ documentId: r.document_id, kind: "well", entityId: r.well_id });
    if (r.lease_id) out.push({ documentId: r.document_id, kind: "lease", entityId: r.lease_id });
  }
  return out;
}

/** Documents tagged to a facility outright. */
async function readFacilityTags(
  sb: SupabaseClient,
  filter?: { kind: FacilityKind; entityId: string }
): Promise<DocLink[]> {
  let q = sb.from("invoice_facilities").select("document_id, facility_type, facility_id");
  if (filter) q = q.eq("facility_type", filter.kind).eq("facility_id", filter.entityId);
  const { data, error } = await q;
  if (error) {
    if (error.code === UNDEFINED_TABLE) return [];
    throw new Error(`listAttachedDocuments (invoice facilities): ${error.message}`);
  }
  return ((data ?? []) as { document_id: string; facility_type: FacilityKind; facility_id: string }[]).map(
    (r) => ({ documentId: r.document_id, kind: r.facility_type, entityId: r.facility_id })
  );
}

/** The documents behind a set of links that have a stored source file. */
async function readDocs(
  sb: SupabaseClient,
  ids: string[]
): Promise<Map<string, { source_file_id: string; created_at: string }>> {
  const out = new Map<string, { source_file_id: string; created_at: string }>();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await sb
      .from("pidx_documents")
      .select("id, source_file_id, created_at")
      .in("id", ids.slice(i, i + CHUNK))
      .not("source_file_id", "is", null);
    if (error) throw new Error(`listAttachedDocuments (invoices): ${error.message}`);
    for (const d of (data ?? []) as { id: string; source_file_id: string; created_at: string }[]) {
      out.set(d.id, d);
    }
  }
  return out;
}

/** Service entries with a source document (`attachServiceDocument`, ingest). */
async function readServiceDocuments(
  sb: SupabaseClient,
  filter?: { kind: FacilityKind; entityId: string }
): Promise<FileRef[]> {
  let q = sb
    .from("well_service")
    .select("well_id, file_id, created_at")
    .not("file_id", "is", null);
  if (filter?.kind === "well") q = q.eq("well_id", filter.entityId);
  const { data, error } = await q;
  if (error) throw new Error(`listAttachedDocuments (service): ${error.message}`);
  return ((data ?? []) as { well_id: string; file_id: string; created_at: string }[]).map(
    (r) => ({ fileId: r.file_id, addedAt: r.created_at, kind: "well", entityId: r.well_id })
  );
}

/**
 * Run ticket photos. These have no `files` row: the ticket modal streams the
 * scan to the accounting bucket and keeps only the key. The type and size
 * come from the bucket's own object metadata, read ONCE for the org rather
 * than per ticket.
 */
async function readTicketPhotos(
  sb: SupabaseClient,
  filter?: { kind: FacilityKind; entityId: string }
): Promise<AttachedDocument[]> {
  let q = sb
    .from("run_tickets")
    .select("id, tank_id, ticket_no, ticket_date, ticket_type, image_ref, created_at")
    .not("image_ref", "is", null)
    .is("deleted_at", null);
  if (filter?.kind === "tank") q = q.eq("tank_id", filter.entityId);
  const { data, error } = await q;
  if (error) throw new Error(`listAttachedDocuments (tickets): ${error.message}`);
  const rows = (data ?? []) as {
    id: string;
    tank_id: string;
    ticket_no: string | null;
    ticket_date: string | null;
    ticket_type: string | null;
    image_ref: string;
    created_at: string;
  }[];
  if (rows.length === 0) return [];

  const meta = await ticketObjectMeta(sb, rows.map((r) => r.image_ref));
  return rows.map((r) => {
    const m = meta.get(r.image_ref);
    return {
      fileId: ticketFileId(r.id),
      name: ticketFileName({
        ticketType: r.ticket_type,
        ticketNo: r.ticket_no,
        ticketDate: r.ticket_date,
      }),
      type: typeFromMime(m?.mimetype),
      size: m?.size ?? null,
      scanStatus: null,
      addedAt: r.created_at,
      kind: "tank",
      entityId: r.tank_id,
    };
  });
}

/**
 * MIME type and size of the org's objects in the accounting bucket, keyed by
 * storage key. Keys are `${orgId}/<uuid>`, so one prefix listing covers every
 * ticket; the org is the caller's own (`current_org_id`), which is also the
 * only prefix the tickets' keys can carry (`isOwnedStorageKey`).
 *
 * Best-effort: a listing failure leaves the type at its default rather than
 * hiding the tickets.
 */
export async function ticketObjectMeta(
  sb: SupabaseClient,
  keys: string[]
): Promise<Map<string, { mimetype: string | null; size: number | null }>> {
  const out = new Map<string, { mimetype: string | null; size: number | null }>();
  if (keys.length === 0) return out;
  const { data: orgId } = await sb.rpc("current_org_id");
  if (!orgId) return out;
  const prefix = String(orgId);
  const wanted = new Set(keys);
  try {
    const store = getSupabaseAdmin().storage.from(ACCOUNTING_UPLOAD_BUCKET);
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await store.list(prefix, { limit: PAGE, offset });
      if (error || !data) break;
      for (const o of data) {
        const key = `${prefix}/${o.name}`;
        if (!wanted.has(key)) continue;
        const md = (o.metadata ?? {}) as { mimetype?: string; size?: number };
        out.set(key, { mimetype: md.mimetype ?? null, size: md.size ?? null });
      }
      if (data.length < PAGE || out.size === wanted.size) break;
    }
  } catch (error) {
    console.error("ticketObjectMeta", error);
  }
  return out;
}

/** `files` rows by id, read in chunks so a long org history fits a URL. */
async function readFiles(
  sb: SupabaseClient,
  ids: string[]
): Promise<Map<string, FileRow>> {
  const out = new Map<string, FileRow>();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await sb
      .from("files")
      .select("id, name, type, size, scan_status")
      .in("id", ids.slice(i, i + CHUNK));
    if (error) throw new Error(`listAttachedDocuments (files): ${error.message}`);
    for (const f of (data ?? []) as FileRow[]) out.set(f.id, f);
  }
  return out;
}
