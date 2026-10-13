import { cachedTanks, cachedMeters } from "@/lib/cache/loaders";
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/supabase/server";
import {
  isInvoiceFacilityType,
  type InvoiceFacility,
  type InvoiceFacilityType,
} from "@/lib/invoices/facility-types";

/**
 * Which facilities an invoice is against (`invoice_facilities`, 2026081500200).
 *
 * This is the DOCUMENT-level set a person maintains. It is deliberately separate
 * from `pidx_lines.well_id` / `lease_id` / `facility_*`, which are what the
 * extractor resolved for one charge line and are never rewritten here: the line
 * columns are evidence about what the vendor printed, this is our answer to
 * "what is this invoice against", and an invoice legitimately names three
 * facilities where a line can only name one.
 *
 * MISSING TABLE IS NOT AN ERROR. The migration ships ahead of being applied and
 * these reads hang off tabs on seven facility pages; a bare `42P01` escaping
 * from here would take down a tank page over an unapplied migration. It reads as
 * "no facilities". Every other error still throws. Same rule, same reason, as
 * `./query`.
 */

type Sb = SupabaseClient;

/** Postgres: relation does not exist. The migration has not been applied. */
const UNDEFINED_TABLE = "42P01";

function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === UNDEFINED_TABLE;
}

interface FacilityRow {
  document_id: string;
  facility_type: string;
  facility_id: string;
  label: string | null;
}

const COLS = "document_id, facility_type, facility_id, label";

function toFacility(r: FacilityRow): InvoiceFacility | null {
  if (!isInvoiceFacilityType(r.facility_type)) return null;
  return { type: r.facility_type, id: r.facility_id, label: r.label ?? "" };
}

/**
 * The facility sets for a batch of invoices, keyed by document id.
 *
 * Batched because the invoices table is a list: one read for the page, not one
 * per row.
 */
export async function listInvoiceFacilities(
  sb: Sb,
  documentIds: string[]
): Promise<Map<string, InvoiceFacility[]>> {
  const out = new Map<string, InvoiceFacility[]>();
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return out;

  const { data, error } = await sb
    .from("invoice_facilities")
    .select(COLS)
    .in("document_id", ids);
  if (error) {
    if (isMissingTable(error)) return out;
    throw new Error(`listInvoiceFacilities: ${error.message}`);
  }

  for (const row of (data ?? []) as FacilityRow[]) {
    const facility = toFacility(row);
    if (!facility) continue;
    const at = out.get(row.document_id) ?? [];
    at.push(facility);
    out.set(row.document_id, at);
  }
  return out;
}

/** One invoice's facility set. */
export async function getInvoiceFacilities(
  sb: Sb,
  documentId: string
): Promise<InvoiceFacility[]> {
  const map = await listInvoiceFacilities(sb, [documentId]);
  return map.get(documentId) ?? [];
}

/**
 * Replace an invoice's facility set.
 *
 * Delete-then-insert rather than a diff: the set is a handful of rows, the whole
 * value is what the picker submits, and a diff would need the previous state to
 * be read and trusted. `org_id` and `created_by` come from the column defaults,
 * never from app code.
 *
 * Not a transaction, because PostgREST has no cross-statement one. The failure
 * window is between the delete and the insert, and the worst case is an invoice
 * that reads as untagged until the user saves again — recoverable, and visible.
 */
