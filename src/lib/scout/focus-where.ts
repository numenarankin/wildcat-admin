/**
 * The focus layer's WHERE clause, built as data rather than typed into the
 * query — so the one piece of Scout that decides which wells exist can be
 * asserted on without a database.
 *
 * TWO RULES IT KEEPS, each of which has a failure mode behind it:
 *
 *   1. `null` IS NOT `[]`. A null list is "no filter"; an EMPTY list is a
 *      resolution that found nobody, and the honest answer to that is no wells.
 *      This is the rule `operatorNumbers` has always followed (a person search
 *      that matched no operator must not silently draw the whole state), and
 *      every list here follows it.
 *   2. ONE VALUE KEEPS THE SCALAR SPELLING. A single-element list emits
 *      `col = $1`, not `col = any($1)`, so a one-value select is byte-identical
 *      to the query Scout shipped before multi-select, and the planner sees a
 *      plain equality rather than an array scan.
 *
 * The SQL fragments below are shared with `queries.ts` (which is `"use server"`
 * and so may only export async functions — these constants cannot live there and
 * be imported by anything). `wb` is the alias of the `rrc.wellbore` row under
 * test in every one of them.
 */

import { shapePredicate } from "@/lib/scout/geo-shapes";
import { districtLabel } from "@/lib/scout/rrc-districts";
import { stoppedTypesSql, type WellActivity } from "@/lib/scout/well-activity";
import type { FocusOpts } from "@/lib/scout/types";

/** Operator number as the mirror keys it: zero-padded to six characters. */
export function op6(operatorNumber: number): string {
  return String(operatorNumber).replace(/\D/g, "").padStart(6, "0");
}

/**
 * The API-number range covering one RRC county.
 *
 * The county code IS the API number's leading three digits, so a county is a
 * contiguous range over `api_number` — which is indexed (`wellbore_api_idx`),
 * while `county_code` is not. This is the difference between an index scan and
 * a 1.37M-row sequential scan on every county filter.
 */
export function countyApiRange(countyCode: number): [string, string] {
  const c = String(countyCode).replace(/\D/g, "").padStart(3, "0");
  return [`${c}00000`, `${c}99999`];
}

/**
 * THE PER-WELL PRODUCTION RATE, joined in ONLY when a band is set.
 *
 * `wildcat.well_rate` is the mirror-side table `scripts/scout-sync-well-rates.ts`
 * maintains: one row per well, oil in bbl and gas in MCF PER MONTH, averaged
 * over the last 12 filed months. It is the same figure the map's hover label
 * and the well modal's Production tab compute, so a band's edge and the number
 * the user reads on a dot are one number (see `FocusOpts.minOilRate`).
 *
 * LEFT, not inner, and absent unless asked for. Three things had to be true:
 *
 *   - A well with NO ROW has no rate on file, and unfiled is not zero. It must
 *     FAIL `oil >= 500` rather than pass it. A left join gives that for free:
 *     the missing row makes `wr.oil_bbl_mo` null, and a null fails every
 *     comparison — the same reason an unknown `api_depth` drops out of a depth
 *     band rather than sneaking through it.
 *   - Nothing may be dropped when no band is set, which is what rules an INNER
 *     join out: a rate row exists only for a well the RRC has production for,
 *     which is a minority of the 1.37M holes in the mirror (80,607 of them the
 *     day this was written, with the statewide backfill still running), so an
 *     inner join would quietly delete most of an unbanded map.
 *   - No band, no join. The predicate is what does the excluding, so with no
 *     band the join could only cost the planner work for a column nobody reads;
 *     the builder emits it only when one of the four bounds is set, and the
 *     query is then byte-identical to the one Scout ran before this existed.
 */
export const WELL_RATE_JOIN =
  "left join wildcat.well_rate wr on wr.api_number = wb.api_number";

/**
 * ONE WELL, ONE OPERATOR — the rule every attribution in Scout follows.
 *
 * 337 wells carry more than one operator even among their on-schedule rows, so
 * "wells operated by X" has to say what happens to those. Without a rule, the
 * operator modal counted every claim (19,367 for Hilcorp) while the operator
 * points counted each well once (19,353), and the dot disagreed with the
 * dossier it opened. The tiebreak is the lowest operator number, matching
 * `scripts/scout-sync-data.mjs`, and this predicate is how it is spelled: the
 * row wins only if no lower-numbered operator claims the same well.
 */
