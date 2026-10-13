import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { embedText, embedTexts } from "@/lib/ai/embeddings";
import { ocrDocument } from "@/lib/ai/ocr";
import { chunkProse, type ProseChunk } from "@/lib/kb/chunking";
import { summariseStructured } from "@/lib/kb/parsers/structured";

const BUCKET = "files";

/**
 * Which entity a file belongs to, from the folder it sits in.
 *
 * A file's attachment to a well or a lease is its FOLDER: `file_placements` →
 * `folders.entity_type` / `entity_id` (lib/files/facility-folder.ts). Stamping
 * that onto each chunk is what lets retrieval be scoped to an entity, which is
 * the difference between "search the corpus and hope" and "everything written
 * about the Repass".
 *
 * `entity_id` is text for every facility kind because `wells.id` is a slug, so
 * the lease id is checked for uuid shape before it is used — a well slug in a
 * uuid column is an insert that fails the whole index.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChunkScope {
  well_id: string | null;
  lease_id: string | null;
  well_job_id: string | null;
}

async function scopeForFile(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  fileId: string,
  wellJobId: string | null
): Promise<ChunkScope> {
  const { data } = await sb
    .from("file_placements")
    .select("folder:folders!folder_id(entity_type, entity_id)")
    .eq("file_id", fileId);

  let wellId: string | null = null;
  let leaseId: string | null = null;
  for (const row of (data ?? []) as { folder?: { entity_type?: string; entity_id?: string } | null }[]) {
    const kind = row.folder?.entity_type;
    const id = row.folder?.entity_id;
    if (!kind || !id) continue;
    if (kind === "well" && !wellId) wellId = id;
    if (kind === "lease" && !leaseId && UUID.test(id)) leaseId = id;
  }
  return { well_id: wellId, lease_id: leaseId, well_job_id: wellJobId };
}

/**
 * Make ONE file searchable, whatever it is. Reads its text — inline `content`,
 * existing OCR `derived_content`, or, for a PDF/image with stored bytes but no
 * text yet, runs OCR first and saves the result. Then indexes it in
 * `document_chunks`, dispatching on the kind of file:
 *
 *  - Structured data (LAS well logs, CSV/TSV) is parsed into a header +
 *    per-curve/column summary; that SUMMARY is embedded (not the raw numbers),
 *    and the parsed payload is cached on `files.structured_summary` for tools.
 *  - Everything else is chunked with structure-aware, contextual chunking
 *    (see lib/kb/chunking.ts).
 *
 * This is the single entry point every write path calls so that EVERY document
 * is indexed: authored docs, edited docs, text uploads, structured data, and
 * OCR'd binaries.
 */
export async function embedFile(
  fileId: string,
  /**
   * For scripts with no signed-in user (the MainLog backfill): the service-role
   * client, and the org the chunks belong to, since no session supplies it.
   */
  asService?: { client: SupabaseClient; orgId: string }
): Promise<void> {
  if (!hasSupabase()) return;
  // DB ops run as the signed-in user so RLS scopes them and new chunks inherit
  // the caller's org_id; storage bytes are read with the admin client (private
  // bucket), gated by the RLS-checked `files` read above.
  const sb = asService?.client ?? (await getSupabaseServer());

  const { data: file } = await sb
    .from("files")
    .select("id, type, mime, name, content, derived_content, storage_key, well_job_id")
    .eq("id", fileId)
    .maybeSingle();
  if (!file) return;

  let text = (file.content || file.derived_content || "").trim();

  // No text yet but we have stored bytes for a PDF/image → OCR it, persist the
  // derived text, and index that.
  if (!text && file.storage_key && (file.type === "pdf" || file.type === "image")) {
    const { data: blob, error: dlErr } = await getSupabaseAdmin().storage
      .from(BUCKET)
      .download(file.storage_key);
    if (!dlErr && blob) {
      const ocr = await ocrDocument(
        await blob.arrayBuffer(),
        file.mime ?? null,
        file.name
      );
      if (ocr) {
        await sb
          .from("files")
          .update({ derived_content: ocr, derived_at: new Date().toISOString() })
          .eq("id", fileId);
        text = ocr;
      }
    }
  }

  // Replace existing chunks.
  await sb.from("document_chunks").delete().eq("file_id", fileId);
  if (!text) return;

  // Structured data (LAS / CSV): embed the parsed summary, cache the payload.
  const structured = summariseStructured(file.name, text);
  let chunks: ProseChunk[];
  if (structured) {
    await sb
      .from("files")
      .update({ structured_summary: structured.payload })
      .eq("id", fileId);
    chunks = chunkProse(structured.summaryText, { title: file.name });
  } else {
    chunks = chunkProse(text, { title: file.name });
  }
  if (chunks.length === 0) return;

  const embeddings = await embedTexts(chunks.map((c) => c.content));
  // Resolved once per file, not per chunk: every chunk of one file shares it.
  const scope = await scopeForFile(
    sb,
    fileId,
    (file as { well_job_id?: string | null }).well_job_id ?? null
  );
  const rows = chunks.map((c, i) => ({
    file_id: fileId,
    chunk_index: i,
    content: c.content,
    embedding: embeddings[i],
    ...scope,
    // `source_type` distinguishes an indexed FILE from anything else that might
    // be indexed later; `source_id` points back at whatever row it came from,
    // which for a file is the file itself.
    source_type: "file",
    source_id: fileId,
    ...(asService ? { org_id: asService.orgId } : {}),
    metadata: {
      type: file.type,
      ...(structured ? { kind: structured.kind, structured: true } : {}),
      ...(c.section ? { section: c.section } : {}),
    },
  }));

  const { error } = await sb.from("document_chunks").insert(rows);
  if (error) throw new Error(`embedFile: ${error.message}`);
}

