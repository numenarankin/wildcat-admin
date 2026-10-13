"use server";

import { getRequestSupabase } from "@/lib/supabase/request-client";
import { cachedStatements } from "@/lib/cache/loaders";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { userCan } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";
import { gateAI } from "@/lib/billing/credits";
import { buildDocumentPart } from "@/lib/ai/document-part";
import {
  extractStatementsFromDocument,
  type ExtractedStatement,
} from "@/lib/statements/extract";
import {
  STATEMENT_UPLOAD_BUCKET as UPLOAD_BUCKET,
  isOwnedStorageKey,
  originalStorageKey,
  transcriptStorageKey,
} from "@/lib/statements/storage";
import { parseHygiene, type StoredHygiene } from "@/lib/files/hygiene";
import { proposeBackfillDrafts } from "@/lib/ai/ingest/backfill";
import { errorInfo, ierr, ilog } from "@/lib/ai/ingest/log";
import {
  computeRunStatementBackfill,
  readStatementTranscript,
} from "@/lib/statements/run-backfill-server";
import type { StatementRunBackfill } from "@/lib/statements/run-backfill";
import type { ProposalDraft } from "@/lib/ai/ingest/scan";
import type { IngestProposal } from "@/lib/ai/ingest/actions";
import type { DraftTransaction } from "@/lib/accounting/types";
import { INGEST_ROW_SCHEMA } from "@/lib/ai/ingest/schemas";
import {
  createStatement,
  getStatement,
  listPurchasers,
  getOrCreatePurchaser,
  listStatements,
  listTankStatementLines,
  replaceStatementLines,
  updateStatement,
  upsertPurchaserContact,
  type LineProduct,
  type Purchaser,
  type Statement,
  type StatementProduct,
  type StatementStatus,
  type StatementWithLines,
  type TankStatementLine,
  type WellPurchaserSale,
} from "@/lib/statements/statements";
import { getWellPurchaserSales } from "@/lib/statements/purchaser-sales";

/** Resolve the signed-in user's org id, or throw if there isn't one. */
async function requireOrgId(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>
): Promise<string> {
  const { data: orgId, error } = await sb.rpc("current_org_id");
  if (error || !orgId) throw new Error("No organization for the current user.");
  return orgId as string;
}

/** Throw unless the caller holds `manage_statements` (RLS also enforces it). */
async function requireManage(): Promise<void> {
  if (!(await userCan("manage_statements"))) {
    throw new Error("Not permitted to manage statements.");
  }
}

/**
 * Extract purchaser statements from an already-uploaded company FILE (by id),
 * for Orion's `extract_statement` tool. Same extractor the Statements-page
 * upload uses (`extractStatementsFromDocument`), but the bytes come from the
 * `files` bucket instead of the statement-uploads bucket. Accounting-gated and
 * AI-credit-gated; returns drafted, ref-resolved statements (nothing persisted)
 * or a plain error the tool can relay.
 */
export async function extractStatementFromFile(
  fileId: string
): Promise<
  | { ok: true; statements: ExtractedStatement[] }
  | { ok: false; error: string }
> {
  if (!(await userCan("manage_statements"))) {
    return { ok: false, error: "You don't have permission to read statements." };
  }
  const sb = await getSupabaseServer();
  const gate = await gateAI(sb);
  if (!gate.allowed) {
    return { ok: false, error: `AI is unavailable: ${gate.reason}` };
  }

  // RLS-scoped read confirms the caller may access this file before the admin
  // client (which bypasses RLS) downloads its bytes.
  const { data: file } = await sb
    .from("files")
    .select("name, type, storage_key")
    .eq("id", fileId)
    .maybeSingle();
  if (!file || !file.storage_key) {
    return { ok: false, error: "File not found." };
  }

  let documentPart;
  try {
    const { data: blob, error: dlErr } = await getSupabaseAdmin()
      .storage.from("files")
      .download(file.storage_key);
    if (dlErr || !blob) throw new Error(dlErr?.message ?? "File not in storage");
    const buf = Buffer.from(await blob.arrayBuffer());
    documentPart = await buildDocumentPart(file.name, buf);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unreadable file.",
    };
  }

  try {
    const { statements, status } = await extractStatementsFromDocument(
      sb,
      documentPart
    );
    // The extractor no longer throws for document-level failures — it reports
    // them as a status. Relay the ones the tool's caller can act on rather than
    // handing Orion an empty list with no explanation.
    if (status === "error") {
      return { ok: false, error: "Failed to extract statements from the document." };
    }
    if (status === "unreadable") {
      return { ok: false, error: "That file couldn't be read." };
    }
    return { ok: true, statements };
  } catch (err) {
    console.error("extractStatementFromFile failed", err);
    return {
      ok: false,
      error: "Failed to extract statements from the document.",
    };
  }
}

