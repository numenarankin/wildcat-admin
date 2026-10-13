"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidateFiles } from "@/lib/files/revalidate";
import { ticketIdFromFileId } from "@/lib/files/attached-pure";
import { signRunTicketFile } from "@/lib/tanks/run-ticket-file";
import { marked } from "marked";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { embedFile } from "@/lib/ai/retrieval";
import { deriveMainLog, isMainLogName } from "@/lib/kb/mainlog-derive";
import { requirePermission } from "@/lib/auth/permissions";
import { getFilesRoot } from "@/lib/kb/files";
import type { WellFile } from "@/lib/wells/wells";
import { buildDocumentPart, UnsupportedFileError } from "@/lib/ai/document-part";
import { parseTable } from "@/lib/ai/ingest/structured/table";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, formatBytes } from "@/lib/files/limits";
import { resolveHygiene } from "@/lib/files/hygiene";
import { getOrCreateDataEntryFolderId } from "@/lib/files/data-entry-folder";
import { getOrCreateScansFolderId } from "@/lib/files/system-folder";
import {
  computeIngestProposals,
  insertIngestProposals,
  type ProposalDraft,
  type RefineDrafts,
  type ScanResult,
} from "@/lib/ai/ingest/scan";
import type { InvoiceReviewDocument } from "@/lib/invoices/review";
import type { IngestProposal } from "@/lib/ai/ingest/actions";
import {
  applyUploadScope,
  type UploadScope,
} from "@/lib/ai/ingest/upload-scope";
import {
  summariseIngestScan,
  type IngestFileScan,
  type IngestScanSummary,
  type IngestScanTrace,
} from "@/lib/ai/ingest/types";
import type { KBFileType, RepoFolder } from "@/lib/kb/types";

const BUCKET = "files";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"];

/** Map a filename's extension to one of the allowed file types. */
function fileType(name: string): KBFileType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (ext === "txt" || ext === "rtf" || ext === "doc" || ext === "docx")
    return "doc";
  return "doc";
}

function randomId(): string {
  return crypto.randomUUID();
}

/**
 * The Files UI uses a synthetic "root" node; the database represents root as a
 * null folder / parent. Translate the sentinel before writing.
 */
function resolveFolderId(id: string): string | null {
  return id === "root" ? null : id;
}

/**
 * Upload one or more files into a folder: bytes → Storage bucket (keyed by file
 * id), metadata → `files`, membership → `file_placements`.
 */
/** A platform file, flattened out of the folder tree for a picker list. */
export interface PlatformFile {
  id: string;
  name: string;
  /** Full path within its folder, for disambiguating same-named files. */
  path: string;
  type: KBFileType;
}

/**
 * Flat, de-duplicated list of every file in the doc store — for the "attach an
 * existing file" pickers (e.g. adding a platform file to a well). A file placed
 * in multiple folders appears once.
 */
/**
 * The whole folder tree, for a picker that BROWSES rather than lists.
 *
 * A flat list of every document in the org is not a way to find one: the tree
 * is how people know where things are, and `Scans / today's scan` is a place,
 * where "the 400th row down" is not. One read (the same one the Files page
 * makes), navigated client-side, so opening a folder is instant.
 */
export async function getPickerTree(): Promise<RepoFolder> {
  await requirePermission("manage_files");
  return getFilesRoot();
}

export async function listPlatformFiles(): Promise<PlatformFile[]> {
  await requirePermission("manage_files");
  const root = await getFilesRoot();
  const seen = new Set<string>();
  const out: PlatformFile[] = [];
  const walk = (folder: RepoFolder) => {
    for (const f of folder.files) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ id: f.id, name: f.name, path: f.path, type: f.type });
    }
    for (const sub of folder.folders) walk(sub);
  };
  walk(root);
  return out;
}

/**
 * Result of an upload: the proposals to hand straight to the approval modal,
 * plus a `scan` summary explaining the batch outcome (records found, nothing
 * found, out of credits, scanning off, a file that couldn't be read...) so the
 * caller can show a precise message instead of an ambiguous "done".
 */
export interface UploadResult {
  proposals: IngestProposal[];
  /**
   * The documents in this batch that held invoices, for the review modal the
   * caller shows BEFORE it hands the proposals over. Empty unless the caller
   * asked for `reviewInvoices`; without it an invoice stays a flat approval
   * card, because nothing is on screen to review it with.
   */
  invoices: InvoiceReviewDocument[];
  scan: IngestScanSummary;
  /**
   * The rows just created, in the order sent, so a caller can show them without
   * a second read. Same shape the well file list renders.
   */
  files: WellFile[];
  /**
   * True when the documents were filed but not yet read — a `background`
   * upload. `proposals` is empty and `scan` describes an empty batch because
   * nothing has run yet, not because nothing was found; whatever the parse
   * turns up arrives later over Realtime.
   */
  pending?: boolean;
}

