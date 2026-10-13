/**
 * Resolving statement lines to facilities, and de-duplicating the statements they sit on
 * (docs/plans/statement-derived-production.md, D5 and D8).
 *
 * ## Why the stored ids are not trusted
 *
 * `statement_line_items.lease_id` / `tank_id` / `meter_id` are a CACHE of a match computed
 * once, at extraction (`extract.ts`, `matchLease` / `matchByNumber`), and never refreshed.
 * On the production data they are almost all null, and not because matching is broken:
 * the facilities are created AFTER the lines, by the backfill that reads the same
 * statement. Measured on 2026-08-26: 1 of 21 lines carried a lease id and 0 of 14 gas
 * lines carried a meter id, yet 21 of 21 and 14 of 14 match today, exactly. The meters
 * were created 24 seconds after the lines that name them.
 *
 * So this module re-runs the same pure matchers against the org's CURRENT facilities. It
 * self-heals: the operator creates the lease, or the backfill does, and the line starts
 * counting on the next read with nothing written and no re-extraction.
 *
 * ## Ambiguity is a flag, not a first hit
 *
 * A first-hit matcher would silently attribute a lease's oil to its namesake, so the
 * shared resolver counts the hits and refuses when there is more than one. That rule now
 * lives in `matching.ts` (`resolveUnique`, `resolveLeaseId`), where the extraction path
 * asks the same question: one matcher, one answer, one key
 * (docs/plans/statement-lease-matching.md).
 *
 * Pure and side-effect free: the whole resolution ladder and the duplicate rule can be
 * checked against hand-built fixtures rather than against whatever the org happens to have.
 */

import {
  resolveLeaseId,
  resolveUnique,
  type MatchTarget,
  type Resolution,
} from "./matching";
import type { StatementVolume } from "./production-series";

/** A settlement line, as stored, before anything is resolved. */
export interface RawStatementLine {
  id: string;
  statementId: string;
  /**
   * The cached match from extraction time. Usually null; see the header. When it
   * IS set it wins the ladder outright (`resolveLeaseId`), which is also what
   * makes a lease chosen by hand in Payments stick.
   */
  leaseId: string | null;
  tankId: string | null;
  meterId: string | null;
  /** The identifiers as PRINTED, which is what actually survives. */
  leaseRef: string;
  tankRef: string;
  meterRef: string;
  product: "oil" | "gas";
  volume: number;
}

/** The parent statement, carrying the period the volume belongs to. */
export interface RawStatement {
  id: string;
  purchaserId: string | null;
  periodStart: string;
  periodEnd: string;
  product: string;
  status: string;
  createdAt: string;
}

/** The org's current facilities, plus each point's lease. */
export interface FacilityTargets {
  leases: MatchTarget[];
  tanks: MatchTarget[];
  meters: MatchTarget[];
  /** Tank or meter id to the lease it belongs to (`pointLeaseId`, precomputed). */
  leaseByPoint: Map<string, string>;
}

/** A resolved sale point. */
export interface Point {
  type: "tank" | "meter";
  id: string;
}

/** Why a line could not be placed. Null when it was placed fully. */
export type LineFlag =
  | "no-lease"
  | "no-point"
  | "ambiguous-lease"
  | "ambiguous-point";

export interface ResolvedLine<L extends RawStatementLine = RawStatementLine> {
  line: L;
  statement: RawStatement;
  leaseId: string | null;
  point: Point | null;
  flag: LineFlag | null;
}

/**
 * Statuses whose volumes are trusted enough to display.
 *
 * `extracted` is raw model output nobody has confirmed, and this feeds displayed rates and
 * an estimated-revenue column, so it waits for a human. `received` has no line items yet.
 * `reviewed` is terminal: saving the upload review panel IS the confirmation, and there is
 * no posting step after it (docs/plans/derived-payments.md).
 */
const TRUSTED_STATUSES = new Set(["reviewed"]);

/**
 * Re-exported so this module's callers and tests keep one import for the resolution
 * vocabulary. The implementation is shared with extraction on purpose: two copies of
 * "does this printed name mean this lease" is exactly how the two paths drifted apart.
 */
export { resolveUnique, type Resolution };

/**
 * Resolve one line to a lease and a sale point, by the D8 ladder.
 *
 * Point first, because the lease falls back THROUGH the point: a line naming a tank we
 * know resolves to that tank's lease even when its printed lease name matches nothing.
 * That is the same fallback the posting path already uses (`pointLeaseId`), so lease scope
 * and the ledger agree on what "this lease's line" means.
 */
export function resolveLine<L extends RawStatementLine>(
  line: L,
  statement: RawStatement,
  targets: FacilityTargets
): ResolvedLine<L> {
  // --- the sale point -----------------------------------------------------
  let point: Point | null = null;
  let pointAmbiguous = false;
  if (line.product === "gas") {
    if (line.meterId) point = { type: "meter", id: line.meterId };
    else {
      const hit = resolveUnique(line.meterRef, targets.meters, { byName: false });
      if (hit === "ambiguous") pointAmbiguous = true;
      else if (hit) point = { type: "meter", id: hit.id };
    }
  } else {
    if (line.tankId) point = { type: "tank", id: line.tankId };
    else {
      // A tank ref can print several numbers for one line ("0486289, 0486290"),
      // which is one settlement against two tanks. Neither is THE point, so the
      // line stays lease-scoped rather than being attributed to the first one.
      const single = !line.tankRef.includes(",");
      const hit = single
        ? resolveUnique(line.tankRef, targets.tanks, { byName: false })
        : null;
      if (hit === "ambiguous") pointAmbiguous = true;
      else if (hit) point = { type: "tank", id: hit.id };
    }
  }

  // --- the lease ----------------------------------------------------------
  // The shared ladder: carried id, then the point's lease, then the printed name.
  const lease = resolveLeaseId(
    { leaseId: line.leaseId, leaseRef: line.leaseRef, pointId: point?.id ?? null },
    { leases: targets.leases, leaseByPoint: targets.leaseByPoint }
  );
  const leaseId = lease.leaseId;
  const leaseAmbiguous = lease.ambiguous;

  const flag: LineFlag | null = leaseAmbiguous
    ? "ambiguous-lease"
    : !leaseId
      ? "no-lease"
      : pointAmbiguous
        ? "ambiguous-point"
        : !point
          ? "no-point"
          : null;

  return { line, statement, leaseId, point, flag };
}

