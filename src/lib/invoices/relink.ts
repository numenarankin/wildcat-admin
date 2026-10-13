import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { canonical } from "@/lib/ai/ingest/normalize";
import { providerKey } from "@/lib/ai/ingest/dedup-keys";
import { getServiceProviders } from "@/lib/people/people";
import { getWells } from "@/lib/wells/wells";
import { getLeases } from "@/lib/leases/actions";
import { addInvoiceFacilities } from "@/lib/invoices/facilities";
import { facilityNameFrom } from "@/lib/invoices/facility-backfill";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";
import type { InvoiceFacility } from "@/lib/invoices/facility-types";

/**
 * Attach the invoices that were waiting on a record that did not exist yet.
 *
 * An invoice is filed the moment it is read, whether or not its vendor is in
 * the directory and whether or not the property it names is on file. Approving
 * the card that creates one of those is the moment the earlier invoice can
 * finally point at it — and if nothing does that, the app holds two answers to
 * the same question forever: the vendor is in People, and the invoice it came
 * from still says it resolved to nobody.
 *
 * Both passes are idempotent, match on the same canonical keys the write step
 * uses (`providerKey`, `canonical`), and only ever fill a NULL. A correction a
 * person made by hand is never overwritten, and neither is a facility set they
 * curated: `addInvoiceFacilities` adds, it does not replace.
 *
 * Best-effort by design. This runs behind an approval that already succeeded;
 * failing it would report "could not add the vendor" for a vendor that was
 * added.
 */

type Sb = SupabaseClient;

/** Postgres: relation/column does not exist — the migration is not applied. */
const MISSING = new Set(["42P01", "42703"]);

function isMissingSchema(error: { code?: string } | null): boolean {
  return !!error?.code && MISSING.has(error.code);
}

/**
 * Point unresolved invoices at a vendor that now exists.
 *
 * Matches `vendor_text` (what the letterhead said) against the directory by the
 * same key ingest deduped on, so "EXO ENERGY SERVICE, LLC" finds "Exo Energy
 * Service LLC".
 */
export async function relinkInvoiceVendors(sb: Sb): Promise<number> {
  const { data, error } = await sb
    .from("pidx_documents")
    .select("id, vendor_text")
    .is("vendor_id", null)
    .is("deleted_at", null)
    .not("vendor_text", "is", null);
  if (error) {
    if (isMissingSchema(error)) return 0;
    throw new Error(`relinkInvoiceVendors: ${error.message}`);
  }
  if (!data || data.length === 0) return 0;

  const byKey = new Map(
    (await getServiceProviders()).map((p) => [providerKey(p.company), p.id] as const)
  );

  let linked = 0;
  for (const doc of data) {
    const id = byKey.get(providerKey((doc.vendor_text as string) ?? ""));
    if (!id) continue;
    const { error: upErr } = await sb
      .from("pidx_documents")
      .update({ vendor_id: id })
      .eq("id", doc.id as string)
      .is("vendor_id", null);
    if (upErr) {
      ierr("relink: vendor update failed", errorInfo(upErr));
      continue;
    }
    linked += 1;
  }
  if (linked > 0) ilog("relink: vendors", { linked });
  return linked;
}

/**
 * Tag and line-resolve the invoices whose property is now on file.
 *
 * Reads the property the way the facility card created it — `facilityNameFrom`,
 * so "Sky Resources - Brown #1" matches the well called "Brown #1" — and writes
 * both halves the original file would have written: the document's facility tag
 * (what its Invoices tab reads) and the line's `well_id` / `lease_id` (what
 * spend-by-well reads). Filling one and not the other is how the same invoice
 * shows on a well's tab but is missing from that well's spend.
 */
export async function relinkInvoiceProperties(sb: Sb): Promise<number> {
  const { data, error } = await sb
    .from("pidx_lines")
    .select("id, document_id, raw_property_text")
    .is("well_id", null)
    .is("lease_id", null)
    .not("raw_property_text", "is", null);
  if (error) {
    if (isMissingSchema(error)) return 0;
    throw new Error(`relinkInvoiceProperties: ${error.message}`);
  }
  if (!data || data.length === 0) return 0;

  const wells = await getWells();
  const leases = await getLeases();
  const wellByKey = new Map(wells.map((w) => [canonical(w.name), w] as const));
  const leaseByKey = new Map(leases.map((l) => [canonical(l.name), l] as const));

  let linked = 0;
  const taggedDocs = new Set<string>();

  for (const line of data) {
    const printed = (line.raw_property_text as string | null) ?? "";
    const key = canonical(facilityNameFrom(printed));
    if (!key) continue;
    const well = wellByKey.get(key);
    const lease = well ? undefined : leaseByKey.get(key);
    if (!well && !lease) continue;

    const { error: upErr } = await sb
      .from("pidx_lines")
      .update(well ? { well_id: well.id } : { lease_id: lease!.id })
      .eq("id", line.id as string)
      .is("well_id", null)
      .is("lease_id", null);
    if (upErr) {
      ierr("relink: line update failed", errorInfo(upErr));
      continue;
    }
    linked += 1;

    const documentId = line.document_id as string;
    if (taggedDocs.has(documentId)) continue;
    taggedDocs.add(documentId);
    const facility: InvoiceFacility = well
      ? { type: "well", id: well.id, label: well.name }
      : { type: "lease", id: lease!.id, label: lease!.name };
    try {
      await addInvoiceFacilities(sb, documentId, [facility]);
    } catch (err) {
      // The line points at the facility either way; a missing tab entry is a
      // correction away, and failing here would strand the rest of the batch.
      ierr("relink: facility tag failed", errorInfo(err));
    }
  }
  if (linked > 0) ilog("relink: properties", { linked, documents: taggedDocs.size });
  return linked;
}
