import "server-only";

import { z } from "zod";

import { rrcQuery } from "@/lib/scout/rrc-db";
import {
  getCycleEdge,
  getLeaseDossier,
  getOperatorDisposition,
  getOperatorDossier,
  getOperatorNetwork,
  getPendingQueue,
  listPermits,
  type PermitRow,
} from "@/lib/scout/rrc-queries";
import type {
  DispositionMonth,
  DispositionStream,
  LeaseMonth,
} from "@/lib/scout/rrc-types";
import { hhi, linearFit, median, sum } from "../math";
import { ENTITY_SHAPE, isError, resolveSeries, STREAMS, type Stream } from "../series";
import { defineTool, type RrcTool } from "../tool";

/**
 * The columns of the production filing that nothing else in this app reads:
 * allowables, ending balances, disposition totals, and the per-code disposition
 * split.
 *
 * Volumes say what a lease made. These say what it was ALLOWED to make, what it
 * failed to sell, and where the product went. Four facts govern every number
 * below, and each one is attached to the result rather than left in a comment,
 * because each is a wrong answer waiting to happen:
 *
 *   1. AN ALLOWABLE IS A CEILING, NOT A TARGET. Most Texas leases sit far under
 *      theirs because the wells cannot make it, not because anyone is holding
 *      them back. Low utilisation on its own is not a choke and this file never
 *      calls it one.
 *   2. A NULL ALLOWABLE IS "NOT STATED ON THIS FILING". Never zero, never
 *      unlimited. Those months are counted separately and kept out of every
 *      ratio; a zero would invent a shut-in and an infinity would invent room.
 *   3. THE RRC RUNS ABOUT THREE CYCLES BEHIND and unfiled cycles sit in the
 *      mirror as zeros. Every window here stops at the reported edge, and
 *      months the operator explicitly did not file (`prod_report_filed = 'N'`,
 *      18% of lease-months) are dropped rather than read as zero production
 *      against a live allowable.
 *   4. DISPOSITION CODES ARE NOT LABELLED, HERE OR ANYWHERE IN THE MIRROR. See
 *      NO_CODE_LABELS. Nothing in this file names a code.
 */

const CEILING_NOT_TARGET =
  "An allowable is a monthly legal ceiling, not a target. A lease under its allowable is usually a lease whose wells cannot make it, not a lease being held back.";

const NULL_ALLOWABLE =
  "A month with no allowable on the filing is 'not stated', never zero and never unlimited. Those months are counted separately and excluded from every ratio here.";

const NOT_FILED =
  "Months the operator reported as not filed are dropped, not read as zero. A zero production month against a stated allowable would otherwise look like a total shut-in.";

const LAG = (edge: string) =>
  `Production filing runs about three cycles behind. Everything here stops at ${edge}; a thin recent tail is late filing, not a lease that stopped.`;

const NO_CODE_LABELS =
  "The mirror carries NO disposition code label table, and the RRC PDQ manual that holds it is not in this repository. Codes are reported raw. Nothing here is named 'vented', 'flared', 'stock', 'lease use' or 'gathered', because a mislabelled flare number is worse than a bare code.";

function fail(error: string) {
  return { ok: false as const, error };
}

/**
 * The four streams and the columns that describe each one.
 *
 * Note the ceiling is called `allow` for oil and gas and `limit` for condensate
 * and casinghead: that is the RRC's own naming and both play the same role, so
 * the output says which word the filing used.
 */
const COLS: Record<
  Stream,
  { vol: string; allow: string; allowWord: "allowable" | "limit"; disp: string; bal: string | null; unit: string }
> = {
  oil: { vol: "oil_prod_vol", allow: "oil_allow", allowWord: "allowable", disp: "oil_tot_disp", bal: "oil_ending_bal", unit: "bbl" },
  gas: { vol: "gas_prod_vol", allow: "gas_allow", allowWord: "allowable", disp: "gas_tot_disp", bal: null, unit: "mcf" },
  cond: { vol: "cond_prod_vol", allow: "cond_limit", allowWord: "limit", disp: "cond_tot_disp", bal: "cond_ending_bal", unit: "bbl" },
  csgd: { vol: "csgd_prod_vol", allow: "csgd_limit", allowWord: "limit", disp: "csgd_tot_disp", bal: null, unit: "mcf" },
};

/** A finite number, or null. Guards against the mirror handing back a string. */
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && v != null && v !== "" ? n : null;
}

export interface AllowableRow {
  cycle: string;
  produced: number;
  /** Null means the filing stated no ceiling for this month. */
  allowable: number | null;
  /** Allowable minus produced. Null when no ceiling was stated. */
  headroom: number | null;
  /** Produced over allowable. Null when no ceiling was stated or it was zero. */
  utilisation: number | null;
}

/** One lease-month against its ceiling. The whole arithmetic of tool 74. */
export function allowableRow(m: LeaseMonth, stream: Stream): AllowableRow {
  const c = COLS[stream];
  const produced = num((m as unknown as Record<string, unknown>)[c.vol]) ?? 0;
  const allowable = num((m as unknown as Record<string, unknown>)[c.allow]);
  return {
    cycle: m.cycle,
    produced,
    allowable,
    headroom: allowable === null ? null : allowable - produced,
    // Zero allowable divides to infinity, and "infinitely over its ceiling" is
    // not a number anyone can act on. A zero ceiling shows in `headroom`.
    utilisation: allowable !== null && allowable > 0 ? produced / allowable : null,
  };
}

/** Months to analyse, clamped. The mirror holds 33 years; a context does not. */
function windowMonths(months: number | undefined, dflt = 12, max = 120): number {
  return Math.min(max, Math.max(1, Math.floor(months ?? dflt)));
}

function cap(limit: number | undefined, dflt: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(limit ?? dflt)));
}

/** Reported, and actually filed. Rule 3 in the header, in one place. */
function usableMonths(months: LeaseMonth[], edge: string): LeaseMonth[] {
  return months.filter((m) => m.reported && m.cycle <= edge && m.prod_report_filed !== "N");
}

// --------------------------------------------------------- per-lease reads

export interface LeasePosition {
  key: string;
  oil_gas_code: string;
  district_no: string;
  lease_no: string;
  lease_name: string | null;
  field_no: string | null;
  field_name: string | null;
  /** Filed months inside the window. */
  months: number;
  produced: number;
  /** Produced in the months that stated a ceiling. The only comparable total. */
  produced_when_allowed: number;
  /** Summed ceiling over the months that stated one. Null when none did. */
  allowable: number | null;
  allowable_months: number;
  /** Total disposition: what left the lease by any route. */
  disposed: number;
  /** Oldest and newest stated ending balance in the window, or null. */
  balance_first: number | null;
  balance_last: number | null;
}

