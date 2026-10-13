"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth/permissions";
import { parseCategories } from "@/lib/accounting/categories";
import {
  ACCOUNTING_UPLOAD_BUCKET as UPLOAD_BUCKET,
  createUploadTarget,
  isOwnedStorageKey,
} from "@/lib/accounting/storage";
import type { DraftTransaction, Transaction } from "@/lib/accounting/types";
import { lineIdFromTransactionId } from "@/lib/statements/payments";
import { expenseLineIdFromTransactionId } from "@/lib/invoices/expenses";
import {
  deleteExpenseLine,
  updateExpenseLine,
} from "@/lib/invoices/actions";
import {
  deletePaymentLine,
  updatePaymentLine,
} from "@/lib/statements/actions";
import {
  mapTransaction,
  TRANSACTION_SELECT,
  type TransactionRow,
} from "@/lib/accounting/ledger";

/** Resolve the signed-in user's org id, or throw if there isn't one. */
async function requireOrgId(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>
): Promise<string> {
  const { data: orgId, error } = await sb.rpc("current_org_id");
  if (error || !orgId) {
    throw new Error("No organization for the current user.");
  }
  return orgId as string;
}

const draftSchema = z
  .object({
    kind: z.enum(["revenue", "expense"]),
    counterparty: z.string().trim().default(""),
    // Revenue MAY be negative — a net-negative settlement (e.g. a gas POP month
    // where plant fees exceed the value) is a legitimate negative revenue.
    // Expenses stay a positive magnitude.
    amount: z.number().finite(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date"),
    category: z.string().trim().default(""),
    categoryCode: z.string().trim().default(""),
    invoiceNumber: z.string().trim().default(""),
    // Revenue is attributed to a lease; expenses to a well.
    wellId: z.string().trim().default(""),
    leaseId: z.string().trim().default(""),
    volume: z.number().finite().nullable(),
    price: z.number().finite().nullable(),
    prodTax: z.number().finite().nullable(),
    nri: z.number().finite().nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.kind === "expense" && d.amount < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "expense amount must be >= 0",
      });
    }
  });

/** Maps a validated draft to a ledger row. Revenue fields are dropped for expenses. */
function toRow(d: DraftTransaction) {
  const isRevenue = d.kind === "revenue";
  return {
    kind: d.kind,
    counterparty: d.counterparty,
    amount: d.amount,
    txn_date: d.date,
    category: d.category,
    category_code: d.categoryCode,
    invoice_number: d.invoiceNumber,
    // Revenue is attributed to a lease; expenses (and legacy/ingest revenue that
    // only knows a well) keep their well. Manual revenue sets leaseId + no well.
    well_id: d.wellId || null,
    lease_id: isRevenue ? d.leaseId || null : null,
    volume: isRevenue ? d.volume : null,
    price: isRevenue ? d.price : null,
    prod_tax: isRevenue ? d.prodTax : null,
    nri: isRevenue ? d.nri : null,
  };
}

function revalidate(
  rows: { well_id: string | null; lease_id: string | null }[]
): void {
  revalidateWells(rows.map((r) => r.well_id));
  revalidatePath("/revenue");
  for (const leaseId of new Set(rows.map((r) => r.lease_id))) {
    if (leaseId) revalidatePath("/leases", "layout");
  }
}

/** Revalidate the ledger and every affected per-well accounting page. */
function revalidateWells(wellIds: (string | null)[]): void {
  revalidatePath("/accounting");
  for (const wellId of new Set(wellIds)) {
    if (wellId) revalidatePath(`/accounting/${wellId}`);
  }
}

/**
 * Persists one or more transactions to the ledger. Used both by the manual
 * entry form (single) and the OCR upload flow (a batch of reviewed drafts).
 */