/**
 * Read one document's bytes into scoped drafts.
 *
 * The single implementation of "what an upload's AI scan does", shared by the
 * awaited path and the backgrounded one so the two can never drift. A file we
 * can't parse degrades to "unreadable" (and any other failure to "error")
 * rather than failing the whole upload — but the reason is reported, not
 * swallowed.
 */
async function analyseFile(
  sb: SupabaseClient,
  name: string,
  buf: Buffer,
  refine?: RefineDrafts,
  /**
   * The upload's entity scope, handed to the scan so suppression compares each
   * row against THAT well / tank / meter's existing records. Scoping only the
   * returned drafts leaves every scoped handler in `suppress.ts` looking at a
   * null entity, so nothing is suppressed and duplicates reach the modal.
   */
  applyScope?: (drafts: ProposalDraft[]) => ProposalDraft[],
  /**
   * Whether an invoice in this document comes back for the review modal
   * (nested) or as a flat approval card. True for an AWAITED upload, where the
   * user is standing on the page waiting and the modal can be shown; false for
   * a backgrounded parse, where there is no one to review with.
   */
  reviewInvoices = false
): Promise<ScanResult> {
  try {
    const part = await buildDocumentPart(name, buf);
    const table = parseTable(name, buf);
    return await computeIngestProposals(sb, part, {
      refine,
      table,
      applyScope,
      reviewInvoices,
    });
  } catch (err) {
    if (err instanceof UnsupportedFileError) {
      console.error(
        "[ingest] upload: file unreadable",
        JSON.stringify({ name, error: err.message })
      );
      return { status: "unreadable", drafts: [], invoices: [] };
    }
    console.error("[ingest] upload: analyse threw", { name, error: err });
    return { status: "error", drafts: [], invoices: [] };
  }
}

/** One stored file the deferred parse still has to work through. */
interface DeferredParse {
  id: string;
  name: string;
}

/**
 * The slow half of an upload, run after the response (see `uploadFiles`'s
 * `background` option): OCR/parse each stored document, index it for search,
 * and persist whatever records it proposes.
 *
 * Bytes are re-read from Storage rather than carried over from the request, so
 * a batch of large PDFs isn't pinned in memory until the parse drains. Files
 * are worked one at a time for the same reason.
 *
 * Every failure is contained per file: one unreadable document must not stop
 * the rest of the batch from being indexed.
 */
async function parseStoredFiles(
  sb: SupabaseClient,
  jobs: DeferredParse[],
  opts: { wantScan: boolean; scope?: UploadScope; refine?: RefineDrafts }
): Promise<void> {
  for (const job of jobs) {
    // Kept from the scan's download so the MainLog step below doesn't read the
    // object a second time. Null when nothing was scanned.
    let bytes: Buffer | null = null;
    if (opts.wantScan) {
      try {
        const { data: blob, error } = await getSupabaseAdmin()
          .storage.from(BUCKET)
          .download(job.id);
        if (error || !blob) {
          throw new Error(error?.message ?? "no bytes returned");
        }
        bytes = Buffer.from(await blob.arrayBuffer());
        const scan = await analyseFile(
          sb,
          job.name,
          bytes,
          opts.refine,
          (d) => applyUploadScope(d, opts.scope, jobs.length === 1)
        );
        // The scan already applied this; `applyUploadScope` is idempotent, so
        // re-running it is the safety net, not a second transform.
        const drafts = applyUploadScope(scan.drafts, opts.scope, jobs.length === 1);
        const inserted = await insertIngestProposals(sb, job.id, job.name, drafts);
        console.info(
          "[ingest] upload: background scan done",
          JSON.stringify({
            name: job.name,
            scanStatus: scan.status,
            persisted: inserted.length,
          })
        );
      } catch (err) {
        console.error("[ingest] upload: background scan failed", {
          name: job.name,
          error: err,
        });
      }
    }
    if (isMainLogName(job.name)) {
      try {
        await deriveMainLog(sb, job, bytes);
      } catch (error) {
        console.error("deriveMainLog (background) failed", error);
      }
    }
    try {
      await embedFile(job.id);
    } catch (error) {
      console.error("embedFile (background) failed", error);
    }
  }
}