/**
 * One operator's or one district's leases, aggregated against the ceiling.
 *
 * The single new query in this file, shared by tools 74, 75, 78 and 91 so a
 * headroom quoted by one cannot disagree with a headroom quoted by another.
 *
 * BOUNDED THREE WAYS, because `rrc.lease_production` is 78.6M rows behind a 5 s
 * statement timeout: an indexed equality on operator or district, a cycle range
 * anchored to the reported edge so the hypertable prunes to those chunks, and a
 * row cap. The column names are interpolated from `COLS`, a fixed internal map,
 * never from an argument; every value is parameterised.
 */
async function leasePositions(
  filter: { operatorNo?: string; districtNo?: string },
  stream: Stream,
  months: number,
  limit: number,
  edge: string
): Promise<LeasePosition[]> {
  const c = COLS[stream];
  const who = filter.operatorNo ? "operator_no" : "district_no";
  const key = filter.operatorNo ?? filter.districtNo;
  const bal = c.bal
    ? `(array_agg(lp.${c.bal} order by lp.cycle) filter (where lp.${c.bal} is not null))[1]      as balance_first,
       (array_agg(lp.${c.bal} order by lp.cycle desc) filter (where lp.${c.bal} is not null))[1] as balance_last`
    : `null::bigint as balance_first, null::bigint as balance_last`;

  const rows = await rrcQuery<Omit<LeasePosition, "key">>(
    `with agg as (
       select lp.oil_gas_code, lp.district_no, lp.lease_no,
              max(lp.field_no)                                                as field_no,
              count(*)::int                                                   as months,
              coalesce(sum(lp.${c.vol}), 0)::bigint                           as produced,
              coalesce(sum(lp.${c.vol}) filter (where lp.${c.allow} is not null), 0)::bigint
                                                                              as produced_when_allowed,
              sum(lp.${c.allow})::bigint                                      as allowable,
              count(lp.${c.allow})::int                                       as allowable_months,
              coalesce(sum(lp.${c.disp}), 0)::bigint                          as disposed,
              ${bal}
         from rrc.lease_production lp
        where lp.${who} = $1
          and lp.cycle >  (to_date($2, 'YYYY-MM') - interval '${months} months')
          and lp.cycle <=  to_date($2, 'YYYY-MM')
          and coalesce(lp.prod_report_filed, 'Y') <> 'N'
        group by 1, 2, 3
     )
     select a.oil_gas_code, a.district_no, a.lease_no, a.field_no, a.months,
            a.produced, a.produced_when_allowed, a.allowable, a.allowable_months,
            a.disposed, a.balance_first, a.balance_last,
            l.lease_name, f.field_name
       from agg a
       left join rrc.lease l
              on l.oil_gas_code = a.oil_gas_code
             and l.district_no  = a.district_no
             and l.lease_no     = a.lease_no
       left join rrc.field f on f.field_no = a.field_no
      order by a.produced desc
      limit $3`,
    [key, edge, limit]
  );
  return rows.map((r) => ({
    ...r,
    key: `${r.oil_gas_code}/${r.district_no}/${r.lease_no}`,
  }));
}

/** Utilisation over a window. Null unless a ceiling was actually stated. */
function positionUtilisation(p: LeasePosition): number | null {
  return p.allowable !== null && p.allowable > 0 ? p.produced_when_allowed / p.allowable : null;
}

// ------------------------------------------------------------------ 74

