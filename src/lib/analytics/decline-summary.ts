import "server-only";

import { getSupabaseServer } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { getCompanyDecline } from "@/lib/analytics/company-decline";
import { getRealizedPrices } from "@/lib/analytics/summary";
import { fleetDecline } from "@/lib/analytics/fleet-decline";
import { DECLINE_FORWARD_MONTHS } from "@/lib/charts/decline-rows";
import {
  completeMonths,
  currentDailyEma,
  fitDecline,
  forward12moDecline,
  monthlyRatesFromPoints,
  type DeclineFit,
  type MonthlyRate,
} from "@/lib/wells/arps";
import { getWell, getWellProduction } from "@/lib/wells/wells";
import { wellDisplayProductionRows } from "@/lib/wells/production-rows";
import { wellGasSeries, leaseGasDailySeries } from "@/lib/meters/engine";
import { leaseProductionSeries } from "@/lib/tanks/series-loaders";
import { partialTailDate, withoutPartialTail } from "@/lib/production/partial-day";
import { getLease } from "@/lib/leases/leases";
import { rrcProductionHorizon } from "@/lib/rrc/record-currency";

/**
 * The app's decline, callable — the one derivation behind every decline the UI
 * shows, so an answer given in chat cannot be a second opinion about the curve
 * on the screen.
 *
 * Every decline surface already runs on the same four pure functions
 * (`monthlyRatesFromPoints` → `fitDecline` → `forward12moDecline`, plus
 * `boeForward12Decline` for the blend). What differed between them was never the
 * math, it was the SERIES each one assembled, and that is what this module
 * centralizes:
 *
 *   well    the operator's regularized oil + metered gas, with the state's
 *           monthly record concatenated BEFORE the first own reading
 *   lease   the same shape at lease grain
 *   company every lease's oil and gas on that same series, each anchored at
 *           its current rate and SUMMED forward — the decline of the fleet's
 *           projection, not a curve through its total (`company-decline`,
 *           which is what the dashboard card shows)
 *
 * The composition is reported with the answer, because "12%/yr" from a series
 * that includes public filings and "12%/yr" from measured months alone are not
 * the same claim.
 *
 * ## What this reports
 *
 * The FORWARD decline: the fraction the fitted curve falls over the twelve
 * months after its last point. Under a hyperbolic fit that is not the trailing
 * average and must not be described as one. It is what the "Proj. 12-mo decline"
 * card and the chart's curve both quote.
 *
 * ## Why BOE is not the average of the two
 *
 * Averaging two curves' decline rates is not the decline of their sum, and
 * neither is one curve fitted through it. At every grain BOE is each stream's
 * own curve, anchored at its current rate and summed forward (`fleet-decline`):
 * two curves for a well or lease, every lease's for the company. Gas converts
 * at the PRICE ratio, never 6:1.
 */

export type DeclineStreamKey = "oil" | "gas" | "boe";

export interface StreamDecline {
  stream: DeclineStreamKey;
  /** Forward 12-month decline as a fraction (0.12 = down 12%/yr), or null. */
  annualDecline: number | null;
  /** Months of post-peak data the fit used. */
  months: number | null;
  /** The month the fit window starts at — the sustained peak, not the series start. */
  peakMonth: string | null;
  /** First and last month of the series the fit was offered. */
  seriesFrom: string | null;
  seriesTo: string | null;
  /** Present only when `annualDecline` is null: why there is no number. */
  reason?: string;
}

export interface DeclineSummaryResult {
  entity: { kind: "company" | "well" | "lease"; id: string | null; name: string };
  /** Which series each fit ran over, in the words the answer should use. */
  basis: string;
  /** Whether the state's monthly filings are part of the series. */
  includesPublicRecord: boolean;
  unit: { oil: string; gas: string; boe: string };
  streams: StreamDecline[];
  note: string;
}

/** A stream that could not be fitted, with the reason stated rather than a 0. */
function noFit(
  stream: DeclineStreamKey,
  rates: MonthlyRate[],
  reason: string
): StreamDecline {
  return {
    stream,
    annualDecline: null,
    months: null,
    peakMonth: null,
    seriesFrom: rates[0]?.month ?? null,
    seriesTo: rates[rates.length - 1]?.month ?? null,
    reason,
  };
}

