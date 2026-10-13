import "server-only";

import { defineTool, type CatalogTool } from "@/lib/ai/catalog-tool";
import { getSupabaseServer } from "@/lib/supabase/server";
import { z } from "zod";

import { parseHandleOfType, type EntityType } from "@/lib/ontology/handles";
import { MEASURABLE, measure, METRICS, type Metric } from "@/lib/ontology/measure";
import {
  selectBatteries,
  selectLeases,
  selectMeters,
  selectTanks,
  selectWells,
  type Selection,
} from "@/lib/ontology/select";
import {
  change,
  median,
  monthlySlope,
  percentileRank,
  shares,
  splitMonthInProgress,
} from "../math";

/**
 * The generic verbs: rank, compare, trend, concentration.
 *
 * They compose over any metric and any cohort, which is why four of them answer
 * most of what gets asked. Each reads production through `measure` and nothing
 * else, so a ranking and the well page cannot disagree about the same barrel.
 *
 * Every one of these fans out over a cohort, so each is bounded and says when it
 * cut. A silent cut reads as "that is all there is", which on a ranking is the
 * difference between "your three worst wells" and "three of your worst wells".
 */

const metricArg = z.enum(METRICS);
const COHORTS = ["wells", "leases", "tanks", "batteries", "meters"] as const;
type Cohort = (typeof COHORTS)[number];

/** How many entities one analysis will measure. Fan-out is the cost here. */
const MAX_MEMBERS = 60;

const COHORT_TYPE: Record<Cohort, EntityType> = {
  wells: "well",
  leases: "lease",
  tanks: "tank",
  batteries: "battery",
  meters: "meter",
};

async function cohortMembers(
  cohort: Cohort,
  leaseId?: string
): Promise<Selection> {
  const sb = await getSupabaseServer();
  switch (cohort) {
    case "wells":
      return selectWells({ leaseId, wellType: "producer" });
    case "leases":
      return selectLeases();
    case "tanks":
      return selectTanks(sb, { leaseId, product: "oil" });
    case "batteries":
      return selectBatteries(sb, { leaseId });
    case "meters":
      return selectMeters(sb, { leaseId });
  }
}

/** One member's total and daily rate for a metric over a window. */
async function measureMembers(
  members: { handle: string; name: string }[],
  metric: Metric,
  from?: string,
  to?: string
) {
  const sb = await getSupabaseServer();
  return Promise.all(
    members.map(async (m) => {
      const parsed = parseHandleOfType(m.handle, MEASURABLE[metric]);
      const result = parsed
        ? await measure(sb, parsed, metric, { from, to, grain: "month" })
        : null;
      /*
       * MEASURED is not the same as zero.
       *
       * A member with no series reaching it (nothing wired, or nothing entered)
       * used to arrive here as `total: 0` and sort last, indistinguishable from
       * one that was measured and made nothing. Only the all-zero cohort was
       * caught. The flag travels so a ranking can list those separately and say
       * why, instead of ranking a well nobody measures beneath one that is.
       */
      const measured = (result?.points.length ?? 0) > 0;
      return {
        handle: m.handle,
        name: m.name,
        measured,
        total: result?.total ?? 0,
        perDay: result?.perDay ?? null,
        basis: result?.basis ?? null,
        points: result?.points ?? [],
      };
    })
  );
}

/** Refuse a metric the cohort cannot carry, by name, before measuring anything. */
function cohortSupports(cohort: Cohort, metric: Metric): boolean {
  return MEASURABLE[metric].includes(COHORT_TYPE[cohort]);
}

const unsupported = (cohort: Cohort, metric: Metric) => ({
  ok: false as const,
  error: `${metric} is not measured for ${cohort}.`,
  expected: `${metric} can be measured for: ${MEASURABLE[metric].join(", ")}.`,
});

/**
 * A cohort where NOTHING is measured is not a ranking of zeros.
 *
 * Observed live: an org with no tank gauges or meter readings entered asked for
 * its best wells. `rank` dutifully returned five leases at 0.0 bbl in a tidy
 * order, which reads as "these are your worst leases" rather than "no production
 * has been recorded at all". The model, reasonably, went looking for another
 * source and answered from the ledger.
 *
 * So a total of zero across every member is reported as an ABSENCE, with the
 * reason, and the ordering is withheld. There is no ordering; every member is
 * tied.
 */
