import "server-only";

import { getSupabaseServer } from "@/lib/supabase/server";
import { listWellInfoFields } from "@/lib/wells/well-info-fields";
import { canonical } from "@/lib/ai/ingest/normalize";
import { getWells } from "@/lib/wells/wells";
import {
  getContractors,
  getRoyaltyOwners,
  getServiceProviders,
  getGatherers,
  getEmployees,
} from "@/lib/people/people";
import { getInventory } from "@/lib/inventory/inventory";
import { getAccountingCategories } from "@/lib/accounting/org-categories";
import { getLeases } from "@/lib/leases/actions";
import { getBatteries } from "@/lib/batteries/actions";
import { listTanks } from "@/lib/tanks/tanks";
import { listMeters } from "@/lib/meters/meters";
import type { Category } from "@/lib/accounting/categories";
import type { IngestType } from "@/lib/ai/ingest/types";

/**
 * The live data fed into the phase-2 extraction prompt so proposed rows resolve
 * to real ids (wells, categories) and the model skips records that already
 * exist. Only the pieces the detected types need are loaded.
 */
export interface IngestContext {
  wells: { id: string; name: string }[];
  categories: Category[];
  /** Display labels of existing records per type, for the "skip existing" rule. */
  existing: Partial<Record<IngestType, string[]>>;
  /**
   * The workspace's own well Info sheet: the label of every field it keeps,
   * across both well types, plus the aliases an org has taught it.
   *
   * The Info tab is NOT a fixed template — `well_info_fields` is per-org and
   * edited in Settings — so an extraction that invents its own labels files a
   * spec under a field the sheet does not have, where nobody looks. Given the
   * real list, the model matches what the document says to what this workspace
   * actually keeps. Empty unless `wellEquipment` is a target.
   */
  infoFields: string[];
}

/** Load just the context the detected types need (wells always, for matching). */
export async function loadIngestContext(
  types: IngestType[]
): Promise<IngestContext> {
  const set = new Set(types);
  // Only the device lists (tanks/meters) need a Supabase client; fetch it lazily
  // so contexts that don't touch devices never require a configured client.
  const needsDevices = set.has("tanks") || set.has("meters");
  const sb = needsDevices ? await getSupabaseServer() : null;

  const [
    wellRows,
    categories,
    contractors,
    providers,
    owners,
    gatherers,
    employees,
    inventory,
    leases,
    batteries,
    tanks,
    meters,
    infoProducer,
    infoInjection,
  ] = await Promise.all([
    getWells(),
    set.has("transactions") ? getAccountingCategories() : Promise.resolve([]),
    set.has("contractors") ? getContractors() : Promise.resolve([]),
    set.has("serviceProviders") ? getServiceProviders() : Promise.resolve([]),
    set.has("royaltyOwners") || set.has("leaseInterest")
      ? getRoyaltyOwners()
      : Promise.resolve([]),
    set.has("gatherers") ? getGatherers() : Promise.resolve([]),
    set.has("employees") ? getEmployees() : Promise.resolve([]),
    set.has("inventory") ? getInventory() : Promise.resolve([]),
    set.has("leases") || set.has("leaseInterest")
      ? getLeases()
      : Promise.resolve([]),
    set.has("batteries") ? getBatteries() : Promise.resolve([]),
    set.has("tanks") && sb ? listTanks(sb) : Promise.resolve([]),
    set.has("meters") && sb ? listMeters(sb) : Promise.resolve([]),
    set.has("wellEquipment")
      ? listWellInfoFields("producer")
      : Promise.resolve([]),
    set.has("wellEquipment")
      ? listWellInfoFields("injection")
      : Promise.resolve([]),
  ]);

  // One list, deduped: the two sheets overlap heavily and the model is being
  // told what this workspace calls things, not which sheet a label sits on.
  const infoFields = [
    ...new Set(
      [...infoProducer, ...infoInjection].flatMap((f) => [f.label, ...f.aliases])
    ),
  ];

  const existing: Partial<Record<IngestType, string[]>> = {};
  if (set.has("contractors")) {
    existing.contractors = contractors.map((c) =>
      c.company ? `${c.name} (${c.company})` : c.name
    );
  }
  if (set.has("serviceProviders")) {
    existing.serviceProviders = providers.map((p) => p.company);
  }
  if (set.has("gatherers")) {
    existing.gatherers = gatherers.map((g) => g.name);
  }
  if (set.has("royaltyOwners")) {
    existing.royaltyOwners = owners.map((o) => o.name);
  }
  if (set.has("employees")) {
    existing.employees = employees.map((e) =>
      e.role ? `${e.name} (${e.role})` : e.name
    );
  }
  if (set.has("inventory")) {
    existing.inventory = inventory.map((i) =>
      i.location ? `${i.name} @ ${i.location}` : i.name
    );
  }
  if (set.has("leases")) {
    existing.leases = leases.map((l) =>
      l.name ? `${l.leaseNo} — ${l.name}` : l.leaseNo
    );
  }
  if (set.has("batteries")) {
    existing.batteries = batteries.map((b) => b.name);
  }
  if (set.has("tanks")) {
    // No "(#123)" suffix: a tank's name already carries its number ("Roach T123").
    existing.tanks = tanks.map((t) => t.name);
  }
  if (set.has("meters")) {
    // No "(#1234)" suffix: the name already carries it ("Dofflemeyer M1234").
    existing.meters = meters.map((m) => m.name);
  }
  if (set.has("wells")) {
    existing.wells = wellRows.map((w) => w.name);
  }

  return {
    wells: wellRows.map((w) => ({ id: w.id, name: w.name })),
    categories,
    existing,
    infoFields,
  };
}

