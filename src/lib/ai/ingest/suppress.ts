import "server-only";

import { getSupabaseServer } from "@/lib/supabase/server";
import { canonical, canonicalId } from "@/lib/ai/ingest/normalize";
import { NOTICE_KEY } from "@/components/ai/ingest/ingest-grid";
import type { ProposalDraft } from "@/lib/ai/ingest/scan";
import type { IngestType } from "@/lib/ai/ingest/types";
import { ierr, ilog } from "@/lib/ai/ingest/log";
import {
  contractorKey,
  providerKey,
  nameKey,
  inventoryKey,
  txnKey,
  readingKey,
  downtimeKey,
  serviceKey,
  equipmentKey,
  meterVolumeKey,
  shotKey,
  noteKey,
  stmtKey,
  runTicketKey,
} from "@/lib/ai/ingest/dedup-keys";
import { groupRunsIntoStatements } from "@/lib/ai/ingest/oil-run-statement";
import { listStatements } from "@/lib/statements/statements";
import { oilRunStatementRow } from "@/lib/ai/ingest/schemas";
import {
  contractorRow,
  serviceProviderRow,
  royaltyOwnerRow,
  gathererRow,
  purchaserRow,
  employeeRow,
  inventoryRow,
  leaseRow,
  wellRow,
  injectionWellRow,
  tankRow,
  runTicketRow,
  meterRow,
  batteryRow,
  transactionRow,
  wellTestRow,
  tankReadingRow,
  meterReadingRow,
  downtimeRow,
  serviceRow,
  wellEquipmentRow,
  disposalReadingRow,
  shotRow,
  wellNoteRow,
  meterVolumeRow,
} from "@/lib/ai/ingest/schemas";
import { liftReadingTime } from "@/lib/ai/ingest/schemas";
import { getContractors, getServiceProviders, getRoyaltyOwners, getGatherers, getEmployees } from "@/lib/people/people";
import { getInventory } from "@/lib/inventory/inventory";
import { getLeases } from "@/lib/leases/actions";
import { getWells } from "@/lib/wells/wells";
import { getBatteries } from "@/lib/batteries/actions";
import { listTanks } from "@/lib/tanks/tanks";
import { listMeters } from "@/lib/meters/meters";
import {
  leaseIsOnFile,
  leaseKey,
  type MatchTarget,
} from "@/lib/statements/matching";
import { getTransactions } from "@/lib/accounting/ledger";
import { listMeterVolumeStatements } from "@/lib/meters/volume-statements";
import { listNotesForTarget } from "@/lib/notes/notes";
import { htmlFromPlainText, snippetFromHtml } from "@/lib/notes/format";
import { z } from "zod";

type Sb = Awaited<ReturnType<typeof getSupabaseServer>>;

/**
 * Scan-time suppression: drop the rows a proposal would produce that are ALREADY
 * on file, so the approval modal shows only genuinely-new records. This is a UX
 * layer on top of the write step, which stays the authoritative dedup (it reruns
 * the same keys from `dedup-keys.ts` at persist time). The two therefore agree by
 * construction.
 *
 * SAFETY: a false suppression silently loses real data (the row never reaches the
 * write net), so every handler is conservative — it keeps a row on ANY doubt: an
 * unresolved device, a parse failure, a missing well scope, an unhandled type.
 * Only an exact key match against existing data drops a row.
 *
 * Types deliberately NOT suppressed (passed through untouched):
 *   - production, leaseUseGas: last-wins writes — a re-upload legitimately
 *     UPDATES values (production merges field by field, keeping anything the new
 *     source didn't report), and hiding it would hide a correction. These are the
 *     types where an existing row is NOT authoritative, so suppressing a match
 *     would strand a stale reading no later document could fix.
 *   - gasTests: `recordWellGasShutIn` REPLACES this well's reading on a
 *     campaign rather than appending, so re-filing a corrected sheet is the
 *     intended way to fix a bad reading — the same last-wins reasoning as
 *     production. Intra-batch duplicates are still collapsed in
 *     `merge-segments.ts`, where there is no correction to hide.
 *   - oilRunStatement, gasSettlementStatement: statement-grain merge is a separate
 *     phase (see docs/plans/proactive-ingest-dedup.md).
 *   - leaseInterest: not yet modeled.
 */