function fitted(
  stream: DeclineStreamKey,
  rates: MonthlyRate[],
  fit: DeclineFit
): StreamDecline {
  return {
    stream,
    annualDecline: forward12moDecline(fit),
    months: fit.months,
    peakMonth: fit.startMonth,
    seriesFrom: rates[0]?.month ?? null,
    seriesTo: rates[rates.length - 1]?.month ?? null,
  };
}

/** One stream's fit, or the reason there isn't one. */
export function declineOfSeries(
  stream: DeclineStreamKey,
  rates: MonthlyRate[]
): StreamDecline {
  if (rates.length === 0) {
    return noFit(
      stream,
      rates,
      `Nothing measures ${stream === "boe" ? "oil or gas" : stream} here, so there is no series to fit. That is a wiring or data-entry gap, not a flat well.`
    );
  }
  const fit = fitDecline(completeMonths(rates));
  if (!fit) {
    return noFit(
      stream,
      rates,
      `${rates.length} month(s) of rate, and not enough of it AFTER the peak to fit a curve (six post-peak months are the minimum). A rising or brand-new series has no decline yet — say that rather than reporting zero.`
    );
  }
  return fitted(stream, rates, fit);
}

const UNITS = { oil: "bbl/d", gas: "mcf/d", boe: "boe/d (priced barrels)" };

const NOTE =
  "These are FORWARD declines: the fraction the fitted curve falls over the " +
  "twelve months after its last point, which is what the app's decline card and " +
  "chart quote. Not a trailing average, and under a hyperbolic fit the two " +
  "differ. `peakMonth` is where the fit window starts — everything before the " +
  "sustained peak is ramp-up and is deliberately excluded, so a window that " +
  "begins mid-series is the fit working, not a truncation. BOE is each " +
  "stream's own curve anchored at its current rate and summed forward, gas " +
  "converted at the price ratio; it has no fit window of its own, and it is " +
  "never the average of the oil and gas figures.";

/**
 * Company: the fleet, summed forward — the dashboard card's own derivation.
 *
 * Per stream, the decline of that stream's projected sum over the next twelve
 * months; `months` and `peakMonth` are null because eighty leases have eighty
 * peaks and there is no single fit window to report.
 */
async function companyDecline(): Promise<DeclineSummaryResult> {
  const fleet = await getCompanyDecline();
  const streamOf = (stream: DeclineStreamKey): StreamDecline => {
    const annual = fleet.projection[stream][0]?.decline ?? null;
    if (annual == null) {
      return {
        stream,
        annualDecline: null,
        months: null,
        peakMonth: null,
        seriesFrom: null,
        seriesTo: null,
        reason:
          fleet.producing === 0
            ? "Nothing is producing now, so there is no fleet to project."
            : "No producing lease has six post-peak months of this stream to fit a curve to, so there is nothing to sum. A young account has no decline yet — say that rather than reporting zero.",
      };
    }
    return {
      stream,
      annualDecline: annual,
      months: null,
      peakMonth: null,
      seriesFrom: null,
      seriesTo: fleet.anchorMonth,
    };
  };
  const covered = `${(fleet.coverage * 100).toFixed(0)}% of current priced production (${fleet.fitted} of ${fleet.producing} producing lease-streams fitted a curve)`;
  return {
    entity: { kind: "company", id: null, name: "Company" },
    basis:
      "Every well's oil and gas fitted separately over the operator's own measurements (the state's filings are drawn for context, never fitted)" +
      ", each curve anchored at that stream's current 14-day rate and projected forward. " +
      "The company figure is the decline of their SUM over the next twelve months — the " +
      "dashboard card and the company chart's decline curve. It describes " +
      covered +
      "; streams too young to fit are left out rather than held flat.",
    includesPublicRecord: false,
    unit: UNITS,
    streams: [streamOf("oil"), streamOf("gas"), streamOf("boe")],
    note: NOTE,
  };
}