export async function uploadFiles(
  folderId: string,
  formData: FormData,
  scope?: UploadScope,
  refine?: RefineDrafts,
  options?: {
    /**
     * `scan: false` files the documents without proposing any records — the
     * "just upload" path, for a doc worth storing and searching but not worth
     * turning into suggestions. Skips the AI analysis entirely, so the upload
     * returns as fast as the bytes land. Mirrors the option `uploadWellFile`
     * takes.
     */
    scan?: boolean;
    /**
     * `background: true` returns as soon as the bytes and the file rows land,
     * and defers the parse (OCR, AI scan, search indexing) to `after()`. The
     * upload is then as fast as the upload actually is: reading a scanned PDF
     * takes tens of seconds, and on a document library that time was being
     * charged to a user who only asked to file a document.
     *
     * Safe only where nothing on screen is waiting for the returned proposals.
     * The Files browser and Projects qualify — `canShowIngestModal` doesn't
     * open approval cards there anyway, so they enqueue into a queue nothing
     * is reading, and the cards that do matter arrive over Realtime once the
     * background insert lands. A well page, Invoices or a facility's Add
     * History does NOT qualify: the user is standing there waiting for the
     * records, so those keep awaiting the scan.
     */
    background?: boolean;
    /**
     * The caller will show the invoice REVIEW MODAL for whatever comes back in
     * `invoices`, so an invoice in these documents is returned nested for that
     * screen instead of as a flat `vendorInvoice` approval card.
     *
     * Off by default, and deliberately: a caller that does not render the modal
     * and does not pass this still gets the card, so no upload path can lose an
     * invoice by forgetting to opt in. API routes and the background parse are
     * exactly that case.
     */
    reviewInvoices?: boolean;
  }
): Promise<UploadResult> {
  const wantScan = options?.scan ?? true;
  const background = options?.background ?? false;
  const created: WellFile[] = [];
  const sb = await getSupabaseServer();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);

  // Mirror of the client-side dropzone check. The client stops over-limit
  // uploads before they POST; this guards the same ceiling server-side so a
  // request that slips past it fails with a clear message instead of the opaque
  // "Unexpected end of form" the framework throws when it truncates the body.
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Upload too large (${formatBytes(totalBytes)}). The combined size must be at most ${MAX_UPLOAD_LABEL}.`
    );
  }

  console.info(
    "[ingest] upload: batch begin",
    JSON.stringify({
      folderId,
      fileCount: files.length,
      files: files.map((f) => ({ name: f.name, bytes: f.size, mime: f.type || null })),
    })
  );

  // Two system folders are addressed by name rather than by id, because the
  // caller cannot know the id: Data Entry (the web data-entry page) and Scans
  // (documents photographed on the phone, which are filed against a well or an
  // invoice later, from here). Resolve or create once for the whole batch.
  // Every other caller passes a real folder id or the "root" sentinel.
  const placementFolderId =
    folderId === "data-entry"
      ? await getOrCreateDataEntryFolderId(sb)
      : folderId === "scans"
        ? await getOrCreateScansFolderId(sb)
        : resolveFolderId(folderId);

  const proposals: IngestProposal[] = [];
  // Documents in this batch that held invoices, in file order, for the review
  // modal. One entry per document, so each reviews against its own scan.
  const invoices: InvoiceReviewDocument[] = [];
  // Per-file scan outcome, folded into one summary for the caller's messaging.
  const fileScans: IngestFileScan[] = [];
  // Per-file scan traces, stamped with the file name as each one finishes.
  const traces: IngestScanTrace[] = [];
  // Backgrounded uploads collect their stored files here and hand the whole
  // batch to `after()` once the rows exist.
  const deferred: DeferredParse[] = [];
  for (const [fileIndex, file] of files.entries()) {
    const id = randomId();
    const fileTypeName = fileType(file.name);
    const buf = Buffer.from(await file.arrayBuffer());
    console.info(
      "[ingest] upload: file begin",
      JSON.stringify({ name: file.name, bytes: file.size })
    );

    // Crop provenance from the browser's hygiene step, keyed by the file's index
    // in this batch — filenames repeat and skipping breaks positional alignment,
    // so the client indexes these explicitly. Also stores the pre-crop original.
    // Null for every non-image and every unwired surface; see the migration.
    const hygiene = await resolveHygiene(
      id,
      formData.get(`hygiene:${fileIndex}`),
      formData.get(`original:${fileIndex}`)
    );

    // Analyse the document from the in-memory bytes IN PARALLEL with the Storage
    // write — the scan needs the bytes, not the persisted object, so the two
    // never have to wait on each other.
    //
    // Backgrounded, nothing is analysed here at all: the parse runs after the
    // response, off the stored bytes.
    const analyse = (async (): Promise<ScanResult> => {
      // Nothing ran, so nothing is claimed: this file is left out of
      // `fileScans` below too, keeping `filesScanned` honest.
      if (!wantScan || background) return { status: "no_records", drafts: [], invoices: [] };
      return analyseFile(
        sb,
        file.name,
        buf,
        refine,
        (d) => applyUploadScope(d, scope, files.length === 1),
        options?.reviewInvoices ?? false
      );
    })();

    // Bytes go to the private bucket via the admin client; the DB rows below go
    // through the request-scoped client so RLS assigns org_id and enforces
    // manage_files.
    const [, scan] = await Promise.all([
      getSupabaseAdmin()
        .storage.from(BUCKET)
        // An explicit undefined overrides storage-js's default content type and
        // the request fails with "Invalid Content-Type header".
        .upload(id, buf, { contentType: file.type || "application/octet-stream", upsert: false })
        .then(({ error }) => {
          if (error) throw new Error(`uploadFiles (storage): ${error.message}`);
        }),
      analyse,
    ]);
    // The scan already applied this (see `applyScope` above); re-running the
    // idempotent transform is the safety net for any path that returns drafts
    // without going through it.
    const drafts = applyUploadScope(scan.drafts, scope, files.length === 1);

    // Extract text inline for text-like docs (incl. structured LAS/CSV/TSV) so
    // Orion can search + analyse them right away. Binaries (PDF, images) need
    // OCR → handled separately inside embedFile.
    const isText = /\.(md|markdown|txt|csv|tsv|json|las)$/i.test(file.name);
    const content = isText ? new TextDecoder().decode(buf) : null;

    const { error: fileErr } = await sb.from("files").insert({
      id,
      name: file.name,
      type: fileTypeName,
      mime: file.type || null,
      size: file.size,
      storage_key: id,
      content,
      // Omitted entirely when there is nothing to record, so an environment that
      // has not yet run 2026080700100_file_hygiene.sql keeps working for every
      // upload that didn't go through crop review (i.e. all non-photos).
      ...(hygiene ? { hygiene } : {}),
    });
    if (fileErr) throw new Error(`uploadFiles (files): ${fileErr.message}`);

    const { error: placeErr } = await sb
      .from("file_placements")
      .insert({ file_id: id, folder_id: placementFolderId });
    if (placeErr) throw new Error(`uploadFiles (placement): ${placeErr.message}`);

    created.push({
      id,
      name: file.name,
      type: fileTypeName.toUpperCase(),
      sizeKb: Math.max(1, Math.round(file.size / 1024)),
      uploadedAt: new Date().toISOString().slice(0, 10),
      scanStatus: null,
    });

    if (background) {
      // The file is filed: its row is in the folder and its bytes are in the
      // bucket, which is everything the user's click asked for. Reading it —
      // OCR, the AI scan, search indexing — is queued for after the response.
      deferred.push({ id, name: file.name });
      continue;
    }

    // A MainLog mud log is binary; its LAS rendition is the text embedFile reads.
    if (isMainLogName(file.name)) {
      try {
        await deriveMainLog(sb, { id, name: file.name }, buf);
      } catch (error) {
        console.error("deriveMainLog failed", error);
      }
    }

    // Index EVERY uploaded file so it's searchable: text inline now, PDFs/images
    // via OCR inside embedFile.
    try {
      await embedFile(id);
    } catch (error) {
      console.error("embedFile failed", error);
    }

    // Persist the proposals now that the file row exists (FK) and return them
    // to the caller, which opens the approval modal directly (the same awaited
    // click that showed the upload spinner).
    const inserted = await insertIngestProposals(sb, id, file.name, drafts);
    proposals.push(...inserted);
    if (scan.invoices.length > 0) {
      invoices.push({ fileId: id, fileName: file.name, invoices: scan.invoices });
    }

    // Reconcile the reported status with what actually persisted. Three cases the
    // user must be able to tell apart (no silent, misattributed failure):
    //  • scopedToNone — the scan found records, but a tank/meter-scoped upload
    //    filtered them ALL out because every row was for a DIFFERENT device than
    //    the one this upload targets. Not an error: the file just holds no data
    //    for THIS tank. Report it honestly as "no records", not a fake insert error.
    //  • insertFailed — there WERE drafts to write and the insert returned none
    //    (see the `insert: … FAILED` line above for the Postgres error).
    //  • otherwise — success (or a genuinely empty scan).
    const scopedToNone = scan.status === "records" && drafts.length === 0;
    const insertFailed = drafts.length > 0 && inserted.length === 0;
    if (scopedToNone) {
      console.info(
        "[ingest] upload: records found but NONE matched this upload's scope (other tanks/meters only)",
        JSON.stringify({
          name: file.name,
          scanDrafts: scan.drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
          pinnedTankRef: scope?.tankRef ?? null,
        })
      );
    } else if (insertFailed) {
      console.error(
        "[ingest] upload: scan found records but NONE persisted (see insert error above)",
        JSON.stringify({ name: file.name, scanStatus: scan.status })
      );
    } else {
      console.info(
        "[ingest] upload: file done",
        JSON.stringify({ name: file.name, scanStatus: scan.status, persisted: inserted.length })
      );
    }
    if (wantScan) {
      fileScans.push({
        fileName: file.name,
        status: insertFailed ? "error" : scopedToNone ? "no_records" : scan.status,
        recordsFound: inserted.reduce((n, p) => n + p.rows.length, 0),
      });
    }
    // The scan only ever saw bytes, so the name is stamped on here.
    if (scan.trace) traces.push({ ...scan.trace, fileName: file.name });
  }

  revalidateFiles();

  if (deferred.length > 0) {
    // `after` keeps the invocation alive past the response, so the parse runs
    // on a server that is no longer making anyone wait. Proposals it writes
    // reach the browser over Realtime (see `IngestProvider`), which is how a
    // scan that outlives its request was always meant to surface.
    after(async () => {
      console.info(
        "[ingest] upload: background parse begin",
        JSON.stringify({ files: deferred.map((d) => d.name) })
      );
      await parseStoredFiles(sb, deferred, { wantScan, scope, refine });
      console.info(
        "[ingest] upload: background parse done",
        JSON.stringify({ files: deferred.length })
      );
    });
  }

  const summary = { ...summariseIngestScan(fileScans), traces };
  console.info(
    "[ingest] upload: batch done",
    JSON.stringify({
      proposals: proposals.length,
      deferred: deferred.length,
      summary,
    })
  );
  // `pending` says the headline is not the last word: nothing has been read
  // yet, so `scan` reports an empty batch (`filesScanned: 0`) rather than
  // claiming a scan found nothing.
  return {
    proposals,
    invoices,
    scan: summary,
    files: created,
    ...(deferred.length > 0 ? { pending: true } : {}),
  };
}

/**
 * Attach files that are ALREADY in the doc store to another folder, and read
 * them there.
 *
 * The other half of the phone's scan flow (`docs/plans/scan-to-files.md` in the
 * phone repo). A pumper photographs a ticket in the field; it lands in `Scans`
 * with no analysis, because deciding what a document MEANS needs an approval UI
 * and that is this app's job, not a handset's. Here somebody opens the well (or
 * Data Entry, or an invoice), picks the scan, and the same pipeline an upload
 * would have run runs against bytes that are already in Storage.
 *
 * Place, do not copy. One `files` row, one Storage object, N `file_placements` —
 * so a scan attached to a well is the SAME document as the one in `Scans`,
 * renamed once and deleted once. Re-attaching a file that is already in the
 * target folder is a no-op rather than a second placement.
 *
 * `scan: false` files it and stops, for a document worth keeping but not worth
 * proposing records from. `scope` pre-targets the drafts at the entity the
 * attach came from, exactly as an upload's does, so a service ticket attached
 * at a well proposes rows against THAT well.
 */
export async function attachStoredFiles(
  fileIds: string[],
  folderId: string,
  options?: {
    scan?: boolean;
    scope?: UploadScope;
    refine?: RefineDrafts;
    /** See `uploadFiles`. Off by default so no caller loses an invoice. */
    reviewInvoices?: boolean;
  }
): Promise<UploadResult> {
  const wantScan = options?.scan ?? true;
  if (fileIds.length === 0) {
    return { proposals: [], invoices: [], scan: summariseIngestScan([]), files: [] };
  }

  const sb = await getSupabaseServer();
  const placementFolderId =
    folderId === "data-entry"
      ? await getOrCreateDataEntryFolderId(sb)
      : folderId === "scans"
        ? await getOrCreateScansFolderId(sb)
        : resolveFolderId(folderId);

  const { data: rows, error: rowsErr } = await sb
    .from("files")
    .select("id, name, type, size, created_at")
    .in("id", fileIds);
  if (rowsErr) throw new Error(`attachStoredFiles (files): ${rowsErr.message}`);

  const proposals: IngestProposal[] = [];
  const fileScans: IngestFileScan[] = [];
  const traces: IngestScanTrace[] = [];
  const attached: WellFile[] = [];
  // Documents that held invoices, for the review modal the caller shows first.
  const invoices: InvoiceReviewDocument[] = [];

  for (const row of (rows ?? []) as {
    id: string;
    name: string;
    type: string | null;
    size: number | null;
    created_at: string | null;
  }[]) {
    const { data: exists } = await sb
      .from("file_placements")
      .select("id")
      .eq("file_id", row.id)
      .eq("folder_id", placementFolderId)
      .maybeSingle();
    if (!exists) {
      const { error: placeErr } = await sb
        .from("file_placements")
        .insert({ file_id: row.id, folder_id: placementFolderId });
      if (placeErr) throw new Error(`attachStoredFiles (placement): ${placeErr.message}`);
    }

    attached.push({
      id: row.id,
      name: row.name,
      type: (row.type ?? "file").toUpperCase(),
      sizeKb: Math.max(1, Math.round((row.size ?? 0) / 1024)),
      uploadedAt: (row.created_at ?? new Date().toISOString()).slice(0, 10),
      scanStatus: null,
    });

    if (!wantScan) continue;

    // The bytes are keyed by file id in the shared bucket — the same read the
    // backgrounded upload parse does (`parseStoredFiles`).
    try {
      const { data: blob, error } = await getSupabaseAdmin()
        .storage.from(BUCKET)
        .download(row.id);
      if (error || !blob) throw new Error(error?.message ?? "no bytes returned");
      const scan = await analyseFile(
        sb,
        row.name,
        Buffer.from(await blob.arrayBuffer()),
        options?.refine,
        (d) => applyUploadScope(d, options?.scope, fileIds.length === 1),
        options?.reviewInvoices ?? false
      );
      // The scan applied this already; `applyUploadScope` is idempotent, so the
      // second call is the safety net, not a second transform.
      const drafts = applyUploadScope(scan.drafts, options?.scope, fileIds.length === 1);
      const inserted = await insertIngestProposals(sb, row.id, row.name, drafts);
      proposals.push(...inserted);
      if (scan.invoices.length > 0) {
        invoices.push({
          fileId: row.id,
          fileName: row.name,
          invoices: scan.invoices,
        });
      }
      fileScans.push({
        fileName: row.name,
        status: drafts.length > 0 && inserted.length === 0 ? "error" : scan.status,
        recordsFound: inserted.reduce((n, p) => n + p.rows.length, 0),
      });
      if (scan.trace) traces.push({ ...scan.trace, fileName: row.name });
    } catch (err) {
      // One unreadable attachment must not lose the others, or the placement
      // that already succeeded. Reported, never swallowed.
      console.error("[ingest] attach: scan failed", { name: row.name, error: err });
      fileScans.push({ fileName: row.name, status: "error", recordsFound: 0 });
    }
  }

  revalidateFiles();

  return {
    proposals,
    invoices,
    scan: { ...summariseIngestScan(fileScans), traces },
    files: attached,
  };
}

/** Create a subfolder. */
export async function createFolder(
  parentId: string,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("folders")
    .insert({
      name: trimmed,
      parent_folder_id: resolveFolderId(parentId),
      is_system: false,
    });
  if (error) throw new Error(`createFolder: ${error.message}`);
  revalidateFiles();
}

/** Create an empty markdown document in a folder; returns its id. */
export async function createDoc(
  folderId: string,
  name = "Untitled.md"
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const id = randomId();
  const { error: fileErr } = await sb
    .from("files")
    .insert({ id, name, type: "md", content: "" });
  if (fileErr) throw new Error(`createDoc (files): ${fileErr.message}`);
  const { error: placeErr } = await sb
    .from("file_placements")
    .insert({ file_id: id, folder_id: resolveFolderId(folderId) });
  if (placeErr) throw new Error(`createDoc (placement): ${placeErr.message}`);
  revalidateFiles();
  return { id };
}

/**
 * Create a markdown document authored by Orion in a folder. The agent supplies
 * Markdown; we convert it to the HTML the editor stores so it renders correctly,
 * then index it for search. Returns the new file's id + name.
 */
export async function createProjectDocument(
  folderId: string,
  name: string,
  markdown: string
): Promise<{ id: string; name: string }> {
  const sb = await getSupabaseServer();
  const id = randomId();
  const trimmed = name.trim() || "Untitled";
  const fileName = /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  const html = (await marked.parse(markdown ?? "")).toString();

  const { error: fileErr } = await sb
    .from("files")
    .insert({ id, name: fileName, type: "md", content: html });
  if (fileErr) throw new Error(`createProjectDocument (files): ${fileErr.message}`);

  const { error: placeErr } = await sb
    .from("file_placements")
    .insert({ file_id: id, folder_id: resolveFolderId(folderId) });
  if (placeErr)
    throw new Error(`createProjectDocument (placement): ${placeErr.message}`);

  // Index it so it's immediately searchable (and feeds the project's RAG).
  try {
    await embedFile(id);
  } catch (error) {
    console.error("embedFile (createProjectDocument) failed", error);
  }

  // Revalidate the files surface; the project tree refreshes client-side
  // (the project page is keyed by project slug, not this folder id).
  revalidateFiles();
  return { id, name: fileName };
}

/** Load a document's editable body + metadata. */
export async function getDoc(
  fileId: string
): Promise<{ id: string; name: string; type: string; content: string } | null> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("files")
    .select("id, name, type, content")
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw new Error(`getDoc: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    type: data.type,
    content: data.content ?? "",
  };
}