export async function setInvoiceFacilities(
  sb: Sb,
  documentId: string,
  facilities: InvoiceFacility[]
): Promise<void> {
  const del = await sb
    .from("invoice_facilities")
    .delete()
    .eq("document_id", documentId);
  if (del.error) {
    if (isMissingTable(del.error)) return;
    throw new Error(`setInvoiceFacilities delete: ${del.error.message}`);
  }
  if (facilities.length === 0) return;

  // The picker can only offer each facility once, but a replayed submit must not
  // die on the unique index.
  const seen = new Set<string>();
  const rows = facilities
    .filter((f) => {
      const key = `${f.type}:${f.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((f) => ({
      document_id: documentId,
      facility_type: f.type,
      facility_id: f.id,
      label: f.label,
    }));

  const { error } = await sb.from("invoice_facilities").insert(rows);
  if (error) throw new Error(`setInvoiceFacilities insert: ${error.message}`);
}

/**
 * Add facilities to an invoice without disturbing the ones already there.
 *
 * What ingest calls: the extractor's resolution seeds the set, and a person's
 * later corrections must survive a re-scan of the same document. `upsert` with
 * `ignoreDuplicates` leans on the `(document_id, facility_type, facility_id)`
 * unique index, so re-seeding is a no-op rather than a duplicate-key failure.
 */
export async function addInvoiceFacilities(
  sb: Sb,
  documentId: string,
  facilities: InvoiceFacility[]
): Promise<void> {
  if (facilities.length === 0) return;
  const { error } = await sb.from("invoice_facilities").upsert(
    facilities.map((f) => ({
      document_id: documentId,
      facility_type: f.type,
      facility_id: f.id,
      label: f.label,
    })),
    { onConflict: "document_id,facility_type,facility_id", ignoreDuplicates: true }
  );
  if (error) {
    if (isMissingTable(error)) return;
    throw new Error(`addInvoiceFacilities: ${error.message}`);
  }
}

/**
 * The invoices tagged against one facility.
 *
 * Returns document ids only; the caller projects them through the same
 * `listInvoiceSummaries` path the /invoices page uses, so a row reads
 * identically on a tank page and on the invoices list.
 */
export async function invoiceIdsForFacility(
  sb: Sb,
  type: InvoiceFacilityType,
  id: string
): Promise<string[]> {
  // A lease rolls its members up. A bill against a well on the lease IS a bill
  // against the lease — the vendor named the most specific thing it worked on,
  // and an operator opening the lease to see what it cost should not have to
  // visit each well to find out. Rolled up on READ rather than written as a
  // second tag, so moving a tank to another battery moves its invoices with it
  // instead of leaving a stale claim behind.
  const keys =
    type === "lease"
      ? [{ type, id }, ...(await leaseMemberFacilities(sb, id))]
      : [{ type, id }];

  const { data, error } = await sb
    .from("invoice_facilities")
    .select("document_id, facility_type, facility_id")
    .in("facility_id", [...new Set(keys.map((k) => k.id))]);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`invoiceIdsForFacility: ${error.message}`);
  }

  // Filtered on the PAIR, not on the id alone: a well slug and a tank uuid live
  // in one column, and nothing stops the two id spaces from colliding.
  const wanted = new Set(keys.map((k) => `${k.type}:${k.id}`));
  const rows = (data ?? []) as {
    document_id: string;
    facility_type: string;
    facility_id: string;
  }[];
  return [
    ...new Set(
      rows
        .filter((r) => wanted.has(`${r.facility_type}:${r.facility_id}`))
        .map((r) => r.document_id)
    ),
  ];
}

/**
 * Every facility that sits on one lease, as tag keys.
 *
 * Reads the same loaders the rest of the app does rather than the `lease_id`
 * columns directly: a tank's effective lease is battery-authoritative
 * (`listTanks`), so a column read here would disagree with the lease page about
 * which tanks are even on the lease.
 */
async function leaseMemberFacilities(
  sb: Sb,
  leaseId: string
): Promise<{ type: InvoiceFacilityType; id: string }[]> {
  const [wells, tanks, meters, batteries] = await Promise.all([
    sb.from("wells").select("id").eq("lease_id", leaseId),
    cachedTanks(sb),
    cachedMeters(sb, "all"),
    sb.from("tank_batteries").select("id").eq("lease_id", leaseId),
  ]);

  const out: { type: InvoiceFacilityType; id: string }[] = [];
  for (const w of (wells.data ?? []) as { id: string }[]) {
    out.push({ type: "well", id: w.id });
  }
  for (const t of tanks) {
    if (t.leaseId === leaseId) out.push({ type: "tank", id: t.id });
  }
  for (const m of meters) {
    if (m.leaseId === leaseId) out.push({ type: "meter", id: m.id });
  }
  for (const b of (batteries.data ?? []) as { id: string }[]) {
    out.push({ type: "battery", id: b.id });
  }
  return out;
}

/** Convenience wrapper for callers that have no client in hand. */
export async function facilityInvoiceIds(
  type: InvoiceFacilityType,
  id: string
): Promise<string[]> {
  const sb = await getSupabaseServer();
  return invoiceIdsForFacility(sb, type, id);
}