export const OWNS_WELL = `
  not exists (
    select 1 from rrc.wellbore w2
     where w2.api_number = wb.api_number
       and w2.on_schedule = 'Y'
       and w2.operator_number is not null
       and w2.operator_number < wb.operator_number
  )`;

/**
 * ACTIVE / INACTIVE / PLUGGED as a SQL predicate on a well, not on a row.
 *
 * The grain is well x lease x field, so neither half can be read off one row: a
 * per-row `plug_date is null` passed 25,865 plugged wells through an "Active"
 * filter, and a per-row "any plug date anywhere" calls a re-entered producer
 * plugged. Each of the four steps in `@/lib/scout/well-activity` is one EXISTS
 * below, applied in that order.
 *
 * The rule is spelled a third time, in SQL, in `scripts/scout-sync-data.mjs` so
 * the tiles can be filtered without a round trip. Keep the three in step; the
 * stopped-type list is imported here rather than retyped.
 */
const LIVE_ROW = `
  exists (
    select 1 from rrc.wellbore wk
     where wk.api_number = wb.api_number
       and wk.on_schedule = 'Y'
       and nullif(btrim(wk.plug_date), '') is null
       and coalesce(nullif(btrim(wk.well_type_name), ''), '') <> ''
       and upper(btrim(wk.well_type_name)) not in (${stoppedTypesSql()})
       and coalesce(nullif(btrim(wk.curr_inact_yrs), '')::int, 0) = 0
  )`;

/** The CURRENT record says plugged. */
const SCHEDULED_PLUG = `
  exists (
    select 1 from rrc.wellbore ws
     where ws.api_number = wb.api_number
       and ws.on_schedule = 'Y'
       and nullif(btrim(ws.plug_date), '') is not null
  )`;

/** There is a current record at all — an on-schedule row carrying a type. */
const ON_SCHEDULE_ROW = `
  exists (
    select 1 from rrc.wellbore wo
     where wo.api_number = wb.api_number
       and wo.on_schedule = 'Y'
       and coalesce(nullif(btrim(wo.well_type_name), ''), '') <> ''
  )`;

/** A plug date on any row, current or historic. */
const ANY_PLUG = `
  exists (
    select 1 from rrc.wellbore wp
     where wp.api_number = wb.api_number
       and nullif(btrim(wp.plug_date), '') is not null
  )`;

/** Plugged: the current record says so, or nothing current exists and a row does. */
const PLUGGED = `(
  ${SCHEDULED_PLUG}
  or (not ${ON_SCHEDULE_ROW} and ${ANY_PLUG})
)`;

export function statusPredicate(status: WellActivity): string {
  // Live beats both, so every branch tests it first — that is the precedence.
  if (status === "active") return LIVE_ROW;
  if (status === "plugged") return `not ${LIVE_ROW} and ${PLUGGED}`;
  return `not ${LIVE_ROW} and not ${PLUGGED}`;
}

/**
 * A filter-bar field read as a list: `"all"` and `null` mean NO FILTER, a bare
 * value means that one, and a list means itself.
 *
 * The bar keeps the scalar spellings because they are what a single control
 * writes and what Orion has always sent (`normalizeScoutView` answers "Andrews"
 * with `3`, and the tool's own tests pin that). This is the one place the three
 * shapes collapse into the single shape every consumer wants.
 */
export function chosen<T extends string | number>(
  v: "all" | T | T[] | null | undefined
): T[] | null {
  if (v == null || v === "all") return null;
  return Array.isArray(v) ? v : [v];
}

/** What the builder produced, or why there is nothing to run. */
export type FocusWhere =
  | {
      kind: "sql";
      /** The whole WHERE body, ready to interpolate. */
      where: string;
      params: unknown[];
      /**
       * Extra FROM-list joins the WHERE needs, or `""` when it needs none.
       * Only the production band puts anything here; see `WELL_RATE_JOIN`.
       */
      joins: string;
    }
  /**
   * Nothing to draw. `unfiltered` is "no question was asked" (the map is on the
   * tile layer anyway); `nobody` is "the question resolved to no rows", which is
   * a real answer and must not be widened into the whole state.
   */
  | { kind: "none"; why: "unfiltered" | "nobody" };