/** Save a document's inline body and re-index it for search. */
export async function saveDoc(fileId: string, content: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("files")
    .update({ content })
    .eq("id", fileId);
  if (error) throw new Error(`saveDoc: ${error.message}`);

  // Keep the search index in sync so Orion can find authored/edited docs.
  try {
    await embedFile(fileId);
  } catch (error) {
    console.error("embedFile (saveDoc) failed", error);
  }
}

/** Rename a folder (e.g. a project). */
export async function renameFolder(
  folderId: string,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("folders")
    .update({ name: trimmed })
    .eq("id", folderId);
  if (error) throw new Error(`renameFolder: ${error.message}`);
  revalidatePath("/projects");
  revalidateFiles();
}

/** Rename a file. */
export async function renameFile(fileId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("files")
    .update({ name: trimmed })
    .eq("id", fileId);
  if (error) throw new Error(`renameFile: ${error.message}`);
  revalidateFiles();
}

/** Pin / unpin a file within a specific folder (per-placement). */
export async function setPin(
  fileId: string,
  folderId: string,
  pinned: boolean
): Promise<void> {
  const sb = await getSupabaseServer();
  const resolved = resolveFolderId(folderId);
  const query = sb
    .from("file_placements")
    .update({ pinned })
    .eq("file_id", fileId);
  const { error } = await (resolved === null
    ? query.is("folder_id", null)
    : query.eq("folder_id", resolved));
  if (error) throw new Error(`setPin: ${error.message}`);
  revalidateFiles();
}

