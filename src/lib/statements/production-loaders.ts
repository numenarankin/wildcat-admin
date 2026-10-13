import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { memo } from "@/lib/cache/request-cache";
import { cachedLeases, cachedTanks, cachedMeters, cachedStatementRows } from "@/lib/cache/loaders";
import { listLeases } from "@/lib/leases/leases";
import { listTanks } from "@/lib/tanks/tanks";
import { listMeters } from "@/lib/meters/meters";
import { pointsForWell } from "./statements";
import { loadRevenueWeighting } from "./revenue";
import { revenueSharesFor, type RevenueTarget } from "./lease-revenue-shares";
import type { MatchTarget } from "./matching";
import {
  resolveStatementLines,
  toVolume,
  type FacilityTargets,
  type ResolvedLine,
} from "./production-resolve";
import {
  expandPeriodsToDaily,
  type StatementSeries,
  type StatementVolume,
} from "./production-series";
import type { PaymentLine, PaymentStatement } from "./payments";

/**
 * Settlement volumes as a production series, per lease and per well
 * (docs/plans/statement-derived-production.md, P2 and P3).
 *
 * ## One org-wide read, not one per lease
 *
 * `leaseMonthlyEstimates` prices every lease in a single request, so a per-lease query here
 * would multiply by the roster's size — the mistake the RRC tier already makes, where each
 * lease re-runs a wells query `resolveLeaseKeys` has just run. The org's lines are read
 * ONCE per request, resolved once, and indexed in memory. A 20-lease org issues one
 * `statement_line_items` query.
 *
 * That is also forced by the data: the read cannot filter on `lease_id` server-side,
 * because that column is null on almost every real row (see `production-resolve.ts`). The
 * lease a line belongs to is decided here, in memory, against current facilities.
 *
 * ## Read paths only
 *
 * Memoized per request like the rest of `@/lib/cache/loaders`. Never call from a server
 * action that writes and then re-reads in the same request; it would see the pre-write
 * value.
 */

type Sb = SupabaseClient;

const LINE_COLS =
  "id, statement_id, lease_id, tank_id, meter_id, lease_ref, " +
  "tank_ref, meter_ref, product, volume, price, taxes, fees, net_value, " +
  "category_code, position, created_at";
const STATEMENT_COLS =
  "id, purchaser_id, period_start, period_end, product, status, statement_no, " +
  "created_at, purchasers(name)";

interface LineRow {
  id: string;
  statement_id: string;
  lease_id: string | null;
  tank_id: string | null;
  meter_id: string | null;
  lease_ref: string | null;
  tank_ref: string | null;
  meter_ref: string | null;
  product: string;
  volume: number | string | null;
  price: number | string | null;
  taxes: number | string | null;
  fees: number | string | null;
  net_value: number | string | null;
  category_code: string | null;
  position: number | null;
  created_at: string;
}

interface StatementRow {
  id: string;
  purchaser_id: string | null;
  period_start: string;
  period_end: string;
  product: string | null;
  status: string | null;
  statement_no: string | null;
  created_at: string;
  purchasers: { name: string | null } | null;
}

function num(v: number | string | null): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n !== null ? (n as number) : 0;
}

/** Same coercion, but a missing price stays missing rather than becoming free oil. */
function numOrNull(v: number | string | null): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : null;
}

/**
 * The org's current facilities, as the matchers consume them.
 *
 * `orgId` is for service-role callers with no RLS org context (the digest cron).
 * It is in the memo key as well as in the queries: a cron looping organizations
 * reuses one admin client, so a key without the org would answer the second org
 * with the first one's facilities and match its statements against them.
 */
async function facilityTargets(sb: Sb, orgId?: string): Promise<FacilityTargets> {
  return memo(sb, `statement-facility-targets:${orgId ?? "rls"}`, async () => {
    // Every substance: a statement names whatever meter the gatherer measured, and
    // filtering to gas here would drop a line for a meter that exists.
    const [leases, tanks, meters] = await Promise.all([
      // The RLS roster is the same four reads the page already made.
      orgId ? listLeases(sb, { orgId }) : cachedLeases(sb),
      orgId ? listTanks(sb, { orgId }) : cachedTanks(sb),
      orgId ? listMeters(sb, "all", { orgId }) : cachedMeters(sb, "all"),
    ]);
    const leaseTargets: MatchTarget[] = leases.map((l) => ({
      id: l.id,
      number: l.leaseNo,
      name: l.name,
    }));
    const tankTargets: MatchTarget[] = tanks.map((t) => ({
      id: t.id,
      number: t.tankNo,
      name: t.name,
    }));
    const meterTargets: MatchTarget[] = meters.map((m) => ({
      id: m.id,
      number: m.meterNo,
      name: m.name,
    }));
    const leaseByPoint = new Map<string, string>();
    // `Tank.leaseId` already resolves battery-authoritative then tank fallback, which
    // is the same effective lease `leaseProductionSeries` filters on. Using it here is
    // what keeps the measured tier and this tier agreeing on which lease a point is on.
    for (const t of tanks) if (t.leaseId) leaseByPoint.set(t.id, t.leaseId);
    for (const m of meters) if (m.leaseId) leaseByPoint.set(m.id, m.leaseId);

    return {
      leases: leaseTargets,
      tanks: tankTargets,
      meters: meterTargets,
      leaseByPoint,
    };
  });
}