function nothingMeasured(
  cohort: Cohort,
  metric: Metric,
  members: number
): Record<string, unknown> {
  return {
    ok: false as const,
    cohort,
    metric,
    membersConsidered: members,
    error: `No ${metric} has been recorded for any of these ${cohort}.`,
    reason:
      members === 0
        ? `There are no ${cohort} on file to rank.`
        : `All ${members} returned zero, which means no readings have been entered rather than that they produced nothing. Oil comes from tank gauges, gas from meter readings; if neither has been entered there is nothing to rank.`,
    remedy:
      "STOP. Do not retry with another cohort, another metric or another window — " +
      "the readings are missing for the whole org, so every one of those returns this " +
      "same answer. Tell the user production has not been recorded and answer from " +
      "settled revenue instead (list_revenue), saying which you used.",
  };
}

export const TOOLS: CatalogTool[] = [
  defineTool(
    "rank",
    "Rank a cohort by a metric over a window, with each member's total, daily rate and share of the whole. The answer to 'which wells make the most', 'which leases are carrying us', 'what should I look at first'.",
    {
      cohort: z.enum(COHORTS),
      metric: metricArg,
      from: z.string().optional(),
      to: z.string().optional(),
      leaseId: z.string().optional(),
      limit: z.number().int().min(1).max(MAX_MEMBERS).optional(),
      ascending: z.boolean().optional(),
    },
    async ({ cohort, metric, from, to, leaseId, limit, ascending }) => {
      if (!cohortSupports(cohort, metric)) return unsupported(cohort, metric);
      const selection = await cohortMembers(cohort, leaseId);
      const capped = selection.members.slice(0, MAX_MEMBERS);
      const measured = await measureMembers(capped, metric, from, to);

      // Members nothing measures are held OUT of the ordering: a well with no
      // series is not the worst well, it is a well nobody can rank.
      const rankable = measured.filter((m) => m.measured);
      const unmeasured = measured.filter((m) => !m.measured);
      const { total, withShare, countTo } = shares(
        rankable.map((m) => ({ ...m, value: m.total }))
      );
      if (total === 0) return nothingMeasured(cohort, metric, capped.length);
      const ranked = [...withShare].sort((a, b) =>
        ascending ? a.value - b.value : b.value - a.value
      );

      return {
        cohort,
        metric,
        window: { from: from ?? null, to: to ?? null },
        members: ranked.slice(0, limit ?? 25).map((m) => ({
          handle: m.handle,
          name: m.name,
          total: m.total,
          perDay: m.perDay,
          share: m.share,
          basis: m.basis,
        })),
        total,
        /** How few members make up 80% of the total. */
        countTo80pct: countTo,
        measured: rankable.length,
        /**
         * In the cohort, absent from the ordering: nothing measures this metric
         * for them. Report them as unmeasured, never as the bottom of the list.
         */
        unmeasured: unmeasured.map((m) => ({ handle: m.handle, name: m.name })),
        ofCohort: selection.count,
        truncated: selection.count > capped.length || ranked.length > (limit ?? 25),
        ...(selection.count > capped.length
          ? {
              note: `Only the first ${MAX_MEMBERS} of ${selection.count} were measured, so this is not the whole cohort. Narrow with leaseId before quoting a total.`,
            }
          : {}),
      };
    }
  ),

  defineTool(
    "compare",
    "One entity against its cohort on a metric: its rate, the cohort median, and its percentile. Answers 'is this well any good' without the model eyeballing a list.",
    {
      handle: z.string(),
      metric: metricArg,
      cohort: z.enum(COHORTS).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      leaseId: z.string().optional(),
    },
    async ({ handle, metric, cohort, from, to, leaseId }) => {
      const group: Cohort = cohort ?? "wells";
      if (!cohortSupports(group, metric)) return unsupported(group, metric);
      const parsed = parseHandleOfType(handle, MEASURABLE[metric]);
      if (!parsed) {
        return {
          ok: false as const,
          error: `"${handle}" cannot be measured for ${metric}.`,
          expected: `Types accepted: ${MEASURABLE[metric].join(", ")}.`,
        };
      }

      const selection = await cohortMembers(group, leaseId);
      const capped = selection.members.slice(0, MAX_MEMBERS);
      const measured = await measureMembers(capped, metric, from, to);
      const rates = measured
        .filter((m) => m.measured)
        .map((m) => m.perDay)
        .filter((v): v is number => v !== null);
      if (rates.length === 0 || rates.every((r) => r === 0)) {
        return nothingMeasured(group, metric, capped.length);
      }

      const mine = measured.find((m) => m.handle === `${parsed.type}:${parsed.id}`);
      const sb = await getSupabaseServer();
      const own =
        mine ?? {
          perDay: (await measure(sb, parsed, metric, { from, to })).perDay,
          name: handle,
        };

      return {
        handle,
        metric,
        perDay: own.perDay,
        cohort: group,
        cohortSize: rates.length,
        cohortMedian: median(rates),
        percentile: own.perDay === null ? null : percentileRank(rates, own.perDay),
        inCohort: Boolean(mine),
        ...(mine
          ? {}
          : {
              note: "This entity is not in the cohort it was compared against, so the percentile places it beside that group rather than within it.",
            }),
      };
    }
  ),

  defineTool(
    "trend",
    "How a metric has moved for one entity: the monthly series, the fitted slope per month, and the change from first month to last. Use before saying anything is up or down.",
    {
      handle: z.string(),
      metric: metricArg,
      from: z.string().optional(),
      to: z.string().optional(),
    },
    async ({ handle, metric, from, to }) => {
      const parsed = parseHandleOfType(handle, MEASURABLE[metric]);
      if (!parsed) {
        return {
          ok: false as const,
          error: `"${handle}" cannot be measured for ${metric}.`,
          expected: `Types accepted: ${MEASURABLE[metric].join(", ")}.`,
        };
      }
      const sb = await getSupabaseServer();
      const series = await measure(sb, parsed, metric, { from, to, grain: "month" });
      const points = series.points;

      if (points.length < 2) {
        return {
          handle,
          metric,
          unit: series.unit,
          basis: series.basis,
          points,
          slopePerMonth: null,
          change: null,
          note: "Fewer than two months of data, so there is no trend to report. Say that rather than describing the direction of one point.",
        };
      }

      /*
       * The month in progress is excluded from the COMPARISON.
       *
       * `points` are month totals, and the current month holds only the days
       * that have happened. Comparing that against whole months reports a
       * collapse every time, which the note underneath was not enough to stop —
       * the arithmetic has to refuse it. The point stays in `points` (it is real
       * production) and is named, so the model can quote it as month-to-date.
       */
      const currentMonth = new Date().toISOString().slice(0, 7);
      const { complete, inProgress: partial } = splitMonthInProgress(
        points,
        currentMonth
      );

      if (complete.length < 2) {
        return {
          handle,
          metric,
          unit: series.unit,
          basis: series.basis,
          points,
          monthInProgress: partial,
          slopePerMonth: null,
          change: null,
          note: "Only the month in progress plus one complete month, so there is no trend yet. A month-to-date total is not comparable with a whole month.",
        };
      }

      return {
        handle,
        metric,
        unit: series.unit,
        basis: series.basis,
        points,
        months: complete.length,
        slopePerMonth: monthlySlope(complete),
        change: change(complete[0].value, complete[complete.length - 1].value),
        first: complete[0],
        last: complete[complete.length - 1],
        /** Month-to-date, deliberately outside the trend. Null when the window ends earlier. */
        monthInProgress: partial,
        note:
          "`change` and `slopePerMonth` cover COMPLETE months only; `monthInProgress` is month-to-date and is not comparable with them. An earlier month can still be partly unreported — check get_coverage before calling any single month's drop a decline.",
      };
    }
  ),

  defineTool(
    "concentration",
    "How much of a metric comes from how few members: each one's share and the count that makes up 80%. The answer to 'how exposed are we if one well goes down'.",
    {
      cohort: z.enum(COHORTS),
      metric: metricArg,
      from: z.string().optional(),
      to: z.string().optional(),
      threshold: z.number().min(0.1).max(1).optional(),
    },
    async ({ cohort, metric, from, to, threshold }) => {
      if (!cohortSupports(cohort, metric)) return unsupported(cohort, metric);
      const selection = await cohortMembers(cohort);
      const capped = selection.members.slice(0, MAX_MEMBERS);
      const measured = await measureMembers(capped, metric, from, to);
      // Unmeasured members are not a zero share; they are outside the question.
      const rankable = measured.filter((m) => m.measured);
      const { total, withShare, countTo } = shares(
        rankable.map((m) => ({ ...m, value: m.total })),
        threshold ?? 0.8
      );
      if (total === 0) return nothingMeasured(cohort, metric, capped.length);
      const ranked = [...withShare].sort((a, b) => b.value - a.value);

      return {
        cohort,
        metric,
        total,
        threshold: threshold ?? 0.8,
        countToThreshold: countTo,
        ofMembers: rankable.length,
        unmeasuredMembers: measured.length - rankable.length,
        top: ranked.slice(0, 10).map((m) => ({
          handle: m.handle,
          name: m.name,
          total: m.total,
          share: m.share,
        })),
        truncated: selection.count > capped.length,
      };
    }
  ),
];