/**
 * Move a file from one folder to another (re-points its placement). Handles the
 * root sentinel and the case where the file is already placed in the target.
 */
/**
 * Delete a file everywhere. Removing the `files` row cascades to its folder
 * placements, embeddings, and other file-scoped rows (all declared
 * `on delete cascade`). RLS scopes the read + delete to the caller's org; the
 * stored bytes are removed with the admin client only AFTER the RLS read has
 * proven ownership. Storage removal is best-effort (a miss shouldn't fail the
 * delete once the row is gone).
 */
export async function deleteFile(fileId: string): Promise<void> {
  const sb = await getSupabaseServer();

  const { data: file, error: readErr } = await sb
    .from("files")
    .select("storage_key")
    .eq("id", fileId)
    .maybeSingle<{ storage_key: string | null }>();
  if (readErr) throw new Error(`deleteFile (read): ${readErr.message}`);
  if (!file) return; // not found or not the caller's org — nothing to do

  const { error: delErr } = await sb.from("files").delete().eq("id", fileId);
  if (delErr) throw new Error(`deleteFile: ${delErr.message}`);

  if (file.storage_key) {
    const { error: storErr } = await getSupabaseAdmin()
      .storage.from(BUCKET)
      .remove([file.storage_key]);
    if (storErr) console.error("deleteFile (storage):", storErr.message);
  }

  revalidateFiles();
}