export async function createTransactions(
  drafts: DraftTransaction[]
): Promise<{ created: number }> {
  if (drafts.length === 0) return { created: 0 };

  const parsed = z.array(draftSchema).parse(drafts);
  const rows = parsed.map(toRow);

  const sb = await getSupabaseServer();
  const { error } = await sb.from("transactions").insert(rows);
  if (error) throw new Error(`createTransactions: ${error.message}`);

  revalidate(rows);
  return { created: rows.length };
}

const wellExpenseSchema = z.object({
  counterparty: z.string().trim().default(""),
  amount: z.number().finite().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date"),
  category: z.string().trim().default(""),
  categoryCode: z.string().trim().default(""),
  invoiceNumber: z.string().trim().default(""),
});

export type WellExpenseInput = z.input<typeof wellExpenseSchema>;

/**
 * Record a single expense against one well, from the well page. Returns the
 * persisted row (with id) so the caller can reflect it optimistically. Writes
 * go through RLS (`manage_statements`), which also stamps the org.
 */
export async function createWellExpense(
  wellId: string,
  input: WellExpenseInput
): Promise<Transaction> {
  const parsed = wellExpenseSchema.parse(input);
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("transactions")
    .insert({
      kind: "expense",
      counterparty: parsed.counterparty,
      amount: parsed.amount,
      txn_date: parsed.date,
      category: parsed.category,
      category_code: parsed.categoryCode,
      invoice_number: parsed.invoiceNumber,
      well_id: wellId,
      volume: null,
      price: null,
      prod_tax: null,
      nri: null,
    })
    .select(TRANSACTION_SELECT)
    .single();
  if (error || !data) {
    throw new Error(`createWellExpense: ${error?.message ?? "no row returned"}`);
  }

  revalidatePath(`/wells/${wellId}`);
  revalidateWells([wellId]);
  return mapTransaction(data as unknown as TransactionRow);
}

/** The reviewed batch the client commits after OCR: drafts plus a pointer to
 * the already-uploaded source file (uploaded direct-to-storage, so it never
 * passes through this function and isn't bounded by the serverless body cap). */
const saveBatchSchema = z.object({
  drafts: z.array(draftSchema),
  storageKey: z.string().min(1).nullable().default(null),
  fileName: z.string().default("upload"),
  mime: z.string().nullable().default(null),
  size: z.number().int().nonnegative().nullable().default(null),
});

/**
 * Mint a one-time signed upload URL so the browser can stream a (potentially
 * large) accounting file straight to private Storage, bypassing the platform's
 * serverless request-body limit that a multipart POST through a route/action
 * would hit. The returned `path` is namespaced under the caller's org so it
 * can't collide with or impersonate another org's keys; the client uploads
 * with `uploadToSignedUrl(path, token, file)`, then hands `path` back to the
 * extract route and to `saveUploadedTransactions`.
 */
export async function createAccountingUploadTarget(): Promise<{
  bucket: string;
  path: string;
  token: string;
}> {
  const sb = await getSupabaseServer();
  const orgId = await requireOrgId(sb);
  // Shared with `/api/tanks/run-tickets/upload-url`, which serves the same need
  // for mobile — a `"use server"` action is React-RPC bound and unreachable from
  // Expo, so the minting itself lives in a plain module both can call.
  return createUploadTarget(getSupabaseAdmin(), orgId);
}

/**
 * Best-effort delete of an uploaded-but-never-saved temp object (the user
 * closed the modal or replaced the file). Verifies org ownership so a forged
 * key can't delete another org's bytes; never throws — cleanup is advisory.
 */
export async function discardAccountingUpload(storageKey: string): Promise<void> {
  if (!storageKey) return;
  try {
    const sb = await getSupabaseServer();
    const orgId = await requireOrgId(sb);
    if (!isOwnedStorageKey(storageKey, orgId)) return;
    await getSupabaseAdmin().storage.from(UPLOAD_BUCKET).remove([storageKey]);
  } catch (error) {
    console.error("discardAccountingUpload failed", error);
  }
}