/** Whether two inclusive date ranges share a day. */
function overlaps(a: RawStatement, b: RawStatement): boolean {
  return a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd;
}

/**
 * Collapse duplicate statements, keeping the newest of each group.
 *
 * NOTHING ELSE DOES THIS. `findDuplicateRevenue` is advisory, never blocks or excludes,
 * and compares a proposed line against the transactions ledger rather than against other
 * statements. Here it has to be enforced, because `expandPeriodsToDaily` SUMS overlapping
 * periods by design (two purchasers in one month is real), which makes a re-upload
 * arithmetically indistinguishable from a second purchaser.
 *
 * The key is purchaser + product + period OVERLAP, matching `findDuplicateRevenue`'s own
 * comparison. Overlap rather than equality because a corrected re-issue often shifts the
 * period by a day or two. Amount is deliberately NOT in the key: a re-issue with a
 * corrected volume is exactly the case that must collapse, not the case that must survive.
 *
 * A statement with no purchaser cannot be compared to anything and is always kept: dropping
 * an unattributed statement would lose real volume to a rule about duplicates.
 */
export function dedupeStatements(statements: RawStatement[]): RawStatement[] {
  const groups = new Map<string, RawStatement[]>();
  const kept: RawStatement[] = [];

  for (const s of statements) {
    if (!s.purchaserId) {
      kept.push(s);
      continue;
    }
    const key = `${s.purchaserId}|${s.product}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  for (const bucket of groups.values()) {
    // Oldest first, so each statement joins the first group it overlaps.
    const sorted = [...bucket].sort((a, b) =>
      a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0
    );
    const clusters: RawStatement[][] = [];
    for (const s of sorted) {
      const hit = clusters.find((c) => c.some((m) => overlaps(m, s)));
      if (hit) hit.push(s);
      else clusters.push([s]);
    }
    for (const cluster of clusters) {
      kept.push(
        cluster.reduce((newest, s) =>
          s.createdAt > newest.createdAt ? s : newest
        )
      );
    }
  }

  return kept;
}

export interface ResolvedStatements<L extends RawStatementLine = RawStatementLine> {
  /** Every trusted, de-duplicated line with its resolution attached. */
  lines: ResolvedLine<L>[];
  /** Lines that resolve to no lease at all: unusable at every scope. */
  unresolvedCount: number;
  /** Lines with a lease but no point: usable at lease scope, not at well scope. */
  leaseOnlyCount: number;
  /** Lines whose printed identifier names more than one facility. */
  ambiguousCount: number;
}

/**
 * The org's statement lines, filtered to trusted statuses, de-duplicated, and resolved.
 *
 * One pass over the whole org rather than one per lease. The roster prices every lease in
 * a request, and paying for this per lease is the mistake the RRC tier already makes.
 */
export function resolveStatementLines<L extends RawStatementLine>(
  lines: L[],
  statements: RawStatement[],
  targets: FacilityTargets,
  /**
   * Collapse re-uploads of the same statement (default). The production series
   * SUMS overlapping periods, so a duplicate there is silent double production.
   * The LEDGER passes false: money that vanishes from a ledger because a rule
   * guessed it was a re-upload is worse than money shown twice, which the user
   * can see and delete. Duplicate uploads are blocked at save instead.
   */
  opts: {
    dedupe?: boolean;
    /**
     * Keep lines that resolve to no lease. Production drops them (a volume with
     * no lease counts at no scope), but the LEDGER must not: a payment whose
     * printed name matches nothing is still money the operator was paid, and
     * money that disappears because a name did not match cannot be found again.
     * It shows with a blank attribution instead.
     */
    keepUnresolved?: boolean;
  } = {}
): ResolvedStatements<L> {
  const trusted = statements.filter((s) => TRUSTED_STATUSES.has(s.status));
  const kept = opts.dedupe === false ? trusted : dedupeStatements(trusted);
  const byId = new Map(kept.map((s) => [s.id, s]));

  const out: ResolvedLine<L>[] = [];
  let unresolvedCount = 0;
  let leaseOnlyCount = 0;
  let ambiguousCount = 0;

  for (const line of lines) {
    const statement = byId.get(line.statementId);
    if (!statement) continue; // untrusted status, or lost the duplicate contest
    const resolved = resolveLine(line, statement, targets);
    if (resolved.flag === "ambiguous-lease" || resolved.flag === "ambiguous-point") {
      ambiguousCount += 1;
    }
    if (!resolved.leaseId) {
      unresolvedCount += 1;
      if (!opts.keepUnresolved) continue;
    }
    if (!resolved.point) leaseOnlyCount += 1;
    out.push(resolved);
  }

  return { lines: out, unresolvedCount, leaseOnlyCount, ambiguousCount };
}

/** A resolved line as the volume the expansion consumes. */
export function toVolume(resolved: ResolvedLine): StatementVolume {
  return {
    periodStart: resolved.statement.periodStart,
    periodEnd: resolved.statement.periodEnd,
    product: resolved.line.product,
    volume: resolved.line.volume,
  };
}
