/**
 * The POPULATION behind a range filter.
 *
 * The map's depth, completion-year and inactivity filters are typed Min/Max
 * boxes, and nothing on screen says how many wells are in the band. A user
 * types 8,000 to 12,000 feet with no idea whether that is a hundred wells or a
 * hundred thousand. These buckets are what the control draws behind the thumbs.
 *
 * ## Three decisions, each of which shows on screen
 *
 * **The buckets are UNFILTERED.** They are the statewide distribution, not a
 * re-count under the current filter set. Recounting per keystroke is a scan of
 * `rrc.wellbore` for every drag frame, and it answers a question the map already
 * answers: how many wells the current filters actually found is reported by the
 * focus layer. What the histogram is for is "is this band a sane place to
 * stand", and the statewide shape answers that.
 *
 * **One row per WELL, not per wellbore row.** `rrc.wellbore` is one row per well
 * x lease x field, so a multi-completion hole appears several times and a raw
 * count would draw 23,569 wells twice. The query reduces to one row per API
 * (preferring the on-schedule row, then the newest completion) BEFORE bucketing,
 * which is what makes the bars sum exactly to the well count stated beside them.
 *
 * That reduction is deliberately NOT the rule the filter uses. `getFocusWells`
 * matches a hole if ANY of its rows falls in the band, so for a hole whose
 * completions disagree the filter can return a well this histogram counted in a
 * different bar. The two answer different questions and only one of them is a
 * count of wells; the difference is bounded by the multi-completion population.
 *
 * **Edges are declared here, once**, and handed to Postgres `width_bucket`
 * verbatim, so the bars the user drags across and the SQL that counted them
 * cannot drift apart.
 *
 * Measured against the live mirror on 2026-08-21: 1.1 s (depth), 1.8 s
 * (completion year), 1.1 s (inactivity), all inside the pool's 5 s budget, so
 * none of these needs the `rrcQuerySlow` exemption. Each field's bar total was
 * checked against an independent `count(distinct api_number)`: 419,618 wells
 * carry a numeric depth, 651,558 a completion date, 419,618 an inactivity
 * clock, and all three sums matched exactly.
 */

export const HISTOGRAM_FIELDS = ["depth", "completionYear", "inactiveYears"] as const;
export type HistogramField = (typeof HISTOGRAM_FIELDS)[number];

export interface HistogramFieldDef {
  /** Sorted lower bounds, passed to `width_bucket(v, $1::numeric[])`. */
  edges: number[];
  /**
   * The value, as SQL, over `rrc.wellbore wb`.
   *
   * Every one of these columns is `text` in the mirror (the wiring plan's
   * choice: the RRC ships fixed-width records), so each carries a guard that
   * makes the cast safe rather than relying on the data being clean. A row that
   * fails the guard is an UNKNOWN, and unknown is not zero: it drops out of the
   * population rather than piling up in the first bar.
   */
  expr: string;
  guard: string;
  /** Rendered for a bar's lower bound. Years stay bare; feet get separators. */
  format: (v: number) => string;
}

const count = (v: number) => v.toLocaleString("en-US");
const bare = (v: number) => String(v);

/*
 * The domains come from `docs/plans/scout-rrc-mirror-ui.md` §2.2 and from the
 * measurement above, not from a guess at what a nice axis looks like. Depth
 * tightens between 2,000 and 12,000 feet because that is where 80% of Texas
 * sits; inactivity spends most of its edges under five years because 302,414 of
 * the 419,618 wells with a clock read zero, and the interesting question is
 * about the tail.
 */
const FIELDS: Record<HistogramField, HistogramFieldDef> = {
  depth: {
    edges: [
      0, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000,
      10000, 12000, 14000, 16000, 20000, 25000,
    ],
    expr: "nullif(btrim(wb.api_depth), '')::bigint",
    guard: "wb.api_depth ~ '^[0-9]+$'",
    format: count,
  },
  completionYear: {
    // Five-year steps from 1930. Everything older is one bar (633 wells), which
    // is the honest shape: the record thins out rather than stopping.
    edges: Array.from({ length: 20 }, (_, i) => 1930 + i * 5),
    // YYYYMMDD, so the year is integer division and no date is ever parsed.
    expr: "(nullif(btrim(wb.completion_date), '')::bigint / 10000)",
    guard: "wb.completion_date ~ '^[0-9]{8}$'",
    format: bare,
  },
  inactiveYears: {
    edges: [0, 1, 2, 3, 4, 5, 7, 10, 15, 20, 25, 30],
    expr: "nullif(btrim(wb.curr_inact_yrs), '')::bigint",
    guard: "wb.curr_inact_yrs ~ '^[0-9]+$'",
    format: bare,
  },
};

export function histogramField(field: HistogramField): HistogramFieldDef {
  return FIELDS[field];
}

export function isHistogramField(v: string): v is HistogramField {
  return (HISTOGRAM_FIELDS as readonly string[]).includes(v);
}

/**
 * The counting query, as SQL. One definition, used by the sync script that
 * writes the buckets and by the check that verifies them, so the numbers on
 * screen and the numbers a test agrees with came from the same statement.
 *
 * ONE ROW PER WELL before bucketing: `rrc.wellbore` is one row per well x lease
 * x field, so a hole completed into two fields would be drawn twice and the bars
 * would stop summing to a well count. On-schedule first, then the newest
 * completion, which is the preference the dossier uses when it has to pick one
 * row and call it current.
 *
 * `$1` is the edge array. Nothing else is parameterised, and nothing in the
 * statement comes from a request: `field` is narrowed to a known key before it
 * reaches here, and the expressions are literals above.
 */