const allowableHeadroom = defineTool(
  "rrc_allowable_headroom",
  "Production against the filed monthly allowable, per month for a lease or well and per lease for an operator, showing who has room to ramp and who is at the ceiling.",
  {
    ...ENTITY_SHAPE,
    stream: z.enum(STREAMS).optional(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    const stream = args.stream ?? "oil";
    const c = COLS[stream];
    const months = windowMonths(args.months, 12);
    const { reported: edge } = await getCycleEdge();

    // The pre-aggregated geographic rollups carry no allowable, and the
    // operator rollup this app reads selects only volumes. Both are refusals
    // with a named cause rather than a table of nulls.
    if (args.entity === "operator") {
      if (!args.operator_no) return fail("entity 'operator' needs operator_no.");
      const rowCap = cap(args.limit, 50, 200);
      const positions = await leasePositions(
        { operatorNo: args.operator_no.trim() },
        stream,
        months,
        rowCap,
        edge
      );
      const scored = positions.filter((p) => p.allowable !== null);
      const ranked = scored
        .map((p) => ({
          key: p.key,
          lease_name: p.lease_name,
          field_name: p.field_name,
          filed_months: p.months,
          months_with_ceiling: p.allowable_months,
          produced: p.produced,
          produced_when_allowed: p.produced_when_allowed,
          allowable: p.allowable,
          headroom: p.allowable! - p.produced_when_allowed,
          utilisation: positionUtilisation(p),
        }))
        .sort((a, b) => b.headroom - a.headroom);
      return {
        ok: true as const,
        scope: "operator",
        operator_no: args.operator_no.trim(),
        stream,
        unit: c.unit,
        ceiling_column: `${c.allow} (${c.allowWord})`,
        window_months: months,
        reported_through: edge,
        leases: positions.length,
        leases_with_ceiling: scored.length,
        // Held out, not folded in at zero. A lease with no stated ceiling has
        // unknown room, and counting it as full or empty invents both.
        leases_without_ceiling: positions
          .filter((p) => p.allowable === null)
          .map((p) => ({ key: p.key, lease_name: p.lease_name, produced: p.produced })),
        // Null, not zero, when nothing stated a ceiling: "no room" and "room
        // unknown" are different answers and only one of them is a number.
        total_allowable: scored.length ? sum(scored.map((p) => p.allowable)) : null,
        total_produced_when_allowed: sum(scored.map((p) => p.produced_when_allowed)),
        total_headroom: scored.length
          ? sum(scored.map((p) => p.allowable)) - sum(scored.map((p) => p.produced_when_allowed))
          : null,
        ranked,
        at_ceiling: ranked.filter((r) => r.utilisation !== null && r.utilisation >= 0.95).length,
        truncated: positions.length >= rowCap,
        notes: [CEILING_NOT_TARGET, NULL_ALLOWABLE, NOT_FILED, LAG(edge)],
      };
    }

    if (args.entity !== "lease" && args.entity !== "well") {
      return fail(
        `Allowables are filed at lease grain and the pre-aggregated ${args.entity} rollup carries none. Use entity 'lease', 'well' or 'operator'.`
      );
    }

    const series = await resolveSeries(args);
    if (isError(series)) return fail(series.error);
    if (!series.months) return fail(`No lease-grain months for ${series.label}.`);

    const usable = usableMonths(series.months, edge);
    const all = usable.map((m) => allowableRow(m, stream));
    const rows = all.slice(-months);
    const stated = rows.filter((r) => r.allowable !== null);
    const producedWhenAllowed = sum(stated.map((r) => r.produced));
    const totalAllowable = sum(stated.map((r) => r.allowable));

    return {
      ok: true as const,
      scope: args.entity,
      label: series.label,
      stream,
      unit: c.unit,
      ceiling_column: `${c.allow} (${c.allowWord})`,
      reported_through: edge,
      filed_months: rows.length,
      months_with_ceiling: stated.length,
      months_without_ceiling: rows.length - stated.length,
      total_allowable: stated.length ? totalAllowable : null,
      total_produced_when_allowed: producedWhenAllowed,
      total_headroom: stated.length ? totalAllowable - producedWhenAllowed : null,
      utilisation: totalAllowable > 0 ? producedWhenAllowed / totalAllowable : null,
      latest: rows[rows.length - 1] ?? null,
      series: rows,
      truncated: all.length > rows.length,
      notes: [CEILING_NOT_TARGET, NULL_ALLOWABLE, NOT_FILED, LAG(edge)],
    };
  }
);

// ------------------------------------------------------------------ 75

/** Below this a lease is worth looking at. Above it, nothing to explain. */
const CHOKE_UTILISATION = 0.75;
/** Disposition within this fraction of production is "moved everything". */
const MOVED_ALL = 0.99;

/**
 * What the filing can distinguish, and what it cannot.
 *
 * The record has exactly one lever here: a lease that produced more than it
 * disposed of put the difference in a tank, and a rising ending balance says
 * the same thing a second way. Product made and not sold is a MARKET or
 * TAKEAWAY problem: the wells worked, the barrels had nowhere to go.
 *
 * The other side has no such lever. A lease that sold everything it made and
 * still came in under its ceiling could be choked at the wellhead, worn out,
 * watered out, or simply never able to make the number. The filing does not
 * separate those, and this returns `constraint_upstream_of_the_tank` rather
 * than picking one.
 */
type ChokeVerdict =
  | "stock_building"
  | "constraint_upstream_of_the_tank"
  | "indeterminate";

function classifyChoke(
  p: LeasePosition,
  /**
   * Whether this stream has an ending balance at all. Stated here as well as in
   * the SQL that returns null for gas: if that ever loosens, a gas lease would
   * pick up a stock verdict for a barrel of oil it never had.
   */
  hasBalance: boolean
): { verdict: ChokeVerdict; why: string } {
  if (p.disposed <= 0 && p.produced > 0) {
    return {
      verdict: "indeterminate",
      why: "The lease filed production but no disposition total, so nothing can be said about where the product went.",
    };
  }
  const rising =
    hasBalance &&
    p.balance_first !== null &&
    p.balance_last !== null &&
    p.balance_last > p.balance_first;
  if (p.produced > 0 && p.disposed < p.produced * MOVED_ALL && rising) {
    return {
      verdict: "stock_building",
      why: "Produced more than it disposed of and the ending balance rose: product was made and not sold, which is a market or takeaway constraint.",
    };
  }
  if (p.produced > 0 && p.disposed >= p.produced * MOVED_ALL) {
    return {
      verdict: "constraint_upstream_of_the_tank",
      why: "Sold essentially everything it made and still came in under the ceiling. The limit is at the wellhead or in the reservoir, and the filing cannot say which.",
    };
  }
  return {
    verdict: "indeterminate",
    why: "Disposition and ending balance do not move together clearly enough to separate a takeaway constraint from a well that cannot make its ceiling.",
  };
}

const chokeDetect = defineTool(
  "rrc_choke_detect",
  "Leases running well under their filed ceiling, split by whether the product was made and not sold (takeaway or market) or sold in full and still short (wellhead or reservoir).",
  {
    operator_no: z.string().optional(),
    district_no: z.string().optional(),
    stream: z.enum(STREAMS).optional(),
    months: z.number().int().optional(),
    max_utilisation: z.number().optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    if (!args.operator_no && !args.district_no) {
      return fail("Needs operator_no or district_no: an unfiltered lease scan is 78.6M rows.");
    }
    const stream = args.stream ?? "oil";
    const c = COLS[stream];
    const months = windowMonths(args.months, 12);
    const rowCap = cap(args.limit, 50, 200);
    const threshold = Math.min(1, Math.max(0, args.max_utilisation ?? CHOKE_UTILISATION));
    const { reported: edge } = await getCycleEdge();

    const positions = await leasePositions(
      args.operator_no
        ? { operatorNo: args.operator_no.trim() }
        : { districtNo: args.district_no!.trim() },
      stream,
      months,
      rowCap,
      edge
    );

    const scored = positions.filter((p) => p.allowable !== null && p.allowable > 0);
    const under = scored.filter((p) => (positionUtilisation(p) ?? 1) < threshold);
    const flagged = under
      .map((p) => {
        const { verdict, why } = classifyChoke(p, c.bal !== null);
        return {
          key: p.key,
          lease_name: p.lease_name,
          field_name: p.field_name,
          filed_months: p.months,
          months_with_ceiling: p.allowable_months,
          produced_when_allowed: p.produced_when_allowed,
          allowable: p.allowable,
          headroom: p.allowable! - p.produced_when_allowed,
          utilisation: positionUtilisation(p),
          disposed: p.disposed,
          undisposed: p.produced - p.disposed,
          balance_first: p.balance_first,
          balance_last: p.balance_last,
          balance_change:
            p.balance_first !== null && p.balance_last !== null
              ? p.balance_last - p.balance_first
              : null,
          verdict,
          why,
        };
      })
      .sort((a, b) => b.headroom - a.headroom);

    const byVerdict = (v: ChokeVerdict) => flagged.filter((f) => f.verdict === v).length;
    return {
      ok: true as const,
      scope: args.operator_no ? "operator" : "district",
      operator_no: args.operator_no?.trim() ?? null,
      district_no: args.district_no?.trim() ?? null,
      stream,
      unit: c.unit,
      ceiling_column: `${c.allow} (${c.allowWord})`,
      window_months: months,
      reported_through: edge,
      max_utilisation: threshold,
      leases: positions.length,
      leases_with_ceiling: scored.length,
      leases_under_threshold: flagged.length,
      stock_building: byVerdict("stock_building"),
      constraint_upstream_of_the_tank: byVerdict("constraint_upstream_of_the_tank"),
      indeterminate: byVerdict("indeterminate"),
      // The ending-balance test only exists for oil and condensate. Gas is not
      // stored on the lease, so a gas run of this tool can never reach
      // `stock_building` and the caveat has to travel with the result.
      stock_test_available: c.bal !== null,
      leases_detail: flagged,
      truncated: positions.length >= rowCap,
      notes: [
        CEILING_NOT_TARGET,
        "Under-allowable is a SCREEN, not a finding. This tool separates product made and not sold from product sold in full; it cannot separate a choked well from a depleted one, and does not try.",
        c.bal === null
          ? `${stream} has no ending balance on the filing, so the stock-building test is unavailable and every result here is at best 'constraint upstream of the tank'.`
          : "Stock building is read from total disposition falling short of production AND a rising ending balance. Either alone is weaker.",
        NULL_ALLOWABLE,
        NOT_FILED,
        LAG(edge),
      ],
    };
  }
);

// ------------------------------------------------------------------ 76

const inventorySignal = defineTool(
  "rrc_inventory_signal",
  "Ending-balance trend for a lease or well: oil in the tanks that did not sell, which climbs when takeaway breaks or someone holds barrels for price.",
  {
    ...ENTITY_SHAPE,
    stream: z.enum(["oil", "cond"]).optional(),
    months: z.number().int().optional(),
  },
  async (args) => {
    const stream: Stream = args.stream ?? "oil";
    const c = COLS[stream];
    if (args.entity !== "lease" && args.entity !== "well") {
      return fail(
        `Ending balances are filed at lease grain; the ${args.entity} rollup this app reads carries none. Use entity 'lease' or 'well'.`
      );
    }
    const months = windowMonths(args.months, 24);
    const { reported: edge } = await getCycleEdge();
    const series = await resolveSeries(args);
    if (isError(series)) return fail(series.error);
    if (!series.months) return fail(`No lease-grain months for ${series.label}.`);

    const usable = usableMonths(series.months, edge);
    const all = usable.map((m) => {
      const r = m as unknown as Record<string, unknown>;
      const produced = num(r[c.vol]) ?? 0;
      const balance = num(r[c.bal!]);
      const disposed = num(r[c.disp]);
      return {
        cycle: m.cycle,
        produced,
        disposed,
        ending_balance: balance,
        // How long the tanks would cover, at this month's own rate. The unit
        // that makes a balance readable: 40,000 bbl is a crisis on one lease
        // and a rounding error on another.
        days_of_production: balance !== null && produced > 0 ? balance / (produced / 30.4375) : null,
      };
    });
    const rows = all.slice(-months);
    const stated = rows.filter((r) => r.ending_balance !== null);
    if (stated.length < 2) {
      return {
        ok: true as const,
        label: series.label,
        stream,
        unit: c.unit,
        reported_through: edge,
        months_with_balance: stated.length,
        direction: null,
        slope_per_month: null,
        series: rows,
        truncated: all.length > rows.length,
        notes: [
          "Fewer than two months state an ending balance, so there is no trend to report. A missing balance is 'not stated', not an empty tank.",
          LAG(edge),
        ],
      };
    }

    // Fitted against the month's position in the STATED set, not the calendar,
    // so a gap in filing does not tilt the line.
    const fit = linearFit(stated.map((r, i) => [i, r.ending_balance!] as const));
    const slope = fit?.slope ?? null;
    const first = stated[0].ending_balance!;
    const last = stated[stated.length - 1].ending_balance!;
    const avg = sum(stated.map((r) => r.ending_balance)) / stated.length;

    return {
      ok: true as const,
      label: series.label,
      stream,
      unit: c.unit,
      reported_through: edge,
      months_in_window: rows.length,
      months_with_balance: stated.length,
      first_balance: first,
      latest_balance: last,
      change: last - first,
      slope_per_month: slope,
      // Relative slope is what makes two leases comparable. Null when the
      // average balance is zero, because a percentage of nothing is not one.
      slope_share_per_month: slope !== null && avg > 0 ? slope / avg : null,
      r2: fit?.r2 ?? null,
      direction: slope === null ? null : slope > 0 ? "rising" : slope < 0 ? "falling" : "flat",
      latest_days_of_production: rows[rows.length - 1]?.days_of_production ?? null,
      undisposed_in_window:
        sum(rows.map((r) => r.produced)) - sum(rows.map((r) => r.disposed)),
      series: rows,
      truncated: all.length > rows.length,
      notes: [
        "A rising ending balance is oil made and not sold. It does not say why: a broken connection, a purchaser who stopped taking, and an operator holding barrels for a better price all look identical on the filing.",
        "The trend is fitted over the months that STATED a balance. Months that did not are shown in the series and left out of the fit.",
        NOT_FILED,
        LAG(edge),
      ],
    };
  }
);

// ------------------------------------------------------------------ 77

/**
 * Disposition per RRC two-digit code.
 *
 * THE CODE TABLE IS NOT IN THE MIRROR. It lives in the RRC PDQ manual, which is
 * not in this repository: `rrc-uic.ts` decodes UIC, H-15, W-10, P-4 and plugging
 * domains and has no disposition map, `disposition-panel.tsx` ships raw codes on
 * purpose, and `docs/plans/scout-rrc-mirror-ui.md` §5 records the same decision
 * with "do not guess these labels".
 *
 * So this tool takes the vent/flare code set as an ARGUMENT. The documented
 * default is the EMPTY SET: with nothing supplied it classifies nothing, and
 * returns the full ranked per-code breakdown so a caller who does know the
 * codes can read the number straight off. Guessing a default would put an
 * invented "flared" total into an answer, which is the one outcome worse than
 * an unlabelled code.
 */
const DEFAULT_VENT_FLARE_CODES: string[] = [];

function codeTotals(rows: DispositionMonth[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const m of rows) {
    for (const [code, v] of Object.entries(m.codes)) {
      totals.set(code, (totals.get(code) ?? 0) + v);
    }
  }
  return totals;
}

const flareMap = defineTool(
  "rrc_flare_map",
  "Disposition volume per raw RRC two-digit code over time for a lease or operator, with an optional caller-supplied vent/flare code set subtotalled.",
  {
    oil_gas_code: z.enum(["O", "G"]).optional(),
    district_no: z.string().optional(),
    lease_no: z.string().optional(),
    operator_no: z.string().optional(),
    stream: z.enum(STREAMS).optional(),
    months: z.number().int().optional(),
    vent_flare_codes: z.array(z.string()).optional(),
  },
  async (args) => {
    const stream: DispositionStream = args.stream ?? "csgd";
    const months = windowMonths(args.months, 24, 400);
    const codes = (args.vent_flare_codes ?? DEFAULT_VENT_FLARE_CODES).map((s) => s.trim());

    let disposition: Record<DispositionStream, DispositionMonth[]>;
    let label: string;
    if (args.operator_no) {
      const key = args.operator_no.trim();
      disposition = await getOperatorDisposition(key);
      label = `operator ${key}`;
    } else if (args.oil_gas_code && args.district_no && args.lease_no) {
      const lease = await getLeaseDossier(args.oil_gas_code, args.district_no, args.lease_no);
      if (!lease) {
        return fail(`No lease ${args.oil_gas_code}/${args.district_no}/${args.lease_no}.`);
      }
      disposition = lease.disposition;
      label = lease.lease_name ?? `${args.oil_gas_code}/${args.district_no}/${args.lease_no}`;
    } else {
      // Area rollups are the deliberate gap. `lease_cycle_disp` is 48.5M rows
      // and the operator read already needs a lifted statement timeout; a
      // district or county grouping over it is the unbounded query this
      // codebase does not allow.
      return fail(
        "Needs operator_no, or oil_gas_code + district_no + lease_no. Area-wide disposition is not offered: rrc.lease_cycle_disp is 48.5M rows and has no area rollup, so a district or county grouping cannot be served inside the query budget."
      );
    }

    const all = disposition[stream] ?? [];
    const rows = all.slice(-months);
    const totals = codeTotals(rows);
    const grand = sum([...totals.values()]);
    const ranked = [...totals.entries()]
      .map(([code, volume]) => ({
        code,
        volume,
        share: grand > 0 ? volume / grand : null,
      }))
      .sort((a, b) => b.volume - a.volume);

    const known = codes.filter((c) => totals.has(c));
    const unknown = codes.filter((c) => !totals.has(c));
    const selected = sum(known.map((c) => totals.get(c)));

    return {
      ok: true as const,
      label,
      stream,
      window_months: months,
      months_with_volume: rows.length,
      total_volume: grand,
      by_code: ranked,
      /** Per-cycle series, one entry per code the caller asked about. */
      selected_codes: codes,
      selected_codes_absent: unknown,
      selected_volume: codes.length ? selected : null,
      selected_share: codes.length && grand > 0 ? selected / grand : null,
      selected_series: codes.length
        ? rows.map((m) => ({
            cycle: m.cycle,
            volume: sum(codes.map((c) => m.codes[c])),
          }))
        : [],
      series: rows.map((m) => ({ cycle: m.cycle, codes: m.codes })),
      truncated: all.length > rows.length,
      notes: [
        NO_CODE_LABELS,
        codes.length
          ? `Subtotal covers exactly the codes the caller named: ${codes.join(", ")}. This tool did not choose them and does not vouch for them.`
          : "No vent/flare code set was supplied, so nothing is classified. The default is deliberately empty: pass vent_flare_codes with the codes from the RRC PDQ manual to get a subtotal.",
        "Disposition is what the operator reported, by route, for the whole lease. It is not a measured flare volume and there is no meter behind it.",
        args.operator_no
          ? "Operator-grain disposition spans every lease the operator has ever held and runs on a lifted statement timeout. Expect it to be slow."
          : "Lease-grain disposition, straight from the filing.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 78

const gasOrphan = defineTool(
  "rrc_gas_orphan",
  "Producing leases making casinghead gas with no disposition filed for it, and for a single lease whether any P-4 counterparty is set up to take it.",
  {
    operator_no: z.string().optional(),
    district_no: z.string().optional(),
    oil_gas_code: z.enum(["O", "G"]).optional(),
    lease_no: z.string().optional(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    const months = windowMonths(args.months, 12);
    const { reported: edge } = await getCycleEdge();

    // Single lease: the only grain where the P-4 can be read without a lookup
    // per lease, and the P-4 is what says whether a taker exists at all.
    if (args.oil_gas_code && args.district_no && args.lease_no) {
      const lease = await getLeaseDossier(args.oil_gas_code, args.district_no, args.lease_no);
      if (!lease) {
        return fail(`No lease ${args.oil_gas_code}/${args.district_no}/${args.lease_no}.`);
      }
      const usable = usableMonths(lease.monthly, edge).slice(-months);
      const produced = sum(usable.map((m) => m.csgd_prod_vol));
      const disposed = sum(usable.map((m) => m.csgd_tot_disp));
      // 'P' is casinghead gas and 'F' is full well stream, which carries the
      // casinghead with it. Either counterparty means the gas has somewhere to
      // go on paper.
      const takers = lease.p4.connections.filter(
        (p) => p.product_code === "P" || p.product_code === "F"
      );
      return {
        ok: true as const,
        scope: "lease",
        key: `${lease.oil_gas_code}/${lease.district_no}/${lease.lease_no}`,
        label: lease.lease_name,
        window_months: months,
        filed_months: usable.length,
        reported_through: edge,
        csgd_produced: produced,
        csgd_disposed: disposed,
        undisposed: produced - disposed,
        undisposed_share: produced > 0 ? (produced - disposed) / produced : null,
        p4_casinghead_takers: takers.map((p) => ({
          product_code: p.product_code,
          type_code: p.type_code,
          operator_name: p.operator_name,
          gpn_no: p.gpn_no,
          actual_percent: p.actual_percent,
          effective_date: p.effective_date,
        })),
        orphan: produced > 0 && (takers.length === 0 || disposed <= 0),
        why:
          produced <= 0
            ? "The lease reported no casinghead gas in the window, so there is nothing to orphan."
            : takers.length === 0
              ? "Casinghead gas produced and NO P-4 gatherer, purchaser or nominator is on file for it or for the full well stream."
              : disposed <= 0
                ? "A P-4 counterparty exists but the lease filed no casinghead disposition at all."
                : "Casinghead gas is produced and a P-4 counterparty is on file.",
        notes: [
          "A missing P-4 casinghead connection is a paperwork fact, not a measurement. The gas is being vented, flared, used on the lease, or simply reported another way, and the record does not say which.",
          NO_CODE_LABELS,
          NOT_FILED,
          LAG(edge),
        ],
      };
    }

    if (!args.operator_no && !args.district_no) {
      return fail(
        "Needs operator_no, or district_no, or a full lease triple (oil_gas_code + district_no + lease_no)."
      );
    }

    const rowCap = cap(args.limit, 50, 200);
    const positions = await leasePositions(
      args.operator_no
        ? { operatorNo: args.operator_no.trim() }
        : { districtNo: args.district_no!.trim() },
      "csgd",
      months,
      rowCap,
      edge
    );
    const producing = positions.filter((p) => p.produced > 0);
    const ranked = producing
      .map((p) => ({
        key: p.key,
        lease_name: p.lease_name,
        field_name: p.field_name,
        filed_months: p.months,
        csgd_produced: p.produced,
        csgd_disposed: p.disposed,
        undisposed: p.produced - p.disposed,
        undisposed_share: (p.produced - p.disposed) / p.produced,
      }))
      .filter((r) => r.undisposed > 0)
      .sort((a, b) => b.undisposed - a.undisposed);

    return {
      ok: true as const,
      scope: args.operator_no ? "operator" : "district",
      operator_no: args.operator_no?.trim() ?? null,
      district_no: args.district_no?.trim() ?? null,
      window_months: months,
      reported_through: edge,
      leases: positions.length,
      leases_producing_casinghead: producing.length,
      leases_with_undisposed_casinghead: ranked.length,
      total_undisposed: sum(ranked.map((r) => r.undisposed)),
      leases_detail: ranked,
      truncated: positions.length >= rowCap,
      notes: [
        "Casinghead produced minus casinghead disposed. A positive gap is gas the lease reported making and did not report moving.",
        "The P-4 check is per lease only, because it is one lookup per lease. Re-run with a lease triple on anything here that matters.",
        NO_CODE_LABELS,
        NOT_FILED,
        LAG(edge),
      ],
    };
  }
);

// ------------------------------------------------------------------ 88

/**
 * VERIFIED ABSENT, and this tool refuses rather than approximates.
 *
 * `rrc.field` in the mirror is three columns: `field_no`, `field_name`,
 * `district_no` (rrc-data `sql/001_schema.sql`), which is everything
 * `resolveField` and `getFieldProfile` can select and everything they do
 * select. No table in the mirror carries a field's spacing rule, density rule,
 * proration unit size or special field rules docket: those live in the RRC's
 * field-rules orders, which this mirror does not load.
 *
 * The nearest thing in the file is `rrc.pending_field`, which carries
 * `total_acres`, `well_count`, `nearest_well_distance`,
 * `nearest_lease_distance` and `entity_density_docket_no` PER PERMIT
 * APPLICATION. Those are what one applicant asserted about one proposed well,
 * not the rule the field is governed by. Computing "how many more wells fit"
 * from them would produce a confident number derived from a stranger's permit
 * paperwork, which is worse than no number: the answer is a legal one and a
 * wrong legal answer gets a well denied or a lease overdrilled.
 */
const infillCapacity = defineTool(
  "rrc_infill_capacity",
  "REFUSES: the mirror carries no field spacing or density rules, so legal infill well count cannot be computed from it.",
  {
    field_no: z.string().optional(),
    oil_gas_code: z.enum(["O", "G"]).optional(),
    district_no: z.string().optional(),
    lease_no: z.string().optional(),
  },
  async () => ({
    ok: false as const,
    error:
      "Cannot be computed. Legal infill capacity needs the field's spacing and density rules, and this mirror carries none of them.",
    missing: [
      "rrc.field has exactly three columns: field_no, field_name, district_no. No spacing, density, acreage or field-rule column exists on it.",
      "No mirror table carries SWR 37 spacing (between-well and lease-line distances) or SWR 38 density (acres per proration unit) as adopted for a field.",
      "No mirror table carries a field's special field rules order or its proration unit size.",
      "No mirror table carries lease acreage. rrc.completion.total_acres and rrc.pending_field.total_acres are per FILING, asserted by the applicant for one well, not the lease's surveyed acreage.",
    ],
    would_need:
      "The RRC field rules orders (statewide rules 37 and 38 plus any special field rules docket), loaded per field_no, plus lease acreage. Neither is in this mirror.",
    available_instead: [
      "rrc.pending_field carries per-application total_acres, well_count, nearest_well_distance, nearest_lease_distance and entity_density_docket_no. That is what one operator asserted on one permit, not the rule, and it is not used here.",
      "rrc_wells / rrc_offsets can count wells already on a lease and their spacing on the ground, which is an observation, not a legal capacity.",
    ],
    notes: [
      "This refusal is the correct answer, not a gap to fill in later with an estimate. Infill capacity is a legal determination; a plausible-looking number computed from the wrong inputs would be acted on.",
    ],
  })
);

// ------------------------------------------------------------------ 89

const severanceWatch = defineTool(
  "rrc_severance_watch",
  "Leases flagged severed or off schedule, meaning they cannot legally sell product, with the production that is now stranded.",
  {
    operator_no: z.string().optional(),
    district_no: z.string().optional(),
    include_off_schedule: z.boolean().optional(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    if (!args.operator_no && !args.district_no) {
      return fail("Needs operator_no or district_no: 548,047 regulatory leases is not a scan.");
    }
    const months = windowMonths(args.months, 12);
    const rowCap = cap(args.limit, 100, 500);
    const includeOff = Boolean(args.include_off_schedule);
    const { reported: edge } = await getCycleEdge();

    const who = args.operator_no ? "operator_no" : "district_no";
    const key = (args.operator_no ?? args.district_no!).trim();
    // Severance is 40,805 of 548,047 leases, off-schedule 310,473 of them. The
    // majority flag is opt-in on purpose: defaulting it on would bury the rare
    // signal the tool exists for under the common one.
    const flagFilter = includeOff
      ? `(rl.lease_severance_flag = 'Y' or rl.lease_off_sched_flag = 'Y')`
      : `rl.lease_severance_flag = 'Y'`;

    const leases = await rrcQuery<{
      oil_gas_code: string;
      district_no: string;
      lease_no: string;
      lease_name: string | null;
      field_name: string | null;
      operator_no: string | null;
      operator_name: string | null;
      severance: boolean;
      off_schedule: boolean;
    }>(
      `select distinct on (rl.oil_gas_code, rl.district_no, rl.lease_no)
              rl.oil_gas_code, rl.district_no, rl.lease_no, rl.lease_name,
              rl.field_name, rl.operator_no, rl.operator_name,
              (rl.lease_severance_flag  = 'Y') as severance,
              (rl.lease_off_sched_flag  = 'Y') as off_schedule
         from rrc.regulatory_lease rl
        where rl.${who} = $1
          and ${flagFilter}
        order by rl.oil_gas_code, rl.district_no, rl.lease_no
        limit $2`,
      [key, rowCap]
    );
    if (!leases.length) {
      return {
        ok: true as const,
        scope: args.operator_no ? "operator" : "district",
        filter: key,
        include_off_schedule: includeOff,
        reported_through: edge,
        leases: 0,
        leases_detail: [],
        truncated: false,
        notes: [
          includeOff
            ? "No severed or off-schedule lease on file for this filter."
            : "No severed lease on file for this filter. Pass include_off_schedule to widen it.",
        ],
      };
    }

    // Same filter, same cycle bound, plus the lease numbers just found. The
    // lease-number array is what keeps a whole-district run bounded: without
    // it, `district_no = $1` over twelve months returns every lease in the
    // district when at most `rowCap` of them are wanted. It can overmatch
    // across the two oil_gas_codes, which the full-key join below discards.
    const prod = await rrcQuery<{
      oil_gas_code: string;
      district_no: string;
      lease_no: string;
      oil: number;
      gas: number;
      oil_ending_bal: number | null;
      last_cycle: string;
    }>(
      `select lp.oil_gas_code, lp.district_no, lp.lease_no,
              coalesce(sum(lp.oil_prod_vol), 0)::bigint as oil,
              coalesce(sum(lp.gas_prod_vol), 0)::bigint as gas,
              (array_agg(lp.oil_ending_bal order by lp.cycle desc)
                 filter (where lp.oil_ending_bal is not null))[1] as oil_ending_bal,
              to_char(max(lp.cycle), 'YYYY-MM') as last_cycle
         from rrc.lease_production lp
        where lp.${who} = $1
          and lp.lease_no = any($3)
          and lp.cycle >  (to_date($2, 'YYYY-MM') - interval '${months} months')
          and lp.cycle <=  to_date($2, 'YYYY-MM')
          and coalesce(lp.prod_report_filed, 'Y') <> 'N'
        group by 1, 2, 3`,
      [key, edge, leases.map((l) => l.lease_no)]
    );
    const byKey = new Map(
      prod.map((p) => [`${p.oil_gas_code}/${p.district_no}/${p.lease_no}`, p])
    );

    const rows = leases
      .map((l) => {
        const k = `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`;
        const p = byKey.get(k);
        return {
          key: k,
          lease_name: l.lease_name,
          field_name: l.field_name,
          operator_no: l.operator_no,
          operator_name: l.operator_name,
          severance: l.severance,
          off_schedule: l.off_schedule,
          oil_last_window: p?.oil ?? null,
          gas_last_window: p?.gas ?? null,
          // Barrels sitting in the tank on a lease that cannot legally sell
          // them. The closest thing the public record has to a forced seller.
          oil_ending_balance: p?.oil_ending_bal ?? null,
          last_filed_cycle: p?.last_cycle ?? null,
        };
      })
      .sort((a, b) => (b.oil_last_window ?? 0) - (a.oil_last_window ?? 0));

    const severed = rows.filter((r) => r.severance);
    return {
      ok: true as const,
      scope: args.operator_no ? "operator" : "district",
      filter: key,
      include_off_schedule: includeOff,
      window_months: months,
      reported_through: edge,
      leases: rows.length,
      severed: severed.length,
      off_schedule_only: rows.filter((r) => !r.severance && r.off_schedule).length,
      severed_oil_last_window: sum(severed.map((r) => r.oil_last_window)),
      severed_oil_in_tank: sum(severed.map((r) => r.oil_ending_balance)),
      leases_detail: rows,
      truncated: leases.length >= rowCap,
      notes: [
        "A severance means the RRC has cut the lease off: product cannot legally be sold until the underlying problem is cleared. It is rare, 40,805 of 548,047 leases, and it is the loud flag.",
        "Off schedule is the quiet one, 310,473 of 548,047, and mostly means the lease is simply not on the current proration schedule. It is not evidence of distress on its own.",
        "The flags are the CURRENT state of the regulatory lease record. They carry no date, so this cannot say when the severance landed or how long it has run.",
        "Production shown is the trailing window through the reporting edge, so a lease severed last month still shows a year of it.",
        LAG(edge),
      ],
    };
  }
);

// ------------------------------------------------------------------ 90

/** Bucket a date string to its cycle. Permits carry YYYY-MM-DD. */
function toCycle(date: string | null): string | null {
  return date && date.length >= 7 ? date.slice(0, 7) : null;
}

function countBy<T>(rows: T[], pick: (r: T) => string | null): { key: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = pick(r);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

const counterIntel = defineTool(
  "rrc_counter_intel",
  "What one operator's own permit filings telegraph: cadence, where they are moving, how deep they are going, and what is still pending. Point it at your own operator number to see what you broadcast.",
  {
    operator_no: z.string(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async ({ operator_no, months, limit }) => {
    const key = operator_no.trim();
    if (!key) return fail("operator_no is required.");
    const window = windowMonths(months, 24, 120);
    const rowCap = cap(limit, 200, 500);

    const [permits, pendingAll] = await Promise.all([
      listPermits({ operatorNo: key, limit: rowCap }),
      getPendingQueue(),
    ]);
    if (!permits.length) {
      return {
        ok: true as const,
        operator_no: key,
        window_months: window,
        permits_in_window: 0,
        pending: [],
        notes: ["No approved drilling permit on file for this operator number."],
      };
    }

    // The window is anchored to the newest permit rather than to today, so an
    // operator who stopped filing two years ago is described as "stopped", not
    // as an empty result.
    const issued = permits
      .map((p) => ({ p, cycle: toCycle(p.issued_date) }))
      .filter((r): r is { p: PermitRow; cycle: string } => r.cycle !== null)
      .sort((a, b) => (a.cycle < b.cycle ? -1 : 1));
    const newest = issued[issued.length - 1]?.cycle ?? null;
    const cutoff = (back: number) => {
      if (!newest) return "";
      const [y, m] = newest.split("-").map(Number);
      const t = y * 12 + (m - 1) - back;
      return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
    };

    const inWindow = issued.filter((r) => r.cycle > cutoff(window)).map((r) => r.p);
    const recent = issued.filter((r) => r.cycle > cutoff(12)).map((r) => r.p);
    const prior = issued
      .filter((r) => r.cycle > cutoff(24) && r.cycle <= cutoff(12))
      .map((r) => r.p);

    const counties = countBy(inWindow, (p) => p.county_name);
    const recentCounties = countBy(recent, (p) => p.county_name);
    const priorCounties = countBy(prior, (p) => p.county_name);
    const newAreas = recentCounties
      .filter((c) => !priorCounties.some((o) => o.key === c.key))
      .map((c) => c.key);

    const depth = (rows: PermitRow[]) =>
      median(rows.map((p) => p.total_depth).filter((d): d is number => d != null));

    const pending = pendingAll
      .filter((p) => p.operator_number === key)
      .map((p) => ({
        universal_doc_no: p.universal_doc_no,
        lease_name: p.lease_name,
        well_number: p.well_number,
        county_name: p.county_name,
        district_name: p.district_name,
        total_depth: p.total_depth,
        horizontal: p.horizontal,
        filing_purpose: p.filing_purpose,
        submit_date: p.submit_date,
        days_pending: p.days_pending,
      }));

    return {
      ok: true as const,
      operator_no: key,
      operator_name: permits[0].operator_name,
      window_months: window,
      newest_permit_cycle: newest,
      permits_returned: permits.length,
      permits_in_window: inWindow.length,
      last_12: recent.length,
      prior_12: prior.length,
      cadence:
        prior.length === 0
          ? recent.length > 0
            ? "started"
            : "quiet"
          : recent.length > prior.length
            ? "accelerating"
            : recent.length < prior.length
              ? "slowing"
              : "flat",
      by_month: countBy(
        issued.filter((r) => r.cycle > cutoff(window)),
        (r) => r.cycle
      ),
      by_county: counties,
      by_district: countBy(inWindow, (p) => p.district_name),
      // Concentration of the permit book. A low HHI on a busy operator is a
      // land grab across several plays; a high one is a single-target program.
      county_hhi: hhi(counties.map((c) => c.n)),
      new_counties_last_12: newAreas,
      median_depth_last_12: depth(recent),
      median_depth_prior_12: depth(prior),
      // Newest lease names are the actual telegraph: a permit names the lease
      // before anything is drilled or produced on it.
      newest_permits: issued
        .slice(-25)
        .reverse()
        .map((r) => ({
          permit_number: r.p.permit_number,
          lease_name: r.p.lease_name,
          well_number: r.p.well_number,
          county_name: r.p.county_name,
          district_name: r.p.district_name,
          total_depth: r.p.total_depth,
          issued_date: r.p.issued_date,
          filed_date: r.p.filed_date,
        })),
      pending_count: pending.length,
      pending,
      truncated: permits.length >= rowCap,
      notes: [
        "Approved drilling permits and the pending queue only. A permit is an intention with a two-year clock on it, not a well: many are never drilled.",
        "P-4 filings and completion reports are keyed per lease and per API in this mirror, so they cannot be swept for an operator inside the query budget. Read them per lease or per well.",
        "Everything here is public the day it is filed. Run it on your own operator number to see the same picture a competitor already has.",
        "Depth medians compare the last 12 filed months against the 12 before them, anchored to the newest permit. A jump usually means a new target zone, but the permit does not name the zone.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 91

const orderOfBattle = defineTool(
  "rrc_order_of_battle",
  "One operator's whole position in a single call: wells, leases, production, allowable headroom, disposal capacity, filings, liabilities and the people behind the P-5.",
  {
    operator_no: z.string(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async ({ operator_no, months, limit }) => {
    const key = operator_no.trim();
    if (!key) return fail("operator_no is required.");
    const window = windowMonths(months, 12);
    const rowCap = cap(limit, 25, 100);
    const { reported: edge } = await getCycleEdge();

    const [dossier, network] = await Promise.all([
      getOperatorDossier(key),
      getOperatorNetwork(key),
    ]);
    if (!dossier) return fail(`No operator ${key}.`);

    // The same read tool 74 uses, deliberately: two answers to "how much room
    // does this operator have" that disagree is the bug, not the feature.
    const oilPositions = await leasePositions({ operatorNo: key }, "oil", window, 200, edge);
    const withCeiling = oilPositions.filter((p) => p.allowable !== null);
    const allowable = sum(withCeiling.map((p) => p.allowable));
    const producedWhenAllowed = sum(withCeiling.map((p) => p.produced_when_allowed));

    const reported = dossier.monthly.filter((m) => m.reported && m.cycle <= edge);
    const win = reported.slice(-window);

    return {
      ok: true as const,
      operator_no: key,
      operator_name: dossier.record.operator_name,
      reported_through: edge,
      window_months: window,
      identity: {
        p5_status: dossier.record.p5_status,
        org_date: dossier.record.org_date,
        last_p5_date: dossier.record.last_p5_date,
        city: dossier.record.city1,
        state: dossier.record.state1,
        phone: dossier.record.phone1,
      },
      assets: {
        wells_total: dossier.wells.total,
        by_type: dossier.wells.byType,
        plugged: dossier.wells.plugged,
        leases: dossier.leases.length,
        fields: dossier.fields.length,
        top_leases: dossier.leases.slice(0, rowCap).map((l) => ({
          key: `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`,
          lease_name: l.lease_name,
          field_name: l.field_name,
          oil_last12: l.oil_last12,
          gas_last12: l.gas_last12,
          off_schedule: l.off_schedule,
          severance: l.severance,
        })),
        top_fields: dossier.fields.slice(0, rowCap),
      },
      capacity: {
        oil_window: sum(win.map((m) => m.oil_prod_vol)),
        gas_window: sum(win.map((m) => m.gas_prod_vol)),
        cond_window: sum(win.map((m) => m.cond_prod_vol)),
        csgd_window: sum(win.map((m) => m.csgd_prod_vol)),
        months_counted: win.length,
      },
      allowable_headroom: {
        stream: "oil",
        unit: COLS.oil.unit,
        leases_measured: oilPositions.length,
        leases_with_ceiling: withCeiling.length,
        total_allowable: withCeiling.length ? allowable : null,
        total_produced_when_allowed: producedWhenAllowed,
        headroom: withCeiling.length ? allowable - producedWhenAllowed : null,
        utilisation: allowable > 0 ? producedWhenAllowed / allowable : null,
        top_headroom: withCeiling
          .map((p) => ({
            key: p.key,
            lease_name: p.lease_name,
            headroom: p.allowable! - p.produced_when_allowed,
            utilisation: positionUtilisation(p),
          }))
          .sort((a, b) => b.headroom - a.headroom)
          .slice(0, rowCap),
      },
      water: {
        disposal_wells: dossier.disposal.wells,
        commercial_wells: dossier.disposal.commercialWells,
        permitted_bbl_per_day: dossier.disposal.permittedBblPerDay,
        injected_bbl_12m: dossier.disposal.injectedBbl12m,
        last_reported: dossier.disposal.lastReported,
        reported_through: dossier.disposal.reportedThrough,
      },
      obligations: {
        h15_wells_tested: dossier.h15.wellsTested,
        h15_delinquent: dossier.h15.delinquent,
        h15_due_soon: dossier.h15.dueSoon,
        h15_last_test: dossier.h15.lastTest,
        approved_permits: dossier.permitTotal,
        newest_permits: dossier.permits.slice(0, 10).map((p) => ({
          permit_number: p.permit_number,
          lease_name: p.lease_name,
          county_name: p.county_name,
          issued_date: p.issued_date,
          expires_date: p.expires_date,
        })),
      },
      liabilities: {
        flagged_14b2: dossier.wells.flagged14b2,
        reasons: dossier.wells.reasons,
        surface_violations: dossier.wells.surfaceViolations,
        w3x_violations: dossier.wells.w3xViolations,
        severed_leases: dossier.leases.filter((l) => l.severance).length,
        off_schedule_leases: dossier.leases.filter((l) => l.off_schedule).length,
      },
      people: {
        officers: dossier.officers.map((o) => ({
          officer_name: o.officer_name,
          officer_title: o.officer_title,
          city: o.city,
          state: o.state,
        })),
        // Operators sharing an officer with this one. Common control is a
        // hypothesis from a shared name, not a corporate fact.
        related_operators: network?.related ?? [],
      },
      truncated:
        dossier.leases.length > rowCap ||
        dossier.fields.length > rowCap ||
        dossier.permitTotal > dossier.permits.length,
      notes: [
        "Composed entirely from the operator dossier, the disposal fleet, the officer network and the same allowable read tool 74 uses. No number here has a second derivation that could disagree with it.",
        "Lease and field lists are the operator's CURRENT footprint, the last 12 months of production, not everything they have ever held.",
        "Related operators come from a shared officer NAME. Two people with the same name are one row here; treat it as a lead, not a finding.",
        CEILING_NOT_TARGET,
        NULL_ALLOWABLE,
        LAG(edge),
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  allowableHeadroom,
  chokeDetect,
  inventorySignal,
  flareMap,
  gasOrphan,
  infillCapacity,
  severanceWatch,
  counterIntel,
  orderOfBattle,
];
