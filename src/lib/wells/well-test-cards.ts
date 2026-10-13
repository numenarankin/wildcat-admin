import type { WellTest } from "@/lib/wells/well-tests";

/**
 * The view model behind a well-test CARD: one shape for all three kinds of test,
 * so the grid renders oil, gas and saltwater without knowing where each came
 * from.
 *
 * They do not share a backend. An oil or saltwater test is a `well_tests` row
 * whose volumes are re-derived from the tank/meter series; a gas test is this
 * well's shut-in measurement inside a METER's campaign, where the well's share is
 * the drop against the campaign's baseline. Both arrive here as the same card.
 *
 * Pure (types only) so the dev harness can build cards from fixtures and the well
 * page can build them from real rows, and neither can drift from the other.
 */

/** What a test measured. Drives the card's colour and its unit. */
export type WellTestKind = "oil" | "gas" | "water";

/** Where a test is in its life: still open, or closed and yielding a rate. */
export type WellTestStatus = "in-progress" | "complete";

/** One labelled figure on a card (the fields under the headline rate). */
export interface WellTestFact {
  label: string;
  /** Pre-formatted: the card prints it verbatim. */
  value: string;
}

export interface WellTestCardModel {
  id: string;
  kind: WellTestKind;
  status: WellTestStatus;
  /** ISO timestamp the test opened. */
  startAt: string;
  /** ISO timestamp it closed, or null while in progress. */
  endAt: string | null;
  /** The headline rate, in `unit`, or null when the test cannot yield one. */
  rate: number | null;
  unit: string;
  /** This well's share of the facility it was tested against (0-100), or null. */
  sharePct: number | null;
  facts: WellTestFact[];
}

/**
 * Which kind a `well_tests` row is.
 *
 * An isolation tank means the test was routed to a tank and measured OIL. With no
 * tank, the row is a saltwater test: the water node (or the barrels typed in) is
 * the whole of it. Gas never lands in this table.
 */
export function wellTestKind(test: WellTest): Exclude<WellTestKind, "gas"> {
  return test.isolationTankId ? "oil" : "water";
}

/** A test's per-day rate for its own stream, or null when it has none yet. */
function ratePerDay(volume: number | null, days: number | null): number | null {
  if (volume == null || !Number.isFinite(volume)) return null;
  if (days == null || !(days > 0)) return null;
  return volume / days;
}

const numFmt = (v: number | null, dp = 1): string =>
  v == null || !Number.isFinite(v)
    ? " "
    : v.toLocaleString("en-US", { maximumFractionDigits: dp });

/**
 * An oil test as a card: the isolation tank's rate over the window, the rest of
 * the battery beside it, and the share those two imply.
 */
export function oilTestCard(
  test: WellTest,
  names: { tankNameById?: Record<string, string> } = {}
): WellTestCardModel {
  const tank = test.isolationTankId
    ? (names.tankNameById?.[test.isolationTankId] ?? "Tank")
    : null;
  const control = ratePerDay(test.controlBbls, test.durationDays);
  return {
    id: test.id,
    kind: "oil",
    status: test.endAt ? "complete" : "in-progress",
    startAt: test.startAt,
    endAt: test.endAt,
    rate: ratePerDay(test.oilBbls, test.durationDays),
    unit: "bbl/d",
    sharePct: test.frac == null ? null : test.frac * 100,
    facts: [
      { label: "Isolation tank", value: tank ?? " " },
      { label: "Rest of battery", value: `${numFmt(control)} bbl/d` },
      { label: "Water", value: `${numFmt(ratePerDay(test.waterBbls, test.durationDays))} bbl/d` },
    ],
  };
}

/**
 * A saltwater test as a card. Water is measured where it can be: a meter's
 * throughput or a tank's gauges over the window, and typed in barrels where
 * nothing measures it, which is most wells.
 */
export function waterTestCard(
  test: WellTest,
  names: { nodeNameById?: Record<string, string> } = {}
): WellTestCardModel {
  const node = test.waterNode
    ? (names.nodeNameById?.[test.waterNode.id] ?? "Meter")
    : null;
  const perDay = ratePerDay(test.waterBbls, test.durationDays);
  return {
    id: test.id,
    kind: "water",
    status: test.endAt ? "complete" : "in-progress",
    startAt: test.startAt,
    endAt: test.endAt,
    rate: perDay,
    unit: "bbl/d",
    sharePct: null,
    facts: [
      // A bucket test names no node: the whole record is a volume and a stretch
      // of minutes, so the card carries what came out instead.
      {
        label: "Measured at",
        value: node ?? `${numFmt(test.waterBbls)} bbl caught`,
      },
      { label: "Total", value: `${numFmt(test.waterBbls)} bbl` },
      { label: "Per hour", value: `${numFmt(perDay == null ? null : perDay / 24, 2)} bbl/hr` },
    ],
  };
}

/** A gas shut-in measurement (from a meter's campaign) as a card. */
export interface GasTestInput {
  id: string;
  startAt: string;
  endAt: string | null;
  meterName: string;
  /** What the meter read with this well shut in, MCF/day. */
  shutInMcfPerDay: number | null;
  /** The campaign's all-wells-online rate, MCF/day, or null when not set yet. */
  baselineMcfPerDay: number | null;
  /** True once the campaign has been published (the share is final). */
  published: boolean;
}

/**
 * A gas test as a card.
 *
 * The well's own rate is not read anywhere: a gas meter reports one commingled
 * total, so it is the DROP the meter takes when this well alone is shut in:
 * `baseline − shutIn`, and the share is that over the baseline. Without a
 * baseline there is no drop to compute, and the card says so rather than
 * printing the shut-in reading as though it were the well's gas.
 */
export function gasTestCard(input: GasTestInput): WellTestCardModel {
  const drop =
    input.baselineMcfPerDay == null || input.shutInMcfPerDay == null
      ? null
      : input.baselineMcfPerDay - input.shutInMcfPerDay;
  const share =
    drop == null || !input.baselineMcfPerDay || input.baselineMcfPerDay <= 0
      ? null
      : (drop / input.baselineMcfPerDay) * 100;
  return {
    id: input.id,
    kind: "gas",
    status: input.endAt ? "complete" : "in-progress",
    startAt: input.startAt,
    endAt: input.endAt,
    rate: drop,
    unit: "mcf/d",
    sharePct: share,
    facts: [
      { label: "Meter", value: input.meterName },
      { label: "Baseline", value: `${numFmt(input.baselineMcfPerDay)} mcf/d` },
      { label: "Shut in", value: `${numFmt(input.shutInMcfPerDay)} mcf/d` },
    ],
  };
}

/** Newest first, in-progress tests ahead of completed ones. */
export function sortCards(cards: WellTestCardModel[]): WellTestCardModel[] {
  return [...cards].sort((a, b) => {
    if (a.status !== b.status) return a.status === "in-progress" ? -1 : 1;
    return a.startAt < b.startAt ? 1 : a.startAt > b.startAt ? -1 : 0;
  });
}