// --- Reads -----------------------------------------------------------------

export async function getStatements(): Promise<Statement[]> {
  return cachedStatements(await getRequestSupabase());
}

export async function getStatementDetail(
  id: string
): Promise<StatementWithLines | null> {
  const sb = await getSupabaseServer();
  return getStatement(sb, id);
}

export async function getPurchasers(): Promise<Purchaser[]> {
  const sb = await getSupabaseServer();
  return listPurchasers(sb);
}

/**
 * A tank's settlement lines for its Settlements tab. RLS on
 * `statement_line_items` scopes this to accounting-permitted users; a viewer
 * without `view_revenue` gets an empty list (no leak) and the tab reads empty.
 */
export async function getTankStatementLines(
  tankId: string
): Promise<TankStatementLine[]> {
  const sb = await getSupabaseServer();
  return listTankStatementLines(sb, tankId);
}

/**
 * Read-only purchaser-sales slice for a well, for the well page's panel. RLS
 * on `statement_line_items` scopes this to accounting-permitted users — a viewer
 * without `view_revenue` gets an empty list (no leak), so the panel hides.
 */
export async function loadWellPurchaserSales(
  wellId: string
): Promise<WellPurchaserSale[]> {
  const sb = await getRequestSupabase();
  return getWellPurchaserSales(sb, wellId);
}

// --- Upload target ---------------------------------------------------------

/**
 * Mint one-shot signed upload URLs so the browser streams the statement
 * straight to private Storage (bypassing the serverless body cap). The `path`
 * is namespaced under the caller's org so a forged key can't reach another org.
 *
 * The `original` target is minted unconditionally and used only when the crop
 * step actually changed the bytes (a photograph). A signed URL that is never
 * redeemed costs nothing and expires on its own, which is cheaper than making
 * the browser take a second round trip once it knows whether it cropped.
 */
export async function createStatementUploadTarget(): Promise<{
  bucket: string;
  path: string;
  token: string;
  original: { path: string; token: string };
}> {
  await requireManage();
  const sb = await getSupabaseServer();
  const orgId = await requireOrgId(sb);
  const path = `${orgId}/${crypto.randomUUID()}`;
  const originalPath = originalStorageKey(path);
  const admin = getSupabaseAdmin();
  const [main, original] = await Promise.all([
    admin.storage.from(UPLOAD_BUCKET).createSignedUploadUrl(path),
    admin.storage.from(UPLOAD_BUCKET).createSignedUploadUrl(originalPath),
  ]);
  if (main.error || !main.data) {
    throw new Error(
      `createStatementUploadTarget: ${main.error?.message ?? "no signed URL"}`
    );
  }
  if (original.error || !original.data) {
    throw new Error(
      `createStatementUploadTarget (original): ${original.error?.message ?? "no signed URL"}`
    );
  }
  return {
    bucket: UPLOAD_BUCKET,
    path,
    token: main.data.token,
    original: { path: originalPath, token: original.data.token },
  };
}

/**
 * Best-effort delete of an uploaded-but-never-saved temp object, plus the
 * pre-crop original beside it. Never throws — losing a temp object is not worth
 * failing anything the user is waiting on. Removing a key that was never written
 * is a no-op, so the `.original` is always safe to include.
 */
export async function discardStatementUpload(storageKey: string): Promise<void> {
  if (!storageKey) return;
  try {
    const sb = await getSupabaseServer();
    const orgId = await requireOrgId(sb);
    if (!isOwnedStorageKey(storageKey, orgId)) return;
    await getSupabaseAdmin()
      .storage.from(UPLOAD_BUCKET)
      .remove([
        storageKey,
        originalStorageKey(storageKey),
        transcriptStorageKey(storageKey),
      ]);
  } catch (error) {
    console.error("discardStatementUpload failed", error);
  }
}