/**
 * Take a document OUT of one folder, without destroying it.
 *
 * The difference between this and {@link deleteFile} is the whole point. A file
 * is one row with many placements: the scan in `Scans` and the copy on a well's
 * Files tab are the SAME document. So "remove it from here" must mean the
 * placement, or removing a ticket from a well silently deletes it out of Scans,
 * out of every other facility it was attached to, and out of Storage — which is
 * exactly what happened once.
 *
 * A file whose last placement is removed is moved to the Files root rather than
 * left with none: a row with no placement appears in no folder at all, which is
 * a deletion by another name and an invisible one. Deleting a document outright
 * stays where the consequences are visible, in the Files browser.
 */
export async function removeFileFromFolder(
  fileId: string,
  folderId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const target = resolveFolderId(folderId);

  const { error } = await sb
    .from("file_placements")
    .delete()
    .eq("file_id", fileId)
    .eq("folder_id", target);
  if (error) throw new Error(`removeFileFromFolder: ${error.message}`);

  const { data: left, error: leftErr } = await sb
    .from("file_placements")
    .select("id")
    .eq("file_id", fileId)
    .limit(1);
  if (leftErr) throw new Error(`removeFileFromFolder (remaining): ${leftErr.message}`);
  if ((left ?? []).length === 0) {
    const { error: rootErr } = await sb
      .from("file_placements")
      .insert({ file_id: fileId, folder_id: null });
    if (rootErr) throw new Error(`removeFileFromFolder (root): ${rootErr.message}`);
  }

  revalidateFiles();
}

