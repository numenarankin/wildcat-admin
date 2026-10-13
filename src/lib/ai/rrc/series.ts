import "server-only";

import { z } from "zod";
import {
  getCountyProfile,
  getCycleEdge,
  getFieldProfile,
  getLeaseDossier,
  getOperatorDossier,
  getProductionTrend,
  getWellDossier,
  type SeriesPoint,
} from "@/lib/scout/rrc-queries";
import type { LeaseMonth } from "@/lib/scout/rrc-types";

/**
 * Getting an RRC production history into a shape arithmetic can eat.
 *
 * Every analysis tool in this catalog starts here. The existing `rrc_*` tools
 * return dossiers shaped for reading aloud: slimmed, truncated, and different
 * per entity. A decline fit needs the opposite, which is the whole series in one
 * uniform shape with the unreported tail identified rather than trimmed away
 * silently.
 *
 * THE TAIL IS THE POINT. The RRC runs about three months behind and those
 * unfiled cycles sit in the mirror as zeros. Fitting a decline through them
 * produces a collapse that is not happening. So `resolveSeries` marks them and
 * every consumer drops them by default.
 */

/** Which stream a tool is analysing. */
export const STREAMS = ["oil", "gas", "cond", "csgd"] as const;
export type Stream = (typeof STREAMS)[number];

/**
 * The entity arguments, flat rather than a discriminated union.
 *
 * Flat because the model writes JSON against a one-line signature: `entity` says
 * which keys matter and the rest are optional. A nested union would render as
 * `obj` in the catalog and tell it nothing.
 */
export const ENTITY_SHAPE = {
  entity: z.enum(["lease", "well", "operator", "field", "county", "district", "statewide"]),
  oil_gas_code: z.enum(["O", "G"]).optional(),
  district_no: z.string().optional(),
  lease_no: z.string().optional(),
  api: z.string().optional(),
  operator_no: z.string().optional(),
  field_no: z.string().optional(),
  county: z.string().optional(),
};

export type EntityArgs = z.infer<z.ZodObject<typeof ENTITY_SHAPE>>;

export interface ResolvedSeries {
  label: string;
  /** Every cycle in the mirror, oldest first, including the unreported tail. */
  points: SeriesPoint[];
  /**
   * Lease-grain months, when the entity has them. Carries allowables, ending
   * balances and disposition totals, which the pre-aggregated geographic
   * rollups do not have.
   */
  months: LeaseMonth[] | null;
  /** Last cycle the RRC has actually published. */
  reportedThrough: string;
}

export type SeriesResult = ResolvedSeries | { error: string };

export function isError(r: SeriesResult): r is { error: string } {
  return "error" in r;
}

/** Lease-grain months to the uniform point shape. */
function fromLeaseMonths(months: LeaseMonth[]): SeriesPoint[] {
  return months.map((m) => ({
    cycle: m.cycle,
    oil: m.oil_prod_vol ?? 0,
    gas: m.gas_prod_vol ?? 0,
    cond: m.cond_prod_vol ?? 0,
    csgd: m.csgd_prod_vol ?? 0,
    reported: m.reported,
  }));
}

/**
 * The series for one entity.
 *
 * Returns `{ error }` rather than throwing when the caller did not supply the
 * keys its own `entity` requires, because that is a fixable mistake and the
 * model can fix it on the next call if it is told which key was missing.
 */
export async function resolveSeries(args: EntityArgs): Promise<SeriesResult> {
  const { reported } = await getCycleEdge();

  switch (args.entity) {
    case "lease": {
      const { oil_gas_code, district_no, lease_no } = args;
      if (!oil_gas_code || !district_no || !lease_no) {
        return { error: "entity 'lease' needs oil_gas_code, district_no and lease_no." };
      }
      const lease = await getLeaseDossier(oil_gas_code, district_no, lease_no);
      if (!lease) return { error: `No lease ${oil_gas_code}/${district_no}/${lease_no}.` };
      return {
        label: lease.lease_name ?? `${oil_gas_code}/${district_no}/${lease_no}`,
        points: fromLeaseMonths(lease.monthly),
        months: lease.monthly,
        reportedThrough: reported,
      };
    }
    case "well": {
      if (!args.api) return { error: "entity 'well' needs api." };
      const well = await getWellDossier(args.api.trim());
      if (!well) return { error: `No wellbore ${args.api}.` };
      return {
        // Lease-level volumes. A per-well share is a separate step, and calling
        // it a well's production here is how an allocation becomes a fact.
        label: `${well.header.lease_name ?? args.api} (lease volumes)`,
        points: fromLeaseMonths(well.production),
        months: well.production,
        reportedThrough: reported,
      };
    }
    case "operator": {
      if (!args.operator_no) return { error: "entity 'operator' needs operator_no." };
      const op = await getOperatorDossier(args.operator_no.trim());
      if (!op) return { error: `No operator ${args.operator_no}.` };
      return {
        label: op.record.operator_name ?? args.operator_no,
        points: fromLeaseMonths(op.monthly),
        months: op.monthly,
        reportedThrough: reported,
      };
    }
    case "field": {
      if (!args.field_no) return { error: "entity 'field' needs field_no." };
      const profile = await getFieldProfile(args.field_no.trim(), 4000);
      if (!profile) return { error: `No field ${args.field_no}.` };
      return {
        label: profile.field_name ?? args.field_no,
        points: profile.monthly,
        months: null,
        reportedThrough: reported,
      };
    }
    case "county": {
      if (!args.county) return { error: "entity 'county' needs county." };
      const profile = await getCountyProfile(args.county.trim(), 4000);
      if (!profile) return { error: `Not a Texas county: ${args.county}.` };
      return {
        label: profile.county_name ?? args.county,
        points: profile.monthly,
        months: null,
        reportedThrough: reported,
      };
    }
    case "district": {
      if (!args.district_no) return { error: "entity 'district' needs district_no." };
      const all = await getProductionTrend("districts", 4000, "monthly");
      const one = all.find((s) => s.key === args.district_no || s.label === args.district_no);
      if (!one) return { error: `No district ${args.district_no}.` };
      return { label: one.label, points: one.points, months: null, reportedThrough: reported };
    }
    case "statewide": {
      const all = await getProductionTrend("statewide", 4000, "monthly");
      const one = all[0];
      if (!one) return { error: "No statewide series in the mirror." };
      return { label: "Texas", points: one.points, months: null, reportedThrough: reported };
    }
  }
}

/**
 * Drop the cycles the RRC has not published yet.
 *
 * The single most consequential line in this file. Those cycles are zeros in the
 * mirror because nobody has filed, and every fit, trend and ratio computed
 * through them is wrong in the same direction.
 */
export function reportedOnly(points: readonly SeriesPoint[]): SeriesPoint[] {
  return points.filter((p) => p.reported);
}

/** One stream off a point. */
export function value(point: SeriesPoint, stream: Stream): number {
  return point[stream] ?? 0;
}

/** A stream as a plain array, unreported cycles removed. */
export function streamValues(
  points: readonly SeriesPoint[],
  stream: Stream
): { cycles: string[]; values: number[] } {
  const rows = reportedOnly(points);
  return {
    cycles: rows.map((p) => p.cycle),
    values: rows.map((p) => value(p, stream)),
  };
}

/**
 * Monthly volume to a daily rate.
 *
 * Decline math is a rate model, and a 28-day February against a 31-day January
 * is a 10% artefact nobody wants in a fitted `Di`.
 */
export function dailyRate(volume: number, cycle: string): number {
  const [y, m] = cycle.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return days > 0 ? volume / days : 0;
}
