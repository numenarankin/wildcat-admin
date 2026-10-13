/**
 * Oil run statement: the PURE grouping that turns the flat rows the data-entry
 * grid holds (one row per RUN) into statement drafts — ONE per DOCUMENT
 * (purchaser × statement number) — each carrying its run lines and the
 * settlement period. A crude run statement is a single document that settles one
 * or more leases; the lease rides on each line, not the header, so a statement
 * covering three leases is one filed statement with lines for all three (never
 * one per lease, never one per run). No I/O — the write layer
 * (`dispatchWrite` → `writeOilRunStatements`) resolves the printed lease/tank
 * refs to ids, ties each device to its lease, creates a run ticket per haul,
 * attaches the uploaded PDF, and persists via the `@/lib/statements/*` domain.
 * Kept pure so the grouping and the period math are unit-tested without a
 * database.
 *
 * Header facts (purchaser, contact, statement number/date) repeat on every row
 * because the grid is flat; grouping folds them back up and a run's own
 * `runDate`/`transporter`/ticket/lease are carried onto its settlement line.
 */

import { canonical, canonicalId } from "@/lib/ai/ingest/normalize";
import type { OilRunStatementRow } from "@/lib/ai/ingest/schemas";

/** One settled run → one statement line (and one run ticket on its tank). */
export interface OilRunLine {
  leaseRef: string;
  tankRef: string;
  /** Run / ticket number for the haul ("" if not printed). */
  ticketNo: string;
  ticketType: "run" | "transfer" | "disposition";
  transporter: string;
  /** API gravity in degrees for the run, or null when not printed. */
  gravity: number | null;
  runDate: string;
  /** Net barrels on the run. */
  volume: number;
  /** Realized price, USD/bbl, or null. */
  price: number | null;
  /** Money is null when the statement doesn't break it out per run. */
  gross: number | null;
  taxes: number | null;
  net: number | null;
  sourceText: string;
}