/**
 * The org's live statement lines and their statements, read once per request.
 *
 * DELETED LINES NEVER LEAVE THIS FUNCTION. A payment deleted in the ledger is
 * withdrawn as a claim about barrels too, not just about dollars
 * (docs/plans/derived-payments.md §7), and the only way to guarantee that across
 * every consumer is to drop the row at the read rather than at each caller.
 */
export async function orgStatementLines(
  sb: Sb,
  orgId?: string
): Promise<{
  lines: PaymentLine[];
  statements: PaymentStatement[];
  targets: FacilityTargets;
}> {
  return memo(sb, `statement-lines:${orgId ?? "rls"}`, async () => {
    let lineQuery = sb
      .from("statement_line_items")
      .select(LINE_COLS)
      .is("deleted_at", null)
      .order("position", { ascending: true });
    if (orgId) lineQuery = lineQuery.eq("org_id", orgId);
    // The RLS read shares the request's one statements read (every column,
    // a superset of these); a service-role caller names its org and reads
    // its own.
    const stmtRows: Promise<StatementRow[]> = orgId
      ? (async () => {
          const { data, error } = await sb.from("statements").select(STATEMENT_COLS).eq("org_id", orgId);
          if (error) throw new Error(`orgStatementLines (statements): ${error.message}`);
          return (data ?? []) as unknown as StatementRow[];
        })()
      : cachedStatementRows(sb);
    const [lineRes, stmtRes, targets] = await Promise.all([
      lineQuery,
      stmtRows,
      facilityTargets(sb, orgId),
    ]);
    if (lineRes.error) {
      throw new Error(`orgStatementLines (lines): ${lineRes.error.message}`);
    }

    const lines: PaymentLine[] = (
      (lineRes.data ?? []) as unknown as LineRow[]
    ).map((r) => ({
      id: r.id,
      statementId: r.statement_id,
      leaseId: r.lease_id,
      tankId: r.tank_id,
      meterId: r.meter_id,
      leaseRef: r.lease_ref ?? "",
      tankRef: r.tank_ref ?? "",
      meterRef: r.meter_ref ?? "",
      product: r.product === "gas" ? "gas" : "oil",
      volume: num(r.volume),
      price: numOrNull(r.price),
      taxes: num(r.taxes),
      fees: num(r.fees),
      netValue: num(r.net_value),
      categoryCode: r.category_code,
      position: r.position ?? 0,
      createdAt: r.created_at,
    }));
    const statements: PaymentStatement[] = stmtRes.map((r) => ({
      id: r.id,
      purchaserId: r.purchaser_id,
      purchaser: r.purchasers?.name ?? "",
      statementNo: r.statement_no ?? "",
      periodStart: r.period_start,
      periodEnd: r.period_end,
      product: r.product ?? "oil",
      status: r.status ?? "received",
      createdAt: r.created_at,
    }));

    return { lines, statements, targets };
  });
}

/** Every resolved statement line in the org, read and resolved once per request. */
async function orgResolvedLines(sb: Sb) {
  return memo(sb, "statement-resolved-lines", async () => {
    const { lines, statements, targets } = await orgStatementLines(sb);
    return resolveStatementLines(lines, statements, targets);
  });
}

/** What a scope's statement evidence amounts to. */
export interface StatementProduction extends StatementSeries {
  /**
   * Lines that resolve to no lease at all, so they count nowhere.
   *
   * Surfaced rather than swallowed: the fix is for the operator to create the facility
   * or correct the name, and they cannot do that if nothing says the volume is missing.
   */
  unresolvedCount: number;
  /** Lines with a lease but no sale point: counted here, invisible at well scope. */
  leaseOnlyCount: number;
  /** Lines whose printed identifier names more than one facility. */
  ambiguousCount: number;
}

const EMPTY: StatementProduction = {
  oil: [],
  gas: [],
  unresolvedCount: 0,
  leaseOnlyCount: 0,
  ambiguousCount: 0,
};

function seriesFrom(
  lines: ResolvedLine[],
  counts: Omit<StatementProduction, "oil" | "gas">
): StatementProduction {
  const volumes: StatementVolume[] = lines.map(toVolume);
  return { ...expandPeriodsToDaily(volumes), ...counts };
}

/**
 * One lease's settled volumes as a daily series.
 *
 * NO ALLOCATION HAPPENS HERE. A statement line already belongs to one lease, so lease
 * scope is a filter and a sum; splitting only enters at well scope. This is also why the
 * multi-battery case needs nothing special: a line resolves to one tank or meter, hence
 * one battery, so there is never an inter-battery split to invent.
 */