export async function moveFile(
  fileId: string,
  fromFolderId: string,
  toFolderId: string
): Promise<void> {
  const from = resolveFolderId(fromFolderId);
  const to = resolveFolderId(toFolderId);
  if (from === to) return;
  const sb = await getSupabaseServer();

  // Already placed in the target? Then just drop the source placement.
  let existsQuery = sb
    .from("file_placements")
    .select("id")
    .eq("file_id", fileId);
  existsQuery =
    to === null
      ? existsQuery.is("folder_id", null)
      : existsQuery.eq("folder_id", to);
  const { data: existingTarget } = await existsQuery.maybeSingle();

  let delQuery = sb.from("file_placements").delete().eq("file_id", fileId);
  delQuery =
    from === null
      ? delQuery.is("folder_id", null)
      : delQuery.eq("folder_id", from);
  const { error: delErr } = await delQuery;
  if (delErr) throw new Error(`moveFile (remove): ${delErr.message}`);

  if (!existingTarget) {
    const { error: insErr } = await sb
      .from("file_placements")
      .insert({ file_id: fileId, folder_id: to });
    if (insErr) throw new Error(`moveFile (insert): ${insErr.message}`);
  }

  revalidateFiles();
}

/** Add existing files (by id) to a folder as new placements (skips duplicates). */
export async function addFilesToFolder(
  folderId: string,
  fileIds: string[]
): Promise<void> {
  if (fileIds.length === 0) return;
  const sb = await getSupabaseServer();
  const folder = resolveFolderId(folderId);

  for (const fileId of fileIds) {
    let existsQuery = sb
      .from("file_placements")
      .select("id")
      .eq("file_id", fileId);
    existsQuery =
      folder === null
        ? existsQuery.is("folder_id", null)
        : existsQuery.eq("folder_id", folder);
    const { data: exists } = await existsQuery.maybeSingle();
    if (!exists) {
      const { error } = await sb
        .from("file_placements")
        .insert({ file_id: fileId, folder_id: folder });
      if (error) throw new Error(`addFilesToFolder: ${error.message}`);
    }
  }

  revalidatePath(`/projects/${folderId}`);
}