/** Any list that resolved to nobody: the honest answer is no wells. See rule 1. */
function resolvedToNobody(opts: FocusOpts): boolean {
  return (
    opts.countyCodes?.length === 0 ||
    opts.districts?.length === 0 ||
    opts.wellTypes?.length === 0 ||
    opts.statuses?.length === 0
  );
}

export function buildFocusWhere(opts: FocusOpts): FocusWhere {
  // A list that resolved to nobody answers the whole query, not one predicate:
  // "wells in none of these counties" is no wells, and letting the rest of the
  // filter set stand would widen it into somebody else's answer. Rule 1.
  if (resolvedToNobody(opts)) return { kind: "none", why: "nobody" };

  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  /** `col = $1` for one, `col = any($1)` for several. See rule 2 up top. */
  const eqAny = (col: string, values: (string | number)[]) =>
    values.length === 1
      ? `${col} = ${bind(values[0])}`
      : `${col} = any(${bind(values)})`;

  const where: string[] = [];
  /** Filled in by the production band alone, and only when one is set. */
  let joins = "";

  // THE SUBJECT FIRST. An operator or person is who the search is about, and it
  // binds $1 so the rest of the clause reads in the order the bar does.
  if (opts.operatorNumbers !== null) {
    // Empty is not "no filter": the search resolved to nobody, so no wells.
    if (opts.operatorNumbers.length === 0) return { kind: "none", why: "nobody" };
    where.push(`wb.operator_number = any(${bind(opts.operatorNumbers.map(op6))})`);
    // ON-SCHEDULE ONLY, and only here. An operator's dot is labelled with the
    // wells it runs today (19,353 for Hilcorp, not the 25,673 it has ever been
    // named on), so focusing that operator has to draw that same set or the
    // popup and the map contradict each other. County and category searches
    // stay unrestricted, because those ask "what is here", which is the whole
    // tile layer's question and includes long-dead wells.
    where.push(`wb.on_schedule = 'Y'`);
    where.push(OWNS_WELL);
  }

  /*
   * A MINERAL OWNER is a subject too: the wells on every lease they hold an
   * interest in, per the county roll (`cad.mineral_interest`).
   *
   * Joined on the REAL district label (`mi.district`), which is what `wb`
   * carries; the roll stores PDQ's code beside it for the lease modal. Bound to
   * the roll's county by API range, because a lease number is only unique
   * within a district and the roll only speaks for its own county. On-schedule
   * only, as for an operator: the roll taxes the lease as it stands today.
   */
  if (opts.owner !== null) {
    const [lo, hi] = countyApiRange(Number(opts.owner.countyNo));
    where.push(
      `exists (select 1 from cad.mineral_interest mi` +
        ` where mi.county_no = ${bind(opts.owner.countyNo)}` +
        ` and mi.tax_year = ${bind(opts.owner.taxYear)}` +
        ` and mi.owner_id = ${bind(opts.owner.ownerId)}` +
        ` and mi.oil_gas_code = wb.oil_gas_code` +
        ` and mi.district = wb.district` +
        ` and mi.lease_no = wb.lease_number)`
    );
    where.push(`wb.api_number between ${bind(lo)} and ${bind(hi)}`);
    where.push(`wb.on_schedule = 'Y'`);
  }

  /*
   * THE DRAWN AREA.
   *
   * A box around a field is not one of the things being asked, it is where the
   * asking happens: "producing wells below 12,000 feet — in HERE". Several
   * shapes are a union inside this one term (`shapePredicate`), so two
   * overlapping boxes still narrow once. Empty is null, meaning no spatial
   * constraint at all -- see `FocusOpts.shapes` for why that is not the
   * empty-list rule the other fields follow.
   */
  const area = shapePredicate(opts.shapes, bind);
  if (area) where.push(area);

  if (opts.countyCodes !== null) {
    // A county is an API-number RANGE, so several counties are several ranges
    // ORed — not an `any()`, which would have to give up the index.
    const ranges = opts.countyCodes.map((code) => {
      const [lo, hi] = countyApiRange(code);
      return `wb.api_number between ${bind(lo)} and ${bind(hi)}`;
    });
    where.push(ranges.length === 1 ? ranges[0] : `(${ranges.join(" or ")})`);
  }
  if (opts.oilGas) where.push(`wb.oil_gas_code = ${bind(opts.oilGas)}`);
  if (opts.statuses !== null) {
    // Each bucket is its own multi-EXISTS predicate (they are not values in a
    // column), so several buckets are an OR of predicates rather than a list.
    const preds = opts.statuses.map(statusPredicate);
    where.push(
      preds.length === 1 ? preds[0] : `(${preds.map((p) => `(${p})`).join(" or ")})`
    );
  } else if (opts.excludePlugged) {
    // The coarser cut, and only when the bar did not name buckets itself:
    // asking for plugged wells while the setting is on means the buckets win.
    where.push(`not (${statusPredicate("plugged")})`);
  }
  if (opts.districts !== null) {
    // The map filters on PDQ's internal code; the mirror stores the real label.
    const labels = opts.districts.map((d) =>
      districtLabel(String(d).padStart(2, "0"))
    );
    where.push(eqAny(`btrim(wb.district)`, labels as string[]));
  }
  if (opts.wellTypes !== null) {
    // Only on-schedule rows carry a type, so this is implicitly the well's
    // CURRENT one — see `FocusOpts.wellTypes`. Stated explicitly rather than
    // left to that coincidence, because a historic row that ever gains a type
    // would otherwise silently widen the answer.
    where.push(eqAny(`btrim(wb.well_type_name)`, opts.wellTypes));
    where.push(`wb.on_schedule = 'Y'`);
  }
  /*
   * DEPTH AND COMPLETION YEAR.
   *
   * Both columns are `text` on `rrc.wellbore` and neither is indexed, so these
   * are the only predicates here that cannot push down — bounded alone they
   * scan the 1.37M-row table (~2 s, inside the pool's 5 s budget, measured).
   * Anything that narrows by county or operator first hits an index and brings
   * that to ~100 ms, which is the usual way these get used: a band plus a place.
   *
   * `nullif(btrim(...), '')` before the cast is what makes the empty strings
   * (the mirror's null) drop out rather than raise, and it is also why an
   * unknown depth or an unfiled completion date fails a bounded test instead of
   * passing it.
   */
  const depth = `nullif(btrim(wb.api_depth), '')::bigint`;
  if (opts.minDepth !== null) where.push(`${depth} >= ${bind(opts.minDepth)}`);
  if (opts.maxDepth !== null) where.push(`${depth} <= ${bind(opts.maxDepth)}`);
  // `completion_date` is YYYYMMDD, so a year is the range [Y0000, Y1231] — the
  // comparison stays integer and never parses a date.
  const completed = `nullif(btrim(wb.completion_date), '')::bigint`;
  if (opts.minCompletionYear !== null) {
    where.push(`${completed} >= ${bind(opts.minCompletionYear * 10000)}`);
  }
  if (opts.maxCompletionYear !== null) {
    where.push(`${completed} <= ${bind(opts.maxCompletionYear * 10000 + 1231)}`);
  }

  /*
   * PRODUCTION PER MONTH, off the precomputed rate rather than the allocation.
   *
   * `allocatedByTestBatch` rebuilds a lease's share table from its well tests,
   * which is a per-well read and cannot run over a statewide candidate set on
   * every filter change. `wildcat.well_rate` is that same computation, done
   * once in the mirror, so this is a plain comparison on two columns.
   *
   * The join is added only here, and only once however many of the four bounds
   * are set — see `WELL_RATE_JOIN` for why it is LEFT and why it is absent
   * otherwise.
   */
  const rateBand = (col: string, op: ">=" | "<=", value: number | null) => {
    if (value === null) return;
    joins = WELL_RATE_JOIN;
    where.push(`wr.${col} ${op} ${bind(value)}`);
  };
  rateBand("oil_bbl_mo", ">=", opts.minOilRate);
  rateBand("oil_bbl_mo", "<=", opts.maxOilRate);
  rateBand("gas_mcf_mo", ">=", opts.minGasRate);
  rateBand("gas_mcf_mo", "<=", opts.maxGasRate);

  // Nothing was asked at all. Not an empty WHERE, which is the whole state.
  if (where.length === 0) return { kind: "none", why: "unfiltered" };

  return { kind: "sql", where: where.join(" and "), params, joins };
}