export interface DocMatch {
  fileId: string;
  fileName: string;
  content: string;
  score: number;
}

/**
 * Narrowing for a document search.
 *
 * Passed THROUGH to the search function rather than applied to its results,
 * because both arms of the hybrid search take their top N before anything is
 * narrowed: filtering afterwards filters the global top 20, so a well mentioned
 * in twenty documents returns nothing whenever none of them ranks statewide for
 * the phrase. That reads as "nobody wrote anything" and is a ranking artefact.
 */
export interface DocFilters {
  wellIds?: string[];
  leaseIds?: string[];
  jobIds?: string[];
  sourceTypes?: string[];
  from?: string;
  to?: string;
}

/**
 * Hybrid (semantic + keyword) search over the document corpus. When `folderId`
 * is given, retrieval is scoped to documents placed in that folder (an
 * project); otherwise it searches the whole corpus.
 */
export async function searchDocuments(
  query: string,
  limit = 8,
  folderId?: string | null,
  filters?: DocFilters
): Promise<DocMatch[]> {
  if (!hasSupabase() || !query.trim()) return [];
  // Request-scoped so the match RPC runs as the user and RLS scopes results to
  // documents they can access.
  const sb = await getSupabaseServer();

  const embedding = await embedText(query);
  const { data, error } = await sb.rpc("match_document_chunks", {
    query_embedding: embedding,
    query_text: query,
    match_count: limit,
    folder_ids: folderId ? [folderId] : null,
    // Omitted arguments default to null in the function, which means "do not
    // narrow on this", so an unfiltered call behaves exactly as it always did.
    well_ids: filters?.wellIds?.length ? filters.wellIds : null,
    lease_ids: filters?.leaseIds?.length ? filters.leaseIds : null,
    job_ids: filters?.jobIds?.length ? filters.jobIds : null,
    source_types: filters?.sourceTypes?.length ? filters.sourceTypes : null,
    from_date: filters?.from ?? null,
    to_date: filters?.to ?? null,
  });
  if (error) {
    // Until the migration adding these arguments has been applied, Postgres
    // reports the call as an unknown function rather than an unknown column.
    // Falling back keeps document search working on an un-migrated database and
    // says loudly why the results are not scoped, rather than returning nothing.
    if (/function .*match_document_chunks.* does not exist/i.test(error.message)) {
      console.warn("searchDocuments:unscoped", {
        reason:
          "match_document_chunks has no filter arguments yet — run the pending migration. Falling back to an unscoped search.",
      });
      return searchDocumentsUnscoped(sb, embedding, query, limit, folderId);
    }
    throw new Error(`searchDocuments: ${error.message}`);
  }

  const rows = (data ?? []) as {
    file_id: string;
    content: string;
    score: number;
  }[];
  if (rows.length === 0) return [];

  // Attach file names for citations.
  const fileIds = [...new Set(rows.map((r) => r.file_id))];
  const { data: files } = await sb
    .from("files")
    .select("id, name")
    .in("id", fileIds);
  const nameById = new Map((files ?? []).map((f) => [f.id, f.name]));

  return rows.map((r) => ({
    fileId: r.file_id,
    fileName: nameById.get(r.file_id) ?? "unknown",
    content: r.content,
    score: r.score,
  }));
}

/** The pre-migration call shape, kept only as the fallback above. */
async function searchDocumentsUnscoped(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  embedding: number[],
  query: string,
  limit: number,
  folderId?: string | null
): Promise<DocMatch[]> {
  const { data, error } = await sb.rpc("match_document_chunks", {
    query_embedding: embedding,
    query_text: query,
    match_count: limit,
    folder_ids: folderId ? [folderId] : null,
  });
  if (error) throw new Error(`searchDocuments: ${error.message}`);
  return attachNames(sb, (data ?? []) as ChunkRow[]);
}

interface ChunkRow {
  file_id: string;
  content: string;
  score: number;
}

/** Attach file names for citations. */
async function attachNames(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  rows: ChunkRow[]
): Promise<DocMatch[]> {
  if (rows.length === 0) return [];
  const fileIds = [...new Set(rows.map((r) => r.file_id))];
  const { data: files } = await sb.from("files").select("id, name").in("id", fileIds);
  const nameById = new Map((files ?? []).map((f) => [f.id, f.name]));
  return rows.map((r) => ({
    fileId: r.file_id,
    fileName: nameById.get(r.file_id) ?? "unknown",
    content: r.content,
    score: r.score,
  }));
}