/** A short-lived signed URL to view a statement's stored PDF. */
export async function getStatementFileUrl(
  storageKey: string
): Promise<string | null> {
  if (!storageKey) return null;
  const sb = await getSupabaseServer();
  const orgId = await requireOrgId(sb);
  if (!isOwnedStorageKey(storageKey, orgId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .storage.from(UPLOAD_BUCKET)
    .createSignedUrl(storageKey, 60 * 60);
  if (error || !data) return null;
  return data.signedUrl;
}

// --- Save (create / review) ------------------------------------------------

const lineSchema = z.object({
  /** The stored line this row is, when it has one. See `replaceStatementLines`. */
  id: z.string().uuid().optional(),
  leaseId: z.string().trim().nullable().default(null),
  tankId: z.string().trim().nullable().default(null),
  meterId: z.string().trim().nullable().default(null),
  leaseRef: z.string().trim().default(""),
  tankRef: z.string().trim().default(""),
  meterRef: z.string().trim().default(""),
  product: z.enum(["oil", "gas"]),
  volume: z.number().finite().default(0),
  price: z.number().finite().nullable().default(null),
  grossValue: z.number().finite().default(0),
  deducts: z.number().finite().default(0),
  taxes: z.number().finite().default(0),
  netValue: z.number().finite().default(0),
  mmbtu: z.number().finite().nullable().default(null),
  allocatedQty: z.number().finite().nullable().default(null),
  producerPct: z.number().finite().nullable().default(null),
  settleQty: z.number().finite().nullable().default(null),
  fees: z.number().finite().default(0),
  raw: z.record(z.string(), z.unknown()).default({}),
});

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date");

const savePayloadSchema = z.object({
  statementId: z.string().uuid().nullable().default(null),
  purchaserPhone: z.string().trim().default(""),
  purchaserEmail: z.string().trim().default(""),
  purchaserContact: z.string().trim().default(""),
  purchaser: z.string().trim().default(""),
  statementNo: z.string().trim().default(""),
  checkNo: z.string().trim().default(""),
  periodStart: iso,
  periodEnd: iso,
  product: z.enum(["oil", "gas", "mixed"]).default("oil"),
  notes: z.string().trim().default(""),
  status: z.enum(["received", "extracted", "reviewed"]).default("reviewed"),
  lineItems: z.array(lineSchema).default([]),
  storageKey: z.string().nullable().default(null),
  fileName: z.string().nullable().default(null),
  mime: z.string().nullable().default(null),
  size: z.number().nullable().default(null),
  /**
   * Crop provenance from the browser's hygiene step. Accepted loosely here and
   * re-validated through `parseHygiene` below rather than trusted — this is
   * client-supplied JSON headed for a `jsonb` column, so a malformed payload
   * must degrade to "no metadata", never poison the row or fail the save.
   */
  hygiene: z.record(z.string(), z.unknown()).nullable().default(null),
});

/**
 * Create or update a statement from the review step: writes the header and
 * replaces the line items wholesale (which recomputes the header totals), then
 * stamps the status. Returns the statement id so the caller can navigate to its
 * detail page. The PDF bytes are NOT sent here — they were streamed to Storage.
 */
/**
 * Refuse a second save of a statement that is already on file.
 *
 * With posting retired, saving IS what puts a payment in the ledger, so the old
 * post-time duplicate checklist is gone and this is the last place a re-upload can
 * be caught. The key is the purchaser plus the printed statement number, which is
 * an identity claim about the document itself. Deliberately NOT purchaser plus
 * period: a purchaser really does send several statements covering one month (one
 * per lease is common), and blocking those would refuse real money.
 *
 * A statement with no printed number cannot be identified this way and is allowed
 * through; the duplicate then shows as a second row the user can see and delete.
 */
async function assertNotDuplicateStatement(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  purchaser: string,
  statementNo: string,
  excludeId?: string
): Promise<void> {
  const name = purchaser.trim();
  const no = statementNo.trim();
  if (!name || !no) return;

  let query = sb
    .from("statements")
    .select("id, statement_no, purchasers(name)")
    .eq("statement_no", no);
  if (excludeId) query = query.neq("id", excludeId);
  const { data, error } = await query;
  if (error) throw new Error(`saveStatement (duplicate check): ${error.message}`);

  const hit = ((data ?? []) as unknown as {
    id: string;
    purchasers: { name: string | null } | null;
  }[]).find(
    (r) => (r.purchasers?.name ?? "").trim().toLowerCase() === name.toLowerCase()
  );
  if (hit) {
    throw new Error(
      `${name} statement ${no} is already on file. Open the existing one to correct it, or change the statement number.`
    );
  }
}

export async function saveStatement(
  formData: FormData
): Promise<{ id: string }> {
  await requireManage();
  const raw = formData.get("payload");
  if (typeof raw !== "string") throw new Error("saveStatement: missing payload");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("saveStatement: payload is not valid JSON");
  }
  const payload = savePayloadSchema.parse(parsed);

  const sb = await getSupabaseServer();
  const user = await getSessionUser();

  // Re-validate the crop metadata server-side and pair it with the original's
  // storage key. The browser already wrote the original to its own signed URL,
  // so unlike the `files` path there is nothing to upload here — only to record.
  // Null for every non-photo, which is the common case.
  const meta = parseHygiene(
    payload.hygiene ? JSON.stringify(payload.hygiene) : null
  );
  const hygiene: StoredHygiene | null =
    meta && payload.storageKey
      ? {
          ...meta,
          originalKey:
            meta.cropped || meta.rotatedDeg !== 0
              ? originalStorageKey(payload.storageKey)
              : null,
          source: "revenue-upload",
        }
      : null;

  // Saving is what puts these payments in the ledger, so this is the gate.
  await assertNotDuplicateStatement(
    sb,
    payload.purchaser,
    payload.statementNo,
    payload.statementId ?? undefined
  );

  let statementId = payload.statementId;
  if (statementId) {
    await updateStatement(sb, statementId, {
      purchaser: payload.purchaser,
      statementNo: payload.statementNo,
      checkNo: payload.checkNo,
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      product: payload.product as StatementProduct,
      status: payload.status as StatementStatus,
      notes: payload.notes,
      updatedBy: user?.id ?? null,
    });
  } else {
    const created = await createStatement(sb, {
      purchaser: payload.purchaser,
      statementNo: payload.statementNo,
      checkNo: payload.checkNo,
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      product: payload.product as StatementProduct,
      storageKey: payload.storageKey,
      fileName: payload.fileName,
      mime: payload.mime,
      size: payload.size,
      notes: payload.notes,
      hygiene,
    });
    statementId = created.id;
    // A freshly-created statement saved from the review step is already reviewed.
    await updateStatement(sb, statementId, {
      status: payload.status as StatementStatus,
      updatedBy: user?.id ?? null,
    });
  }

  /*
   * The purchaser's own contact details, filed with the statement that carried
   * them.
   *
   * `getOrCreatePurchaser` mints a NAME and nothing else, so a purchaser first
   * seen through /revenue arrived in People as a bare row — the company that
   * pays this operator every month, with no phone number against it, while the
   * statement printing one sat two clicks away. The Data Entry path already did
   * this (`writeOilRunStatements`); this path never had the fields.
   *
   * Non-destructive by the same rule as there: `upsertPurchaserContact` fills a
   * blank and never overwrites, so re-filing statements cannot clobber a number
   * the team curated. Best-effort — the statement is the record, and a contact
   * that failed to attach must not fail the save.
   */
  if (
    payload.purchaser &&
    (payload.purchaserPhone || payload.purchaserEmail || payload.purchaserContact)
  ) {
    try {
      const purchaserId = await getOrCreatePurchaser(sb, payload.purchaser);
      if (purchaserId) {
        await upsertPurchaserContact(sb, purchaserId, {
          phone: payload.purchaserPhone,
          email: payload.purchaserEmail,
          contactName: payload.purchaserContact,
        });
      }
    } catch (err) {
      ierr("statements: purchaser contact not filed", errorInfo(err));
    }
  }

  await replaceStatementLines(
    sb,
    statementId,
    payload.lineItems.map((l) => ({
      leaseId: l.leaseId || null,
      tankId: l.tankId || null,
      meterId: l.meterId || null,
      leaseRef: l.leaseRef,
      tankRef: l.tankRef,
      meterRef: l.meterRef,
      product: l.product as LineProduct,
      volume: l.volume,
      price: l.price,
      grossValue: l.grossValue,
      deducts: l.deducts,
      taxes: l.taxes,
      netValue: l.netValue,
      mmbtu: l.mmbtu,
      allocatedQty: l.allocatedQty,
      producerPct: l.producerPct,
      settleQty: l.settleQty,
      // Null means "not applicable on this product", which is zero fees.
      fees: l.fees ?? 0,
      raw: l.raw,
    }))
  );

  revalidatePath("/revenue");
  revalidatePath(`/revenue/statements/${statementId}`);
  return { id: statementId };
}

// --- Cross-domain backfill (docs/plans/cross-domain-backfill.md) -----------

/**
 * The ingest types a statement upload may propose as backfill. Nothing else is
 * accepted from the client: a statement carries lease names (P2), the purchaser
 * that paid it, and, for run statements, the meters a gas settlement settles
 * by, tank refs and per-run hauls (P4) — not equipment, and not wells: a
 * settlement line names a lease, a tank or a meter, never a well, so there is
 * nothing to seed one from.
 *
 * `purchasers` writes to the `gatherers` directory, not to the `purchasers`
 * table `saveStatement` files against — see `purchaser-backfill.ts`.
 */
const STATEMENT_BACKFILL_TYPES = [
  "purchasers",
  "leases",
  "meters",
  "tanks",
  "runTickets",
] as const;
type StatementBackfillType = (typeof STATEMENT_BACKFILL_TYPES)[number];

export interface StatementBackfillDraft {
  type: StatementBackfillType;
  rows: unknown[];
}

/**
 * Persist a statement upload's SECONDARY data — the purchaser, leases, meters,
 * tanks and run tickets the document named that are not on file — as ordinary
 * ingest proposals, and
 * return them for the modal to enqueue as approval cards after its own save.
 *
 * The statement itself is never proposed here (design rule 3 of the plan: it
 * is filed exactly once, by `saveStatement`). Rows are re-validated against
 * the ingest row schemas — a row that doesn't parse drops its draft rather
 * than poisoning the card — and scan-time suppression runs inside the bridge,
 * so anything already on file never becomes a card. Approving a card re-checks
 * the per-type capability (`manage_leases`, `manage_well_production`,
 * `manage_statements`), so this action only needs the caller to be a
 * statements user.
 */
export async function proposeStatementBackfill(input: {
  fileName: string;
  drafts: StatementBackfillDraft[];
}): Promise<IngestProposal[]> {
  await requireManage();
  const fileName = String(input.fileName ?? "").slice(0, 300);
  const drafts: ProposalDraft[] = [];
  for (const d of input.drafts ?? []) {
    if (!STATEMENT_BACKFILL_TYPES.includes(d.type)) continue;
    const rows = z.array(INGEST_ROW_SCHEMA[d.type]).safeParse(d.rows);
    if (!rows.success || rows.data.length === 0) continue;
    drafts.push({ type: d.type, wellId: null, rows: rows.data });
  }
  if (drafts.length === 0) return [];
  const sb = await getSupabaseServer();
  // No `files` row exists for a statement upload (its bytes live in the
  // statement bucket), so the proposals carry only the file name.
  return proposeBackfillDrafts(sb, { fileId: null, fileName, drafts });
}

/**
 * The run-grain backfill for an upload, run AFTER its statements are saved.
 *
 * Moved off the extract request on purpose. It is a second full extraction of
 * the same document — categorize, then an analyze ⇄ validate loop at run grain
 * — and nothing reads its output until the save is done: the tank reconcile
 * step and the approval cards both happen on the way out of the modal. Awaiting
 * it before returning the extraction put that whole pass between the user and
 * the review screen they were waiting on.
 *
 * Reads the transcript stored beside the upload, so deferring costs no second
 * transcription. Returns null when there is no transcript, when the document is
 * not a run statement, or on any failure — the statements are already filed and
 * a missing bonus pass must never read as a failed save.
 */
export async function computeStatementBackfill(
  storageKey: string
): Promise<StatementRunBackfill | null> {
  await requireManage();
  const sb = await getSupabaseServer();
  const orgId = await requireOrgId(sb);
  if (!storageKey || !isOwnedStorageKey(storageKey, orgId)) return null;
  const text = await readStatementTranscript(storageKey);
  if (!text) {
    ilog("statements: no stored transcript, skipping backfill", { storageKey });
    return null;
  }
  return computeRunStatementBackfill(sb, text);
}

/** Move a statement to a new lifecycle status. */
export async function setStatementStatus(
  id: string,
  status: StatementStatus
): Promise<void> {
  await requireManage();
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await updateStatement(sb, id, { status, updatedBy: user?.id ?? null });
  revalidatePath("/revenue");
  revalidatePath(`/revenue/statements/${id}`);
}

/**
 * Apply a Payments-table edit to the settlement line it derives from
 * (docs/plans/derived-payments.md §6).
 *
 * Only the LINE's own fields land here. Date, counterparty and statement number
 * belong to the statement, not to one of its lines: a settlement has one purchaser
 * and one period by construction, so writing them per row would either invent a
 * per-line override or silently move every sibling row. Those cells render static
 * in Payments and are edited on the statement.
 *
 * `raw` is never touched, so what the extractor originally read off the document
 * survives every correction.
 */
export async function updatePaymentLine(
  lineId: string,
  draft: DraftTransaction
): Promise<void> {
  await requireManage();
  z.string().uuid().parse(lineId);
  const sb = await getSupabaseServer();

  const { data: current, error: readError } = await sb
    .from("statement_line_items")
    .select("id, statement_id, taxes, fees")
    .eq("id", lineId)
    .maybeSingle();
  if (readError) {
    throw new Error(`updatePaymentLine (read): ${readError.message}`);
  }
  if (!current) throw new Error("updatePaymentLine: line not found");
  const line = current as {
    statement_id: string;
    taxes: number | string | null;
    fees: number | string | null;
  };

  // The ledger shows taxes and fees as one severance column, so an edit to it has
  // to be split back across two. Fees are a separately printed number and stay
  // put; taxes take the remainder. Only when the new total is BELOW the recorded
  // fees do the fees give way, which keeps both columns non-negative and makes the
  // projection reproduce exactly what was typed.
  const fees = Number(line.fees ?? 0) || 0;
  const total = draft.prodTax ?? 0;
  const nextFees = total < fees ? total : fees;
  const nextTaxes = total - nextFees;

  // A lease written here wins the resolution ladder outright
  // (`resolveLeaseId`), so a choice made in Payments sticks. Clearing the cell
  // hands the line back to the matchers.
  const leaseId = draft.leaseId || null;

  const { error } = await sb
    .from("statement_line_items")
    .update({
      volume: draft.volume ?? 0,
      price: draft.price,
      net_value: draft.amount,
      taxes: nextTaxes,
      fees: nextFees,
      category_code: draft.categoryCode || null,
      lease_id: leaseId,
    })
    .eq("id", lineId);
  if (error) throw new Error(`updatePaymentLine: ${error.message}`);

  revalidatePath("/revenue");
  revalidatePath(`/revenue/statements/${line.statement_id}`);
  revalidatePath("/accounting");
  revalidatePath("/leases", "layout");
}

/**
 * Delete one payment: a soft delete on the statement line it derives from.
 *
 * The line is the only row a projected payment has, so this is where the deletion
 * lands. It withdraws the claim entirely, money AND barrels: `orgStatementLines`
 * drops deleted lines at the query, so the volume leaves the production series in
 * the same breath as the dollars leave the ledger. The statement's own totals still
 * count it, because those describe the document, not the ledger.
 */
export async function deletePaymentLine(lineId: string): Promise<void> {
  await requireManage();
  z.string().uuid().parse(lineId);
  const sb = await getSupabaseServer();

  const { data: current } = await sb
    .from("statement_line_items")
    .select("statement_id")
    .eq("id", lineId)
    .maybeSingle();

  const { error } = await sb
    .from("statement_line_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", lineId);
  if (error) throw new Error(`deletePaymentLine: ${error.message}`);

  const statementId = (current as { statement_id: string } | null)?.statement_id;
  revalidatePath("/revenue");
  if (statementId) revalidatePath(`/revenue/statements/${statementId}`);
  revalidatePath("/accounting");
  revalidatePath("/leases", "layout");
}


/**
 * Delete a statement (cascades its line items) and remove its stored PDF. Any
 * revenue already posted to the ledger is kept: the transaction's `statement_id`
 * link is cleared (FK `on delete set null`), not unposted. Use `unpostStatement`
 * first to remove the revenue.
 */
export async function deleteStatement(id: string): Promise<void> {
  await requireManage();
  const sb = await getSupabaseServer();
  const statement = await getStatement(sb, id);
  const { error } = await sb.from("statements").delete().eq("id", id);
  if (error) throw new Error(`deleteStatement: ${error.message}`);
  if (statement?.storageKey) {
    try {
      // The pre-crop original rides along; removing a key that was never
      // written is a no-op, so this needs no branch on `hygiene`.
      await getSupabaseAdmin()
        .storage.from(UPLOAD_BUCKET)
        .remove([
          statement.storageKey,
          originalStorageKey(statement.storageKey),
          transcriptStorageKey(statement.storageKey),
        ]);
    } catch (err) {
      console.error("deleteStatement: failed to remove file", err);
    }
  }
  // /revenue hosts the statements list; /accounting shows revenue it fed.
  revalidatePath("/revenue");
  revalidatePath("/revenue");
  revalidatePath("/accounting");
}