export function histogramSql(field: HistogramField): string {
  const { expr, guard } = FIELDS[field];
  return `with one_row as (
            select distinct on (wb.api_number) ${expr} as v
              from rrc.wellbore wb
             where ${guard}
             order by wb.api_number,
                      wb.on_schedule desc nulls last,
                      wb.completion_date desc nulls last
          )
          select width_bucket(v, $1::numeric[]) as b, count(*)::int as n
            from one_row
           group by 1
           order by 1`;
}

export interface HistogramBucket {
  /** Inclusive lower bound. Null on the underflow bar. */
  from: number | null;
  /** Exclusive upper bound. Null on the overflow bar. */
  to: number | null;
  count: number;
  /** What sits under the bar. */
  label: string;
}

export interface Histogram {
  field: HistogramField;
  buckets: HistogramBucket[];
  /** Wells carrying a value for this field. Equals the sum of the bars. */
  total: number;
}

/**
 * Postgres `width_bucket` rows into the full bar set.
 *
 * `width_bucket(v, edges)` returns 0 below the first edge and `edges.length` at
 * or above the last, so there are always `edges.length + 1` bars. A bucket the
 * query returned no row for is an EMPTY bar, not a missing one: dropping it
 * would close a gap in the axis and make the distribution look continuous where
 * it is not.
 */
export function bucketsFromCounts(
  field: HistogramField,
  rows: { b: number | null; n: number }[]
): Histogram {
  const { edges, format } = FIELDS[field];
  const counts = new Map<number, number>();
  for (const r of rows) {
    // A null bucket means a null value, which the guard should already have
    // excluded. Ignored rather than trusted into a bar.
    if (r.b == null) continue;
    counts.set(r.b, (counts.get(r.b) ?? 0) + r.n);
  }

  const buckets: HistogramBucket[] = [];
  for (let i = 0; i <= edges.length; i++) {
    const from = i === 0 ? null : edges[i - 1];
    const to = i === edges.length ? null : edges[i];
    buckets.push({
      from,
      to,
      count: counts.get(i) ?? 0,
      label:
        from === null
          ? `< ${format(edges[0])}`
          : to === null
            ? `${format(from)}+`
            : format(from),
    });
  }

  return {
    field,
    buckets,
    total: buckets.reduce((sum, b) => sum + b.count, 0),
  };
}

/**
 * Bar heights, as a fraction of the tallest.
 *
 * LOG scaled, because every one of these domains is long-tailed: 302,414 wells
 * sit in the first inactivity bar and 3 sit in the last, and on a linear axis
 * that is one bar and a flat line. The point of drawing the tail is to show that
 * it is there.
 */
export function barHeights(buckets: HistogramBucket[]): number[] {
  const peak = Math.max(...buckets.map((b) => b.count), 0);
  if (peak <= 0) return buckets.map(() => 0);
  const top = Math.log1p(peak);
  return buckets.map((b) => (b.count <= 0 ? 0 : Math.log1p(b.count) / top));
}

/**
 * The bar index a value sits at, for placing a thumb.
 *
 * A thumb SNAPS to the bars it is drawn over: the slider moves in the buckets it
 * shows, and the typed box beside it is how you enter 8,437. A value that came
 * from the box and falls between two edges places the thumb at the nearest one,
 * which is a position, not a claim about the value.
 */
export function nearestEdgeIndex(edges: number[], value: number): number {
  let best = 0;
  for (let i = 1; i < edges.length; i++) {
    if (Math.abs(edges[i] - value) < Math.abs(edges[best] - value)) best = i;
  }
  return best;
}

/**
 * Where a thumb sits on the track, as a fraction from the left.
 *
 * The track is the bars, so a thumb is a bar BOUNDARY rather than a point on a
 * number line: edge `i` opens bar `i + 1`, which starts `(i + 1) / bars` of the
 * way across. Getting this off by one puts the thumb on the wrong side of the
 * bar it is selecting, which looks like a rounding wobble and is not one.
 *
 * An unbounded end sits hard against the end of the track, which is what "no
 * floor" and "no ceiling" look like.
 */
export function thumbPosition(
  field: HistogramField,
  bars: number,
  value: number | null,
  openAt: 0 | 1
): number {
  if (value === null) return openAt;
  return (nearestEdgeIndex(FIELDS[field].edges, value) + 1) / bars;
}

/**
 * How many wells the selected band holds, or null when that cannot be said
 * exactly.
 *
 * The bars are the only population this control has, so a band that starts or
 * ends part-way through a bar has no exact answer here. Rather than show a
 * number that is nearly right, it shows none: a count on screen that disagrees
 * with the count behind it is worse than an absent one, and the map already
 * reports what the current filters actually found.
 */
export function bandCount(
  field: HistogramField,
  buckets: HistogramBucket[],
  min: number | null,
  max: number | null
): number | null {
  const { edges } = FIELDS[field];
  const onEdge = (v: number | null) => v === null || edges.includes(v);
  if (!onEdge(min) || !onEdge(max)) return null;
  return buckets
    .filter((b) => barInBand(b, min, max))
    .reduce((sum, b) => sum + b.count, 0);
}

/**
 * Is this bar inside the selected band? Shared by the count above and by the
 * highlight the user sees, so a lit bar and a counted bar are the same rule.
 *
 * The underflow bar belongs to the band only when it is open at the bottom, and
 * the overflow bar only when it is open at the top: a band with a floor cannot
 * contain wells whose value is below every edge.
 */
export function barInBand(
  b: HistogramBucket,
  min: number | null,
  max: number | null
): boolean {
  if (b.from === null) return min === null;
  if (min !== null && b.from < min) return false;
  if (max !== null && (b.to === null || b.to > max)) return false;
  return true;
}
