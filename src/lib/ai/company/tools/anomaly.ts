import "server-only";

import { z } from "zod";
import { defineTool, type CatalogTool } from "@/lib/ai/catalog-tool";
import { getSupabaseServer } from "@/lib/supabase/server";
import { parseHandleOfType } from "@/lib/ontology/handles";
import { measure, METRICS, type Metric } from "@/lib/ontology/measure";
import { daysInMonth } from "@/lib/analytics/monthly-rates";
import { selectWells } from "@/lib/ontology/select";
import { getPostedPrices } from "@/lib/pricing/posted-prices";
import { deviations, monthlyRatesFromDaily, type Deviation } from "../math";

/**
 * `deviation_scan`: the well that quietly fell off its own baseline.
 *
 * Not the well that went down, which the operator knows about. The one still
 * producing, still on the route, running below its own fitted baseline for
 * months, invisible at fleet scale because it is one of eighty and it is not
 * zero.
 *
 * Three properties decide whether this gets used or muted, and all three are
 * here rather than in a follow-up:
 *
 *   FITTED, NOT ASSERTED   the threshold comes from the entity's own spread, so
 *                          a well that always swings 20% does not fire and a
 *                          steady one that moves 8% does.
 *   COVERAGE-AWARE         a month with no readings is not a month of zero
 *                          production. Scanning over one produces a fleet of
 *                          false collapses, which is how a detector gets
 *                          switched off in week two.
 *   PRICED                 a residual in barrels is a curiosity; the same
 *                          residual in dollars is a decision.
 *
 * The dollars are REVENUE FOREGONE, at the price the operator actually realized
 * that month, and nothing here knows what anything costs. This system holds no
 * cost model: oil and gas expense accounting is intricate enough to deserve its
 * own project, so no tool in this catalog computes a margin, a profit or a cost
 * per barrel. Where a number sounds like one, it is revenue.
 */

/**
 * How many wells one scan reads, and why anything past it is refused.
 *
 * The old cap took the first 60 members of the selection and scanned those, so a
 * 210-well fleet answered "which wells have fallen off their baseline" out of an
 * arbitrary sixty. The cap was applied BEFORE the detector rather than to its
 * output, which makes the result a sample wearing a scan's name, and a
 * `truncated` flag beside it is read past.
 *
 * The filter cannot move into SQL the way an RRC screen's can: the threshold is
 * fitted per well from that well's own months, so every well in scope costs a
 * series read. So the population is scanned WHOLE up to the ceiling and a fleet
 * above it is refused, naming the lease to cut by. `SCAN_BATCH` bounds how many
 * of those reads are in flight at once, because a fleet-wide `Promise.all` opens
 * one request per well.
 *
 * 300 is a fleet ceiling rather than a measured one: it covers every operator
 * this system serves, and at 25 in flight it is twelve rounds of series reads
 * inside one answer. If an org ever sits above it, the honest fix is a
 * fleet-wide series read, not a bigger sample.
 */
const MAX_WELLS = 300;
const SCAN_BATCH = 25;

/** The findings actually listed. Applied to the OUTPUT, after every well is scanned. */
const MAX_FINDINGS = 50;

/** Map with bounded concurrency, preserving order. */
async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** The realized price for a period, from what the org actually got paid. */
function priceFor(
  posted: Awaited<ReturnType<typeof getPostedPrices>>,
  metric: Metric,
  period: string
): number | null {
  if (metric === "water") return null;
  const series = metric === "oil" ? posted.oil : posted.gas;
  const inMonth = (series ?? []).filter((p) => p.date.startsWith(period));
  if (inMonth.length === 0) return null;
  return inMonth[inMonth.length - 1].price;
}