/**
 * Saves an OCR upload batch: records an `accounting_uploads` row pointing at the
 * already-uploaded original file and inserts the reviewed transactions linked to
 * it via `upload_id`. Because that FK cascades, deleting the upload later removes
 * the whole batch. The payload (drafts + storage pointer) arrives as JSON in
 * `formData`; the file bytes are NOT sent here — they were streamed straight to
 * Storage by the browser, so this stays well under the serverless body cap.
 *
 * On partial failure the file object and upload row are cleaned up so a retry
 * starts clean (no orphaned batch).
 */
export async function saveUploadedTransactions(
  formData: FormData
): Promise<{ created: number }> {
  const payloadRaw = formData.get("payload");
  if (typeof payloadRaw !== "string") {
    throw new Error("saveUploadedTransactions: missing payload");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    throw new Error("saveUploadedTransactions: payload is not valid JSON");
  }
  const { drafts, storageKey, fileName, mime, size } =
    saveBatchSchema.parse(payload);
  if (drafts.length === 0) return { created: 0 };

  const rows = drafts.map(toRow);
  const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);

  const sb = await getSupabaseServer();

  // 1. The original file is already in Storage (uploaded direct-to-bucket).
  // Verify the key belongs to this org before linking it to the batch.
  if (storageKey) {
    const orgId = await requireOrgId(sb);
    if (!isOwnedStorageKey(storageKey, orgId)) {
      throw new Error("saveUploadedTransactions: storage key is not owned");
    }
  }

  // 2. Record the upload batch (org_id defaults to current_org_id() via RLS).
  const { data: upload, error: upErr } = await sb
    .from("accounting_uploads")
    .insert({
      file_name: fileName,
      mime,
      size,
      storage_key: storageKey,
      txn_count: rows.length,
      total_amount: totalAmount,
    })
    .select("id")
    .single();
  if (upErr || !upload) {
    if (storageKey) {
      await getSupabaseAdmin().storage.from(UPLOAD_BUCKET).remove([storageKey]);
    }
    throw new Error(`saveUploadedTransactions (upload): ${upErr?.message ?? "insert failed"}`);
  }

  // 3. Insert the transactions linked to the batch.
  const uploadId = (upload as { id: string }).id;
  const { error: txErr } = await sb
    .from("transactions")
    .insert(rows.map((r) => ({ ...r, upload_id: uploadId })));
  if (txErr) {
    // Roll the batch back: drop the upload row (cascade — no txns yet) + file.
    await sb.from("accounting_uploads").delete().eq("id", uploadId);
    if (storageKey) {
      await getSupabaseAdmin().storage.from(UPLOAD_BUCKET).remove([storageKey]);
    }
    throw new Error(`saveUploadedTransactions (transactions): ${txErr.message}`);
  }

  revalidate(rows);
  return { created: rows.length };
}

/**
 * Deletes an upload batch: removes the `accounting_uploads` row (which cascades
 * to every transaction created from it) and the stored file. This is the
 * one-step "undo" for a file upload.
 */
export async function deleteUpload(uploadId: string): Promise<void> {
  z.string().uuid().parse(uploadId);
  const sb = await getSupabaseServer();

  // Read the storage key + the batch's wells (for revalidation) before deleting.
  const { data: upload, error: readErr } = await sb
    .from("accounting_uploads")
    .select("storage_key")
    .eq("id", uploadId)
    .maybeSingle();
  if (readErr) throw new Error(`deleteUpload (read): ${readErr.message}`);
  if (!upload) return;

  const { data: txns } = await sb
    .from("transactions")
    .select("well_id")
    .eq("upload_id", uploadId);
  const wellIds = (txns ?? []).map((t) => (t as { well_id: string | null }).well_id);

  // Delete the batch — transactions go with it via ON DELETE CASCADE.
  const { error: delErr } = await sb
    .from("accounting_uploads")
    .delete()
    .eq("id", uploadId);
  if (delErr) throw new Error(`deleteUpload: ${delErr.message}`);

  const storageKey = (upload as { storage_key: string | null }).storage_key;
  if (storageKey) {
    await getSupabaseAdmin().storage.from(UPLOAD_BUCKET).remove([storageKey]);
  }

  revalidateWells(wellIds);
}