/** Well and lease: the operator's series with the state's record behind it. */
async function entityDecline(
  kind: "well" | "lease",
  id: string
): Promise<DeclineSummaryResult | null> {
  const sb = await getSupabaseServer();
  /** The entity's lease, so its BOE weighting reads its own realization. */
  let leaseId: string | null = kind === "lease" ? id : null;

  let name: string;
  let oilPoints: { date: string; oilProduction?: number }[];
  let gasPoints: { date: string; gasProduction?: number }[];

  if (kind === "well") {
    const well = await getWell(id);
    if (!well) return null;
    name = well.name;
    leaseId = well.leaseId ?? null;
    const readings = await getWellProduction(id);
    // The well page's own rows: regularized oil with the partial gauge day cut.
    const { regularized } = await wellDisplayProductionRows(sb, id, readings);
    const gas = await wellGasSeries(sb, id);
    oilPoints = regularized;
    gasPoints = gas.map((p) => ({ date: p.date, gasProduction: p.bbls }));
  } else {
    const lease = await getLease(sb, id);
    if (!lease) return null;
    name = lease.name || lease.leaseNo || "Lease";
    const [oilSeries, gasDaily] = await Promise.all([
      leaseProductionSeries(sb, id, { mode: "reading" }),
      leaseGasDailySeries(sb, id),
    ]);
    // Same cut the lease page makes before anything reads these.
    const tail = partialTailDate(oilSeries);
    const oilDaily = withoutPartialTail(oilSeries, tail);
    const gasRows = withoutPartialTail(gasDaily, tail);
    oilPoints = oilDaily.map((p) => ({ date: p.date, oilProduction: p.bbls }));
    gasPoints = gasRows.map((p) => ({ date: p.date, gasProduction: p.mcf }));
  }

  // History FIRST, exactly as the pages concatenate it: it is cut strictly
  // before the first own reading, so the two never overlap.
  const oil = monthlyRatesFromPoints(oilPoints, "oil");
  const gas = monthlyRatesFromPoints(gasPoints, "gas");

  /*
   * The headline's own BOE: each stream's curve anchored at its current 14-day
   * rate, summed forward — the same call the well and lease pages make, with
   * the same as-of rule (the later of the record's horizon and the last own
   * reading, so a stream the state stopped carrying decays to nothing).
   */
  const horizon = await rrcProductionHorizon();
  let asOf = horizon;
  for (const p of [...oilPoints, ...gasPoints]) if (asOf === null || p.date > asOf) asOf = p.date;
  const oilDaily = oilPoints.map((p) => ({ date: p.date, oilProduction: p.oilProduction ?? 0, gasProduction: 0 }));
  const gasDaily = gasPoints.map((p) => ({ date: p.date, oilProduction: 0, gasProduction: p.gasProduction ?? 0 }));
  const realized = await getRealizedPrices(leaseId);
  const prices = { oilPerBbl: realized.oilPerBbl, gasPerMcf: realized.gasPerMcf };
  const fleet = fleetDecline(
    [
      { unit: id, stream: "oil", rates: oil, current: currentDailyEma(oilDaily, "oil", asOf), asOf },
      { unit: id, stream: "gas", rates: gas, current: currentDailyEma(gasDaily, "gas", asOf), asOf },
    ],
    prices,
    new Date(),
    DECLINE_FORWARD_MONTHS
  );
  const boe: StreamDecline =
    fleet.annual == null
      ? noFit(
          "boe",
          [...oil, ...gas],
          fleet.producing === 0
            ? "Neither stream is making anything now, so there is no curve to anchor. That is a shut-in or a wiring gap, not a flat well."
            : "No producing stream has six post-peak months to fit a curve to, so there is nothing to sum. A rising or brand-new series has no decline yet — say that rather than reporting zero."
        )
      : {
          stream: "boe",
          annualDecline: fleet.annual,
          months: null,
          peakMonth: null,
          seriesFrom: [...oil, ...gas].map((r) => r.month).sort()[0] ?? null,
          seriesTo: fleet.anchorMonth,
        };

  return {
    entity: { kind, id, name },
    basis:
      "The operator's own measured series, and nothing else. Texas's monthly filings are drawn behind the page's chart for context but are an estimate and never enter the fit. This is what the page's decline draws.",
    includesPublicRecord: false,
    unit: UNITS,
    streams: [declineOfSeries("oil", oil), declineOfSeries("gas", gas), boe],
    note: NOTE,
  };
}

/** The decline for one entity, or null when the entity does not exist. */
export async function declineFor(
  target: { kind: "company" } | { kind: "well" | "lease"; id: string }
): Promise<DeclineSummaryResult | null> {
  if (!hasSupabase()) return null;
  if (target.kind === "company") return companyDecline();
  return entityDecline(target.kind, target.id);
}