export interface SuppressionResult {
  drafts: ProposalDraft[];
  /** How many rows were dropped as already-on-file, across all drafts. */
  suppressed: number;
}

/** A per-type handler: return the subset of `rows` that is NOT already on file. */
type Handler = (sb: Sb, draft: ProposalDraft) => Promise<unknown[]>;

/** Parse a draft's rows with its schema; on failure, signal "keep all" via null. */
function parseRows<T>(schema: z.ZodType<T>, rows: unknown[]): T[] | null {
  const out = z.array(schema).safeParse(rows);
  return out.success ? out.data : null;
}

/** Keep rows whose key is not in `existing`; a null key always survives. */
function keepNew<T>(
  rows: T[],
  keyOf: (r: T) => string | null,
  existing: Set<string>
): T[] {
  const seen = new Set(existing);
  const kept: T[] = [];
  for (const r of rows) {
    const key = keyOf(r);
    if (key !== null && seen.has(key)) continue;
    if (key !== null) seen.add(key); // also collapse in-batch duplicates
    kept.push(r);
  }
  return kept;
}

/** A canonical device resolver over a fixed device list (number wins over name). */
function deviceResolver(devices: { id: string; name: string; no: string }[]) {
  return (ref: string): string | null => {
    const r = canonical(ref);
    if (!r) return null;
    const rid = canonicalId(ref);
    const hit =
      devices.find((d) => d.no && (canonical(d.no) === r || canonicalId(d.no) === rid)) ??
      devices.find((d) => canonical(d.name) === r);
    return hit?.id ?? null;
  };
}

// --- Directory / entity handlers ------------------------------------------