/**
 * Updates a single transaction in place (Ledger click-to-edit). Revalidates the
 * ledger plus both the old and new well pages, in case the well changed.
 */
export async function updateTransaction(
  id: string,
  draft: DraftTransaction
): Promise<void> {
  // A projected row has no ledger row to write: its id names the document line it
  // derives from — a settlement line or an invoice charge line — and the edit
  // belongs there (docs/plans/derived-payments.md §6).
  const lineId = lineIdFromTransactionId(id);
  if (lineId) return updatePaymentLine(lineId, draft);
  const chargeLineId = expenseLineIdFromTransactionId(id);
  if (chargeLineId) return updateExpenseLine(chargeLineId, draft);
  z.string().uuid().parse(id);
  const parsed = draftSchema.parse(draft);
  const row = toRow(parsed);

  const sb = await getSupabaseServer();

  // The previous well, so its page revalidates if the transaction moves wells.
  const { data: prev } = await sb
    .from("transactions")
    .select("well_id")
    .eq("id", id)
    .maybeSingle();

  const { error } = await sb.from("transactions").update(row).eq("id", id);
  if (error) throw new Error(`updateTransaction: ${error.message}`);

  revalidateWells([row.well_id, (prev as { well_id: string | null } | null)?.well_id ?? null]);
}

/**
 * Permanently deletes the given transactions (Ledger multi-select).
 *
 * Projected payments route to their statement line instead, which is a soft delete
 * there: the row this would delete does not exist.
 */
export async function deleteTransactions(ids: string[]): Promise<void> {
  const lineIds = ids
    .map(lineIdFromTransactionId)
    .filter((v): v is string => v !== null);
  for (const lineId of lineIds) await deletePaymentLine(lineId);

  const chargeLineIds = ids
    .map(expenseLineIdFromTransactionId)
    .filter((v): v is string => v !== null);
  for (const lineId of chargeLineIds) await deleteExpenseLine(lineId);

  const parsed = z
    .array(z.string().uuid())
    .parse(
      ids.filter(
        (id) =>
          lineIdFromTransactionId(id) === null &&
          expenseLineIdFromTransactionId(id) === null
      )
    );
  if (parsed.length === 0) return;

  const sb = await getSupabaseServer();

  // Capture affected wells before deletion so their pages revalidate.
  const { data: txns } = await sb
    .from("transactions")
    .select("well_id")
    .in("id", parsed);
  const wellIds = (txns ?? []).map((t) => (t as { well_id: string | null }).well_id);

  const { error } = await sb.from("transactions").delete().in("id", parsed);
  if (error) throw new Error(`deleteTransactions: ${error.message}`);

  revalidateWells(wellIds);
}

/**
 * Saves the org's chart of accounts (Settings → Accounting). Validates the JSON
 * text and writes the normalized array to the organization row (owner-gated by
 * RLS). Returns a field error instead of throwing on malformed input.
 */
export async function saveAccountingCategories(
  text: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Category config is an org setting — admin only.
  await requireAdmin();
  const parsed = parseCategories(text);
  if (!parsed.ok) return parsed;

  const sb = await getSupabaseServer();
  const { data: org, error: readError } = await sb
    .from("organizations")
    .select("id")
    .maybeSingle();
  if (readError) throw new Error(`saveAccountingCategories: ${readError.message}`);
  if (!org) return { ok: false, error: "No organization found." };

  const { error } = await sb
    .from("organizations")
    .update({ accounting_categories: parsed.categories })
    .eq("id", org.id);
  if (error) throw new Error(`saveAccountingCategories: ${error.message}`);

  revalidatePath("/settings");
  revalidatePath("/accounting");
  return { ok: true };
}