/**
 * Well resolution from the names printed on a document. No match returns null
 * and the user picks the well in the modal — this never guesses.
 *
 * Three passes, and none of them is a loosening into fuzzy matching:
 *
 *  1. Exact, case-insensitive, trimmed.
 *  2. CANONICAL — `canonical()` lowercases, drops the words "no"/"number", and
 *     flattens punctuation to spaces. That makes "Repass #2", "REPASS NO. 2" and
 *     "Repass 2" the same NAME written three ways, which they are. Invoices and
 *     field tickets print the property with a "#" almost every time, so without
 *     this pass a service record off an invoice never found its well.
 *  3. OPERATOR PREFIX DROPPED. A service company heads the property with whoever
 *     it bills: "Sky Resources - Corbett #2". The part after the dash is the
 *     property; the part before it is us. Passes 1 and 2 are re-run on it.
 *
 * Passes 2 and 3 each require exactly ONE well to match. Two wells collapsing to
 * one printed name is genuine ambiguity, and the modal's picker is a better
 * answer than a coin flip.
 *
 * WHAT IS DELIBERATELY NOT HERE: matching "Corbett 2" to "Roy Corbett 2". They
 * are DIFFERENT NAMES, and treating a printed name as the tail of a longer one
 * is the classic way a service record lands on the wrong hole — an operator with
 * a Corbett 2 and a Roy Corbett 2 is exactly who this would hurt. An unmatched
 * property leaves the well unset and the picker one click away, which is the
 * honest answer to a name we do not have on file.
 */
export function matchWell(
  wellNames: string[],
  wells: { id: string; name: string }[]
): string | null {
  const printed = wellNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (printed.length === 0) return null;

  const exact = wells.find((w) => printed.includes(w.name.trim().toLowerCase()));
  if (exact) return exact.id;

  const canonicalPrinted = new Set(printed.map(canonical).filter(Boolean));
  if (canonicalPrinted.size === 0) return null;
  const hits = wells.filter((w) => canonicalPrinted.has(canonical(w.name)));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) return null; // ambiguous: ask, do not guess further

  // Pass 3: the property as printed after the operator's own name.
  const tails = new Set(
    [...canonicalPrinted]
      .map((v) => v.split(" - ").pop() ?? "")
      .concat(printed.map((v) => canonical(v.split(" - ").pop() ?? "")))
      .filter(Boolean)
  );
  const tailHits = wells.filter((w) => tails.has(canonical(w.name)));
  return tailHits.length === 1 ? tailHits[0].id : null;
}