const HANDLERS: Partial<Record<IngestType, Handler>> = {
  contractors: async (_sb, d) => {
    const rows = parseRows(contractorRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set(
      (await getContractors()).map((c) => contractorKey(c.name, c.phone))
    );
    return keepNew(rows, (r) => contractorKey(r.name, r.phone), existing);
  },
  serviceProviders: async (_sb, d) => {
    const rows = parseRows(serviceProviderRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set(
      (await getServiceProviders()).map((p) => providerKey(p.company))
    );
    return keepNew(rows, (r) => providerKey(r.company), existing);
  },
  royaltyOwners: async (_sb, d) => {
    const rows = parseRows(royaltyOwnerRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set((await getRoyaltyOwners()).map((o) => nameKey(o.name)));
    return keepNew(rows, (r) => nameKey(r.name), existing);
  },
  gatherers: async (_sb, d) => {
    const rows = parseRows(gathererRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set((await getGatherers()).map((g) => nameKey(g.name)));
    return keepNew(rows, (r) => nameKey(r.name), existing);
  },
  purchasers: async (_sb, d) => {
    // The app's buyer directory IS the gatherers table (see the write step).
    const rows = parseRows(purchaserRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set((await getGatherers()).map((g) => nameKey(g.name)));
    return keepNew(rows, (r) => (canonical(r.name) ? nameKey(r.name) : null), existing);
  },
  employees: async (_sb, d) => {
    const rows = parseRows(employeeRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set((await getEmployees()).map((e) => nameKey(e.name)));
    return keepNew(rows, (r) => nameKey(r.name), existing);
  },
  inventory: async (_sb, d) => {
    const rows = parseRows(inventoryRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set(
      (await getInventory()).map((i) => inventoryKey(i.name, i.location))
    );
    return keepNew(rows, (r) => inventoryKey(r.name, r.location), existing);
  },
  leases: async (_sb, d) => {
    const rows = parseRows(leaseRow, d.rows);
    if (!rows) return d.rows;
    // The SAME question the matcher and the write step ask (`leaseIsOnFile`).
    // Three private copies of "is this lease already on file" is how a card came
    // to be proposed for a lease the writer then skipped
    // (docs/plans/statement-lease-matching.md, phase 3). A row with no
    // identifier survives; the write step decides its fate.
    const onFile: MatchTarget[] = (await getLeases()).map((l) => ({
      id: l.id,
      number: l.leaseNo,
      name: l.name,
    }));
    return keepNew(
      rows,
      (r) => {
        const identity = r.leaseNo.trim() || r.name.trim();
        const key = leaseKey(identity);
        if (!key) return null;
        return leaseIsOnFile({ leaseNo: identity, name: r.name }, onFile)
          ? key
          : null; // new — keep (in-batch collapse is the write step's job)
      },
      new Set()
    );
  },
  wells: async (_sb, d) => {
    const rows = parseRows(wellRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set((await getWells()).map((w) => nameKey(w.name)));
    return keepNew(rows, (r) => nameKey(r.name), existing);
  },
  // Same key as `wells`, and against the same list: the write step dedups an
  // injection well by `canonical(name)` over every well in the org, so a name
  // already on file as a producer is a duplicate here too. This handler was
  // missing, so "Hughes 1" read off a ticket sailed past suppression and
  // reached the reviewer as "Add injection well?" while Hughes #1 was the very
  // page it was uploaded from.
  injectionWells: async (_sb, d) => {
    const rows = parseRows(injectionWellRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set((await getWells()).map((w) => nameKey(w.name)));
    return keepNew(rows, (r) => nameKey(r.name), existing);
  },
  batteries: async (_sb, d) => {
    const rows = parseRows(batteryRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set((await getBatteries()).map((b) => nameKey(b.name)));
    return keepNew(rows, (r) => nameKey(r.name), existing);
  },
  tanks: async (sb, d) => {
    const rows = parseRows(tankRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set(
      (await listTanks(sb)).map((t) => (t.tankNo ? canonicalId(t.tankNo) : canonical(t.name)))
    );
    return keepNew(rows, (r) => (r.tankNo ? canonicalId(r.tankNo) : canonical(r.name)), existing);
  },
  meters: async (sb, d) => {
    const rows = parseRows(meterRow, d.rows);
    if (!rows) return d.rows;
    const existing = new Set(
      (await listMeters(sb)).map((m) => (m.meterNo ? canonicalId(m.meterNo) : canonical(m.name)))
    );
    return keepNew(rows, (r) => (r.meterNo ? canonicalId(r.meterNo) : canonical(r.name)), existing);
  },

  // --- Transactional / time-series handlers -------------------------------

  transactions: async (_sb, d) => {
    const rows = parseRows(transactionRow, d.rows);
    if (!rows) return d.rows;
    // Only invoice-bearing rows have a reliable identity; recurring no-invoice
    // expenses are legitimately identical and must never be suppressed.
    const existing = new Set(
      (await getTransactions())
        .filter((t) => t.invoiceNumber)
        .map((t) => txnKey(t.invoiceNumber, t.amount, t.date))
    );
    return keepNew(
      rows,
      (r) => (r.invoiceNumber ? txnKey(r.invoiceNumber, r.amount, r.date) : null),
      existing
    );
  },
  wellTests: async (sb, d) => {
    if (!d.wellId) return d.rows; // no well scope → cannot be a known duplicate
    const rows = parseRows(wellTestRow, d.rows);
    if (!rows) return d.rows;
    const { data } = await sb
      .from("well_tests")
      .select("test_date")
      .eq("well_id", d.wellId);
    const existing = new Set(((data ?? []) as { test_date: string }[]).map((e) => e.test_date));
    return keepNew(rows, (r) => r.testDate, existing);
  },
  downtime: async (sb, d) => {
    if (!d.wellId) return d.rows;
    const rows = parseRows(downtimeRow, d.rows);
    if (!rows) return d.rows;
    const { data } = await sb
      .from("well_events")
      .select("event_type, start_date, end_date")
      .eq("well_id", d.wellId);
    const existing = new Set(
      ((data ?? []) as { event_type: string; start_date: string; end_date: string | null }[]).map(
        (e) => downtimeKey(e.start_date, e.end_date, e.event_type)
      )
    );
    return keepNew(rows, (r) => downtimeKey(r.startDate, r.endDate || null, r.eventType), existing);
  },
  service: async (sb, d) => {
    if (!d.wellId) return d.rows;
    const rows = parseRows(serviceRow, d.rows);
    if (!rows) return d.rows;
    const { data } = await sb
      .from("well_service")
      .select("date, job")
      .eq("well_id", d.wellId);
    const existing = new Set(
      ((data ?? []) as { date: string; job: string | null }[]).map((e) =>
        serviceKey(e.date, e.job ?? "")
      )
    );
    return keepNew(rows, (r) => serviceKey(r.date, r.job), existing);
  },
  shots: async (sb, d) => {
    if (!d.wellId) return d.rows;
    const rows = parseRows(shotRow, d.rows);
    if (!rows) return d.rows;
    const { data } = await sb
      .from("well_shots")
      .select("shot_date, shot_time, fluid_level_ft")
      .eq("well_id", d.wellId);
    const existing = new Set(
      (
        (data ?? []) as {
          shot_date: string;
          shot_time: string | null;
          fluid_level_ft: number | null;
        }[]
      ).map((s) => shotKey(s.shot_date, s.shot_time, s.fluid_level_ft))
    );
    return keepNew(
      rows,
      (r) => shotKey(r.date, r.time, r.fluidLevelFt),
      existing
    );
  },
  wellNotes: async (sb, d) => {
    if (!d.wellId) return d.rows;
    const rows = parseRows(wellNoteRow, d.rows);
    if (!rows) return d.rows;
    // The stored body is HTML and the proposed one is plain text, so both sides
    // are compared as the note's plain-text snippet — the same 200-char prefix
    // the write path keys on. That prefix is the one place this handler is not
    // strictly conservative: two DIFFERENT notes sharing a title and their first
    // 200 characters would suppress the second. Reading full bodies to close
    // that would cost a query per note on file, and the note's own date is the
    // body's first line, so a collision needs two same-titled, same-dated,
    // 200-char-identical notes — a case worth the saved round trips.
    const existing = new Set(
      (await listNotesForTarget(sb, "well", d.wellId)).map((n) =>
        noteKey(n.title, n.snippet)
      )
    );
    return keepNew(
      rows,
      (r) => {
        const body = r.body.trim();
        if (!body) return null;
        const title =
          r.title.trim() || body.split("\n")[0].trim().slice(0, 80) || "Untitled";
        return noteKey(
          title,
          snippetFromHtml(htmlFromPlainText(r.date ? `${r.date}\n\n${body}` : body))
        );
      },
      existing
    );
  },
  wellEquipment: async (sb, d) => {
    if (!d.wellId) return d.rows;
    const rows = parseRows(wellEquipmentRow, d.rows);
    if (!rows) return d.rows;
    const { data } = await sb
      .from("well_equipment")
      .select("label, value")
      .eq("well_id", d.wellId);
    const onFile = (data ?? []) as { label: string | null; value: string | null }[];
    const existing = new Set(
      onFile.map((e) => equipmentKey(e.label ?? "", e.value ?? ""))
    );
    // The value currently under each label, keyed the way the write step
    // matches labels (`canonical`, actions.ts `wellEquipment`).
    const valueByLabel = new Map(
      onFile.map((e) => [canonical(e.label ?? ""), e.value ?? ""] as const)
    );
    // A row whose label is already on the Info tab with a DIFFERENT value is
    // kept — a new pump is a new spec — but approving it OVERWRITES what is
    // there, and the card's title says "Add". The reviewer was only told
    // afterwards ("updated N already on file"); this puts the current value on
    // the row, in the same amber notice the run-ticket handler uses, so the
    // replacement is reviewed rather than discovered.
    return keepNew(rows, (r) => equipmentKey(r.label, r.value), existing).map(
      (r) => {
        const current = valueByLabel.get(canonical(r.label));
        return current === undefined || current === r.value
          ? r
          : {
              ...r,
              [NOTICE_KEY]: `Replaces the value on file for ${r.label}: "${current}".`,
            };
      }
    );
  },
  meterVolumes: async (sb, d) => {
    const rows = parseRows(meterVolumeRow, d.rows);
    if (!rows) return d.rows;
    const resolve = deviceResolver(
      (await listMeters(sb)).map((m) => ({ id: m.id, name: m.name, no: m.meterNo ?? "" }))
    );
    const seenByMeter = new Map<string, Set<string>>();
    const seenFor = async (meterId: string): Promise<Set<string>> => {
      let s = seenByMeter.get(meterId);
      if (!s) {
        const existing = await listMeterVolumeStatements(sb, meterId);
        s = new Set(existing.map((x) => meterVolumeKey(x.date, x.purchaser)));
        seenByMeter.set(meterId, s);
      }
      return s;
    };
    const kept: unknown[] = [];
    for (const r of rows) {
      const meterId = resolve(r.meterRef);
      if (!meterId) {
        kept.push(r); // unknown meter → new by definition
        continue;
      }
      const seen = await seenFor(meterId);
      const key = meterVolumeKey(r.date, r.purchaser || "");
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(r);
    }
    return kept;
  },
  oilRunStatement: async (sb, d) => {
    // Suppress a crude run statement only when the WHOLE document is already on
    // file (its `stmtKey` matches an existing statement). This is safe because
    // the oil writer skips an existing statement wholesale — entities, run
    // tickets, and lines are all gated on the same key — so dropping it at scan
    // time changes nothing except that the user sees "already on file" up front.
    // (Partial re-uploads with genuinely-new runs are neither added today nor
    // suppressed here at row grain; per-line merge is a separate phase.)
    const rows = parseRows(oilRunStatementRow, d.rows);
    if (!rows) return d.rows;
    const groups = groupRunsIntoStatements(rows);
    const existing = new Set(
      (await listStatements(sb)).map((s) =>
        stmtKey(s.purchaser, s.statementNo, s.periodStart, s.periodEnd)
      )
    );
    // A group is dropped iff its statement is already filed. Map each row back to
    // its group by the same key `groupRunsIntoStatements` uses.
    const dropGroup = new Set<string>();
    for (const g of groups) {
      const gk = `${canonical(g.purchaser)}|${canonicalId(g.statementNo)}`;
      if (existing.has(stmtKey(g.purchaser, g.statementNo, g.periodStart, g.periodEnd))) {
        dropGroup.add(gk);
      }
    }
    if (dropGroup.size === 0) return rows;
    return rows.filter(
      (r) => !dropGroup.has(`${canonical(r.purchaser)}|${canonicalId(r.statementNo)}`)
    );
  },
  // gasSettlementStatement is intentionally NOT suppressed: the gas writer files
  // each meter's settlement independently of the revenue statement, so dropping a
  // whole document by statement key could hide a genuinely-new meter settlement.

  tankReadings: async (sb, d) => {
    const rows = parseRows(tankReadingRow, (d.rows as unknown[]).map(liftReadingTime));
    if (!rows) return d.rows;
    const resolve = deviceResolver(
      (await listTanks(sb)).map((t) => ({ id: t.id, name: t.name, no: t.tankNo ?? "" }))
    );
    return suppressDeviceReadings(sb, rows, "tank_readings", (r) => r.tankRef, resolve, d.tankId ?? null);
  },
  runTickets: async (sb, d) => {
    // `run_tickets` has no DB unique key, so `runTicketKey` (ticket number +
    // date, falling back to date + effective net barrels) is the row's only
    // identity — the same key the write step skips on, so "not shown" and
    // "not written" always agree. A row whose printed tank ref resolves to no
    // existing tank (and no pinned tank) cannot be a known duplicate, so it is
    // kept; voided tickets are excluded so a re-filed correction survives.
    const rows = parseRows(runTicketRow, d.rows);
    if (!rows) return d.rows;
    const resolve = deviceResolver(
      (await listTanks(sb)).map((t) => ({ id: t.id, name: t.name, no: t.tankNo ?? "" }))
    );
    const seenByTank = new Map<string, { keys: Set<string>; dates: Set<string> }>();
    const seenFor = async (
      tankId: string
    ): Promise<{ keys: Set<string>; dates: Set<string> }> => {
      let s = seenByTank.get(tankId);
      if (!s) {
        const { data } = await sb
          .from("run_tickets")
          .select("ticket_no, ticket_date, net_bbls, gross_bbls")
          .eq("tank_id", tankId)
          .is("deleted_at", null);
        const tickets = (data ?? []) as {
          ticket_no: string | null;
          ticket_date: string;
          net_bbls: number | null;
          gross_bbls: number | null;
        }[];
        s = {
          keys: new Set(
            tickets.map((t) =>
              runTicketKey(t.ticket_no, t.ticket_date, t.net_bbls ?? t.gross_bbls)
            )
          ),
          // The DATES on their own, because the key alone cannot answer the
          // question below: a hand-entered ticket with no number and a
          // statement's numbered run for the same haul are keyed in two
          // different namespaces and never compare.
          dates: new Set(tickets.map((t) => t.ticket_date).filter(Boolean)),
        };
        seenByTank.set(tankId, s);
      }
      return s;
    };
    const kept: unknown[] = [];
    for (const r of rows) {
      const tankId = resolve(r.tankRef) ?? d.tankId ?? null;
      if (!tankId) {
        kept.push(r); // unknown tank → new by definition
        continue;
      }
      const seen = await seenFor(tankId);
      const key = runTicketKey(r.ticketNo, r.date, r.netBbls ?? r.grossBbls);
      if (seen.keys.has(key)) continue;
      /*
       * FLAGGED, NOT DROPPED. Two hauls off one tank on one day are possible
       * and rare; the same haul reaching us twice is neither. The exact-key
       * check above cannot catch the common version of that — a ticket entered
       * by hand with no number, then the purchaser's statement naming the same
       * run WITH one — because the two keys live in different namespaces.
       *
       * So the date match becomes a note on the card and the reviewer decides.
       * Dropping it would silently lose a real second run; writing it silently
       * is what produced the double.
       */
      const duplicateDate = r.date && seen.dates.has(r.date);
      seen.keys.add(key);
      if (r.date) seen.dates.add(r.date);
      kept.push(
        duplicateDate
          ? {
              ...r,
              [NOTICE_KEY]: `A run is already on file for this tank on ${r.date}. Check this is not the same haul.`,
            }
          : r
      );
    }
    return kept;
  },
  meterReadings: async (sb, d) => {
    const rows = parseRows(meterReadingRow, (d.rows as unknown[]).map(liftReadingTime));
    if (!rows) return d.rows;
    const resolve = deviceResolver(
      (await listMeters(sb)).map((m) => ({ id: m.id, name: m.name, no: m.meterNo ?? "" }))
    );
    return suppressDeviceReadings(sb, rows, "meter_readings", (r) => r.meterRef, resolve, d.meterId ?? null);
  },
  disposalReadings: async (sb, d) => {
    // Same key the write step skips on (`readingKey`), so "not shown" and "not
    // written" always agree. Note `readingKey` folds a blank time to 00:00 while
    // the DB's unique index treats two NULL times as distinct rows — the key is
    // deliberately the stricter of the two.
    if (!d.wellId) return d.rows;
    const rows = parseRows(disposalReadingRow, d.rows);
    if (!rows) return d.rows;
    const { data } = await sb
      .from("disposal_readings")
      .select("reading_date, reading_time")
      .eq("injection_well_id", d.wellId);
    const existing = new Set(
      ((data ?? []) as { reading_date: string; reading_time: string | null }[]).map(
        (e) => readingKey(e.reading_date, e.reading_time)
      )
    );
    return keepNew(rows, (r) => readingKey(r.date, r.time), existing);
  },
};

/**
 * Shared reading suppression: resolve each row's device ref to an EXISTING device
 * (falling back to the pinned device for a scoped upload), then drop rows whose
 * (device, date|time) is already on file. A row whose device does not exist yet
 * cannot be a duplicate, so it is kept.
 */
async function suppressDeviceReadings<
  T extends { date: string; time?: string | null }
>(
  sb: Sb,
  rows: T[],
  table: "tank_readings" | "meter_readings",
  refOf: (r: T) => string,
  resolve: (ref: string) => string | null,
  pinnedId: string | null
): Promise<T[]> {
  const idCol = table === "tank_readings" ? "tank_id" : "meter_id";
  const seenByDevice = new Map<string, Set<string>>();
  const seenFor = async (deviceId: string): Promise<Set<string>> => {
    let s = seenByDevice.get(deviceId);
    if (!s) {
      const { data } = await sb
        .from(table)
        .select("reading_date, reading_time")
        .eq(idCol, deviceId)
        .is("deleted_at", null);
      s = new Set(
        ((data ?? []) as { reading_date: string; reading_time: string | null }[]).map((e) =>
          readingKey(e.reading_date, e.reading_time)
        )
      );
      seenByDevice.set(deviceId, s);
    }
    return s;
  };
  const kept: T[] = [];
  for (const r of rows) {
    const deviceId = resolve(refOf(r)) ?? pinnedId;
    if (!deviceId) {
      kept.push(r); // unknown device → new by definition
      continue;
    }
    const seen = await seenFor(deviceId);
    const key = readingKey(r.date, r.time);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(r);
  }
  return kept;
}

/**
 * Drop already-on-file rows from every draft. Best-effort per draft: a handler
 * that throws leaves that draft untouched (keep-all), so suppression can never
 * cause data loss. Drafts that end empty are removed from the result.
 */
export async function suppressExistingRows(
  sb: Sb,
  drafts: ProposalDraft[]
): Promise<SuppressionResult> {
  let suppressed = 0;
  const out: ProposalDraft[] = [];
  for (const draft of drafts) {
    const handler = HANDLERS[draft.type];
    if (!handler) {
      out.push(draft);
      continue;
    }
    let kept: unknown[];
    try {
      kept = await handler(sb, draft);
    } catch (err) {
      ierr("suppress: handler threw, keeping all rows", { type: draft.type, ...errorInfoLite(err) });
      out.push(draft);
      continue;
    }
    const dropped = draft.rows.length - kept.length;
    if (dropped > 0) {
      suppressed += dropped;
      ilog("suppress: dropped already-on-file rows", {
        type: draft.type,
        dropped,
        kept: kept.length,
      });
    }
    if (kept.length > 0) out.push({ ...draft, rows: kept });
  }
  return { drafts: out, suppressed };
}

/** Minimal error info without pulling the heavier ingest logger shape. */
function errorInfoLite(err: unknown): Record<string, unknown> {
  return { error: err instanceof Error ? err.message : String(err) };
}