export async function leaseStatementSeries(
  sb: Sb,
  leaseId: string
): Promise<StatementProduction> {
  const resolved = await orgResolvedLines(sb);
  const mine = resolved.lines.filter((l) => l.leaseId === leaseId);
  if (mine.length === 0) {
    return { ...EMPTY, unresolvedCount: resolved.unresolvedCount };
  }
  return seriesFrom(mine, {
    unresolvedCount: resolved.unresolvedCount,
    leaseOnlyCount: mine.filter((l) => !l.point).length,
    ambiguousCount: resolved.ambiguousCount,
  });
}

/** The org's settled volumes, every lease summed. Not a roll-up of leases: a line whose
 *  point carries no lease still belongs to the company. */
export async function orgStatementSeries(
  sb: Sb
): Promise<StatementProduction> {
  const resolved = await orgResolvedLines(sb);
  return seriesFrom(resolved.lines, {
    unresolvedCount: resolved.unresolvedCount,
    leaseOnlyCount: resolved.leaseOnlyCount,
    ambiguousCount: resolved.ambiguousCount,
  });
}

/** Every lease's series in one pass, for the roster (one read, not one per lease). */
export async function statementSeriesByLease(
  sb: Sb
): Promise<Map<string, StatementProduction>> {
  const resolved = await orgResolvedLines(sb);
  const byLease = new Map<string, ResolvedLine[]>();
  for (const l of resolved.lines) {
    if (!l.leaseId) continue;
    const at = byLease.get(l.leaseId);
    if (at) at.push(l);
    else byLease.set(l.leaseId, [l]);
  }
  const out = new Map<string, StatementProduction>();
  for (const [id, lines] of byLease) {
    out.set(
      id,
      seriesFrom(lines, {
        unresolvedCount: resolved.unresolvedCount,
        leaseOnlyCount: lines.filter((l) => !l.point).length,
        ambiguousCount: resolved.ambiguousCount,
      })
    );
  }
  return out;
}

/**
 * One well's share of its lease's settled volumes, as a daily series.
 *
 * Texas splits a lease by W-10 test ratio because it has nothing else. Here the operator's
 * OWN evidence is available and is better, so this reuses `revenueShares` — the identical
 * split the revenue ledger and `wellPurchaserSales` already run. That is the point: a
 * statement-derived well series and the money posted from the same statement come out of
 * one derivation, so they cannot drift.
 *
 * Its ladder degrades all the way down and never runs out: the org's own well tests
 * weighted by online days, an untested well pinned to its `straightPct`, the whole point
 * on the straight split when nothing is weightable, a fixed split when every well was down
 * all period, and 100 percent to a single-well point. `straightPct` is operator-entered
 * and validated to sum to 100 per effective period, which is what makes it a floor rather
 * than another way to fail.
 *
 * A line that resolves to the well's LEASE and no point is split lease-wide through the
 * lease's batteries and meters (`leaseRevenueShares`) - the purchaser settles the lease,
 * and the operator's allocation is the same evidence either way. Only a line with no lease
 * at all is left out; `leaseOnlyCount` still reports how many lines carried no point.
 */
export async function wellStatementSeries(
  sb: Sb,
  wellId: string
): Promise<StatementProduction> {
  const [resolved, points, weighting, leaseId] = await Promise.all([
    orgResolvedLines(sb),
    pointsForWell(sb, wellId),
    memo(sb, "statement-revenue-weighting", () => loadRevenueWeighting(sb)),
    wellLeaseId(sb, wellId),
  ]);

  const tankIds = new Set(points.tankIds);
  const meterIds = new Set(points.meterIds);
  const mine = resolved.lines.filter((l) =>
    l.point !== null
      ? (l.point.type === "tank" ? tankIds : meterIds).has(l.point.id)
      : leaseId !== null && l.leaseId === leaseId
  );
  if (mine.length === 0) {
    return { ...EMPTY, unresolvedCount: resolved.unresolvedCount };
  }

  const volumes: StatementVolume[] = [];
  for (const l of mine) {
    const period = {
      from: l.statement.periodStart,
      to: l.statement.periodEnd,
    };
    const target: RevenueTarget = l.point
      ? { type: l.point.type, id: l.point.id, wellId }
      : { type: "lease", id: l.leaseId!, product: l.line.product };
    const shares = await revenueSharesFor(sb, target, period, weighting);
    const share = shares.get(wellId) ?? 0;
    if (share <= 0) continue;
    volumes.push({ ...toVolume(l), volume: l.line.volume * share });
  }

  return {
    ...expandPeriodsToDaily(volumes),
    unresolvedCount: resolved.unresolvedCount,
    leaseOnlyCount: resolved.leaseOnlyCount,
    ambiguousCount: resolved.ambiguousCount,
  };
}

/** The lease a well sits on, or null. Memoised: the page asks in several places. */
function wellLeaseId(sb: Sb, wellId: string): Promise<string | null> {
  return memo(sb, `well-lease:${wellId}`, async () => {
    const { data, error } = await sb.from("wells").select("lease_id").eq("id", wellId).maybeSingle();
    if (error) throw new Error(`wellLeaseId: ${error.message}`);
    return (data as { lease_id: string | null } | null)?.lease_id ?? null;
  });
}