export const TOOLS: CatalogTool[] = [
  defineTool(
    "deviation_scan",
    "Every well whose recent production has departed from its OWN history, with the shortfall in barrels and in revenue at the price actually realized. The threshold is fitted per well from its own variability, every month is compared as a RATE PER MEASURED DAY (so a half-entered month is not a halving), and months with too few readings to judge are dropped rather than counted as zero. This is how a well that is down 30% but still producing gets noticed.",
    {
      metric: z.enum(METRICS).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      leaseId: z.string().optional(),
      threshold: z.number().min(1).max(10).optional(),
      minCoverage: z.number().min(0).max(1).optional(),
    },
    async ({ metric, from, to, leaseId, threshold, minCoverage }) => {
      const sb = await getSupabaseServer();
      const stream: Metric = metric ?? "oil";
      const floor = minCoverage ?? 0.5;

      const [wells, posted] = await Promise.all([
        selectWells({ leaseId, wellType: "producer" }),
        getPostedPrices().catch(() => ({ oil: [], gas: [] })),
      ]);
      // The refusal, and it replaces a ranked list of an arbitrary subset. A
      // scan that cannot cover the fleet is not a smaller scan, it is a
      // different question, and the caller is told which argument makes it one.
      if (wells.count > MAX_WELLS) {
        return {
          ok: false as const,
          error:
            `${wells.count} wells are in scope and this scan reads at most ${MAX_WELLS}. ` +
            `Scanning ${MAX_WELLS} of ${wells.count} would be a SAMPLE reported as a fleet scan, ` +
            `so it is refused rather than returned. Pass leaseId to scan one lease at a time; ` +
            `every lease is then complete on its own and the leases add up to the fleet.`,
          wellsInScope: wells.count,
          wellsScanned: 0,
          isComplete: false,
        };
      }

      const scanned = await inBatches(wells.members, SCAN_BATCH, async (m) => {
        const handle = parseHandleOfType(m.handle, ["well"])!;
        /*
         * RATES PER MEASURED DAY, not month totals.
         *
         * The scan used to compare a month's VOLUME against a baseline of whole
         * months and gate on a coverage floor. That gate is pass/fail: a month
         * with 60% of its days entered cleared it and then read as a 40%
         * shortfall, which is data entry, not lost oil — and a month gauged only
         * on the 29th to the 31st failed it outright, because the probe spanned
         * the 1st to the 28th. Dividing each month by the days it was actually
         * measured removes the artefact instead of filtering it, and the days
         * travel so a thin month can still be judged.
         */
        const daily = await measure(sb, handle, stream, { from, to, grain: "day" });
        const months = monthlyRatesFromDaily(daily.points);
        const daysIn = new Map(months.map((mo) => [mo.period, mo.days]));

        if (months.length < 5) {
          return {
            handle: m.handle,
            name: m.name,
            skipped: "fewer than five months of history, so it has no baseline to depart from",
          };
        }

        const found = deviations(
          months.map(({ period, value }) => ({ period, value })),
          { threshold: threshold ?? 3 }
        );
        const flagged = found.filter((d: Deviation) => d.flagged && d.residual < 0);
        if (flagged.length === 0) {
          return { handle: m.handle, name: m.name, flagged: [] as unknown[] };
        }

        /*
         * A month with very few measured days still reports a noisy rate, so the
         * floor survives as a CONFIDENCE cut rather than as the correction. It is
         * a fraction of the month's real length now, and coverage is read over
         * the month's true bounds instead of its first 28 days.
         */
        const checked = flagged.map((d) => {
          const days = daysIn.get(d.period) ?? 0;
          const monthLength = daysInMonth(d.period);
          const covered = monthLength > 0 ? days / monthLength : 0;
          if (covered < floor) return null;
          const price = priceFor(posted, stream, d.period);
          // The residual is a RATE; the barrels actually foregone are that rate
          // over the days the well was measured.
          const shortfallVolume = d.residual * days;
          return {
            period: d.period,
            perDay: d.value,
            baselinePerDay: d.baseline,
            shortfallPerDay: d.residual,
            shortfall: shortfallVolume,
            measuredDays: days,
            sigmas: d.sigmas,
            coverage: Number(covered.toFixed(3)),
            price,
            revenue: price === null ? null : shortfallVolume * price,
          };
        });
        // thin months drop out: too few readings to judge, not an absence of oil
        const withCoverage = checked.filter((c) => c !== null);

        return { handle: m.handle, name: m.name, flagged: withCoverage };
      });

      const hits = scanned.filter(
        (s): s is { handle: string; name: string; flagged: { revenue: number | null; shortfall: number }[] } =>
          Array.isArray((s as { flagged?: unknown[] }).flagged) &&
          ((s as { flagged: unknown[] }).flagged.length ?? 0) > 0
      );
      const totalDollars = hits.reduce(
        (sum, w) => sum + w.flagged.reduce((s, f) => s + (f.revenue ?? 0), 0),
        0
      );

      // The dollars and the count above are over every hit. Only the LISTING is
      // shortened, and it is the worst wells rather than the first ones: a cut
      // that happens after the detector has run over the whole fleet costs
      // nothing but reading, which is the opposite of the cap this replaced.
      const weight = (w: (typeof hits)[number]) =>
        w.flagged.reduce((s, f) => s + Math.abs(f.revenue ?? f.shortfall), 0);
      const listed = [...hits].sort((a, b) => weight(b) - weight(a)).slice(0, MAX_FINDINGS);

      return {
        ok: true as const,
        metric: stream,
        window: { from: from ?? null, to: to ?? null },
        /** The population. Every well in it was scanned. */
        wellsInScope: wells.count,
        wellsScanned: scanned.length,
        isComplete: scanned.length >= wells.count,
        /** The TRUE number of wells that fired, not the length of `findings`. */
        wellsFlagged: hits.length,
        findings: listed,
        findingsListed: listed.length,
        totalRevenueShortfall: totalDollars,
        skipped: scanned
          .filter((s) => "skipped" in s)
          .map((s) => ({ handle: s.handle, name: s.name, why: (s as { skipped: string }).skipped })),
        basis:
          "A shortfall is measured against the well's OWN prior months, not against a fleet " +
          "average, and the threshold is that well's own variability. Every month is a RATE per " +
          "measured day, so a month only half entered is compared like for like instead of " +
          "reading as a halving; `shortfall` is that rate gap over the days actually measured. " +
          "Dollars use the realized price the org actually received that month; a month with no " +
          "realized price reports the shortfall in volume only. Months with too few readings to " +
          "judge are dropped, because a month nobody read is not a month of no production. Dollars are REVENUE " +
          "foregone, never profit: nothing in this system knows what anything costs. Every well " +
          "in scope was scanned, so `wellsFlagged` and the dollar total are the fleet's; " +
          "`findings` lists the worst `findingsListed` of them and is the only thing shortened.",
      };
    }
  ),

  defineTool(
    "brief",
    "The Monday-morning composite: production that has departed from its own baseline, and settlement gaps worth a phone call, each with the revenue at stake and the entity to open. Use it for 'what should I be looking at' or when a user asks how things are going.",
    { from: z.string().optional(), to: z.string().optional() },
    async ({ from, to }) => {
      // Imported here rather than at module load: `brief` composes the other
      // catalogs, and a top-level cycle between them would be a real one.
      const { runCompanyAnalysis } = await import("../dispatch");
      const [deviation, settlement] = await Promise.all([
        runCompanyAnalysis("deviation_scan", { from, to }),
        runCompanyAnalysis("settlement_audit", { from, to }),
      ]);

      // A refused scan is not an empty scan. `deviation_scan` refuses a fleet
      // too large to cover, and dropping that into `drifting: []` would report
      // "nothing has drifted" on the day nothing was looked at.
      const driftRefused =
        (deviation as { ok?: boolean }).ok === false
          ? (deviation as { error?: string }).error ?? "The deviation scan did not run."
          : null;

      return {
        window: { from: from ?? null, to: to ?? null },
        drifting: (deviation as { findings?: unknown }).findings ?? [],
        driftingNotScanned: driftRefused,
        revenueShortfall:
          (deviation as { totalRevenueShortfall?: number }).totalRevenueShortfall ?? 0,
        settlementGaps: (settlement as { flagged?: unknown }).flagged ?? [],
        note:
          "Each finding with the revenue at stake and the entity to open. Say what to do " +
          "about each; do not narrate the analysis that produced it. If a section is empty, " +
          "leave it out rather than reporting that nothing was found. If `driftingNotScanned` " +
          "is set the production scan did NOT run: say so and pass on what it asks for, and " +
          "never report that nothing has drifted. Dollar figures here " +
          "are REVENUE only: nothing in this system knows what anything costs.",
      };
    }
  ),
];