/** A drafted statement: ONE document's runs, spanning one or more leases. */
export interface OilRunStatementDraft {
  purchaser: string;
  purchaserPhone: string;
  purchaserEmail: string;
  statementNo: string;
  /** ISO YYYY-MM-DD, earliest date seen in the group ("" if none printed). */
  periodStart: string;
  /** ISO YYYY-MM-DD, latest date seen in the group ("" if none printed). */
  periodEnd: string;
  lines: OilRunLine[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO date string, or "" if the value is not a clean YYYY-MM-DD. */
function isoOrBlank(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return ISO.test(s) ? s : "";
}

/** Round to cents. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
/** Round a price to 4 decimals (typical statement price precision). */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Split a lease's whole-statement money across its runs by barrels, for the
 * common case where a statement prints per-run BARRELS but only a single
 * lease-level gross / taxes / net (one price and one tax rate apply to every
 * run, so the split is EXACTLY proportional to volume). This exists so the
 * per-run dollars come from arithmetic, never the model's mental math.
 *
 * Only runs whose gross/taxes/net are all blank are filled; runs the statement
 * already broke out are left untouched, and their known dollars are subtracted
 * from the lease totals first (a lease block is normally all-per-run or
 * all-per-lease, so that subtraction is usually a no-op). Cents are rounded and
 * the last filled run absorbs the rounding residual, so the runs reconcile to
 * the lease totals to the penny. Mutates `lines` in place.
 *
 * `totals` are the printed lease-level figures (any may be null — a null total
 * simply isn't distributed; net falls back to gross − taxes when both exist).
 */
export function allocateLeaseFinancials(
  lines: OilRunLine[],
  totals: { gross: number | null; taxes: number | null; net: number | null }
): void {
  const needy = lines.filter(
    (l) => l.gross == null && l.taxes == null && l.net == null
  );
  if (needy.length === 0) return;

  const knownSum = (key: "gross" | "taxes" | "net"): number =>
    lines.reduce((s, l) => s + (l[key] ?? 0), 0);
  const remGross =
    totals.gross == null ? null : round2(totals.gross - knownSum("gross"));
  const remTaxes =
    totals.taxes == null ? null : round2(totals.taxes - knownSum("taxes"));
  const remNet =
    totals.net != null
      ? round2(totals.net - knownSum("net"))
      : remGross != null && remTaxes != null
        ? round2(remGross - remTaxes)
        : null;
  if (remGross == null && remTaxes == null && remNet == null) return;

  // One run takes the remainder outright; several split it by barrels.
  if (needy.length === 1) {
    const l = needy[0];
    if (remGross != null) l.gross = remGross;
    if (remTaxes != null) l.taxes = remTaxes;
    if (remNet != null) l.net = remNet;
    if (l.price == null && remGross != null && l.volume)
      l.price = round4(remGross / l.volume);
    return;
  }

  const sumBbls = needy.reduce((s, l) => s + (l.volume || 0), 0);
  if (sumBbls <= 0) return; // can't split proportionally without per-run barrels

  // Distribute a total across `needy` proportional to barrels; the last run
  // absorbs the rounding residual so the parts sum back to `total` exactly.
  const split = (total: number | null): (number | null)[] => {
    if (total == null) return needy.map(() => null);
    let acc = 0;
    return needy.map((l, i) => {
      const v =
        i === needy.length - 1
          ? round2(total - acc)
          : round2((total * (l.volume || 0)) / sumBbls);
      acc += v;
      return v;
    });
  };

  const price = remGross == null ? null : round4(remGross / sumBbls);
  const g = split(remGross);
  const t = split(remTaxes);
  const n = split(remNet);
  needy.forEach((l, i) => {
    if (g[i] != null) l.gross = g[i];
    if (t[i] != null) l.taxes = t[i];
    if (n[i] != null) l.net = n[i];
    else if (g[i] != null && t[i] != null)
      l.net = round2((g[i] as number) - (t[i] as number));
    if (l.price == null && price != null) l.price = price;
  });
}

/**
 * Group the flat run rows into statement drafts, ONE PER DOCUMENT (purchaser ×
 * statement number). Every run that shares a purchaser and statement number
 * folds into one statement — so a document that settles three leases files
 * exactly one statement, with every haul as a line and the lease carried on the
 * line. Runs that print no statement number group by purchaser alone. Contact /
 * statement facts are header-level and backfilled from any row that prints them.
 * The period is the min/max of every run/statement date seen. Lease-level money
 * totals are split across each lease's own runs by barrels, independently within
 * the document (one lease's totals never bleed into another's).
 */
export function groupRunsIntoStatements(
  rows: OilRunStatementRow[]
): OilRunStatementDraft[] {
  const groups = new Map<string, OilRunStatementDraft>();
  const datesByKey = new Map<string, string[]>();
  // The lease-level money totals (repeated on every run row) per document per
  // lease; the first non-null wins, since they restate the same figure on each
  // row. Allocated back to each lease's runs after grouping.
  type LeaseTotals = { gross: number | null; taxes: number | null; net: number | null };
  const totalsByKey = new Map<string, Map<string, LeaseTotals>>();

  for (const r of rows) {
    const key = `${canonical(r.purchaser)}|${canonicalId(r.statementNo)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        purchaser: r.purchaser.trim(),
        purchaserPhone: r.purchaserPhone.trim(),
        purchaserEmail: r.purchaserEmail.trim(),
        statementNo: r.statementNo.trim(),
        periodStart: "",
        periodEnd: "",
        lines: [],
      };
      groups.set(key, g);
      datesByKey.set(key, []);
      totalsByKey.set(key, new Map());
    }
    // Capture the per-lease totals within this document (first non-null wins).
    const leaseKey = canonical(r.leaseName);
    const leaseTotals = totalsByKey.get(key)!;
    let tot = leaseTotals.get(leaseKey);
    if (!tot) {
      tot = { gross: null, taxes: null, net: null };
      leaseTotals.set(leaseKey, tot);
    }
    if (tot.gross == null && r.leaseGross != null) tot.gross = r.leaseGross;
    if (tot.taxes == null && r.leaseTaxes != null) tot.taxes = r.leaseTaxes;
    if (tot.net == null && r.leaseNet != null) tot.net = r.leaseNet;
    // Backfill header facts from any row that carries them (the first row may
    // leave a field blank while a later one prints it).
    if (!g.purchaser && r.purchaser.trim()) g.purchaser = r.purchaser.trim();
    if (!g.purchaserPhone && r.purchaserPhone.trim())
      g.purchaserPhone = r.purchaserPhone.trim();
    if (!g.purchaserEmail && r.purchaserEmail.trim())
      g.purchaserEmail = r.purchaserEmail.trim();
    if (!g.statementNo && r.statementNo.trim())
      g.statementNo = r.statementNo.trim();

    const dates = datesByKey.get(key)!;
    const rd = isoOrBlank(r.runDate);
    const sd = isoOrBlank(r.statementDate);
    if (rd) dates.push(rd);
    if (sd) dates.push(sd);

    g.lines.push({
      leaseRef: r.leaseName.trim(),
      tankRef: r.tankMeter.trim(),
      ticketNo: r.ticketNo.trim(),
      ticketType: r.ticketType,
      transporter: r.transporter.trim(),
      gravity: r.gravity ?? null,
      runDate: rd,
      volume: r.bbls,
      price: r.pricePerBbl,
      gross: r.gross,
      taxes: r.taxes,
      net: r.net,
      sourceText: r.sourceText ?? "",
    });
  }

  for (const [key, g] of groups) {
    const dates = (datesByKey.get(key) ?? []).slice().sort();
    g.periodStart = dates[0] ?? "";
    g.periodEnd = dates[dates.length - 1] ?? g.periodStart;
    // Split any per-lease-only money across that lease's runs by barrels, one
    // lease at a time so a document's leases stay financially independent.
    const leaseTotals = totalsByKey.get(key) ?? new Map<string, LeaseTotals>();
    const byLease = new Map<string, OilRunLine[]>();
    for (const l of g.lines) {
      const lk = canonical(l.leaseRef);
      const arr = byLease.get(lk) ?? [];
      arr.push(l);
      byLease.set(lk, arr);
    }
    for (const [lk, leaseLines] of byLease) {
      allocateLeaseFinancials(
        leaseLines,
        leaseTotals.get(lk) ?? { gross: null, taxes: null, net: null }
      );
    }
  }
  return [...groups.values()];
}