/** Get a short-lived signed download URL, or null for inline-only docs. */
export async function getDownloadUrl(
  fileId: string,
  opts: { download?: boolean } = {}
): Promise<string | null> {
  const sb = await getSupabaseServer();
  // A run ticket photo listed under its synthetic id: the bytes are in the
  // accounting bucket, keyed off the ticket row, not in `files`.
  const ticketId = ticketIdFromFileId(fileId);
  if (ticketId) return signRunTicketFile(sb, getSupabaseAdmin(), ticketId);
  const { data: file } = await sb
    .from("files")
    .select("storage_key, name")
    .eq("id", fileId)
    .maybeSingle();
  if (!file?.storage_key) return null;
  // The `files` read above passed RLS (the caller can access this file), so we
  // can mint the signed URL with the admin client against the private bucket.
  // One hour: long enough for the in-app PDF viewer, which lazily range-fetches
  // pages while the user reads/scrolls — a 60s link expires mid-session (400).
  const { data, error } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    // A download names the save after the file: the object key is a bare UUID,
    // so without this a `.las` saves as an extensionless blob. Viewers leave it
    // off, since an attachment header in an iframe downloads instead of shows.
    .createSignedUrl(
      file.storage_key,
      60 * 60,
      opts.download ? { download: file.name || true } : undefined
    );
  if (error) throw new Error(`getDownloadUrl: ${error.message}`);
  return data?.signedUrl ?? null;
}

/**
 * Delete a folder: its subfolders and placements go with it (the schema
 * cascades), the files themselves stay wherever else they are placed and in
 * storage. System folders (the roots and the group folders under them) are
 * refused; deleting `Tanks` would take every tank's documents' home with it.
 */
export async function deleteFolder(folderId: string): Promise<void> {
  await requirePermission("manage_files");
  const sb = await getSupabaseServer();
  const { data: folder, error: readErr } = await sb
    .from("folders")
    .select("id, is_system")
    .eq("id", folderId)
    .maybeSingle();
  if (readErr) throw new Error(`deleteFolder: ${readErr.message}`);
  if (!folder) return;
  if (folder.is_system) throw new Error("System folders cannot be deleted.");
  const { error } = await sb.from("folders").delete().eq("id", folderId);
  if (error) throw new Error(`deleteFolder: ${error.message}`);
  revalidateFiles();
}
