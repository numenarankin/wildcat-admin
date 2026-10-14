import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getWellPricingOrNull } from "@/lib/billing/stripe-pricing";
import { getOperatorCounties, getOperatorsLast12 } from "@/lib/scout/queries";
import { SCOUT_OPERATORS_PATH } from "@/lib/scout/data-files";
import type { OperatorPoint } from "@/lib/scout/types";
import type { CommodityPrices } from "@/lib/analytics/types";
import { countyAt, type CountyFeature } from "@/lib/admin/county-at";
import { targetRow, type TargetLive, type TargetRow } from "@/lib/admin/target-types";

/**
 * Prospecting targets (`admin_targets`), for /prospecting > Targets.
 *
 * Request-scoped client: the table's policy is `is_platform_admin()`
 * (migration 2026100800300). The stored row is only the operator's identity;
 * its well counts come from the synced operator points and its production
 * from the RRC mirror, read here at render time.
 */

interface TargetDbRow {
  operator_no: number;
  name: string;
  city: string | null;
  state: string | null;
  created_at: string;
}

// The operator points file, held per server instance and re-read when the
// sync script rewrites it (keyed on mtime, like /api/scout/operators).
let pointsCache: { mtimeMs: number; byNo: Map<number, OperatorPoint> } | null = null;

export async function operatorPoints(): Promise<Map<number, OperatorPoint>> {
  try {
    const { mtimeMs } = await stat(SCOUT_OPERATORS_PATH);
    if (pointsCache && pointsCache.mtimeMs === mtimeMs) return pointsCache.byNo;
    const points = JSON.parse(await readFile(SCOUT_OPERATORS_PATH, "utf8")) as OperatorPoint[];
    const byNo = new Map(points.map((p) => [p.n, p]));
    pointsCache = { mtimeMs, byNo };
    return byNo;
  } catch (err) {
    console.error("[targets] operator points unavailable", err instanceof Error ? err.message : err);
    return new Map();
  }
}

// Texas county outlines, for placing each HQ in its county. Read once per
// server instance; traced into the deploy by next.config.ts.
const COUNTIES_PATH = path.join(process.cwd(), "public", "tx-counties.json");
let countyFeatures: Promise<CountyFeature[]> | null = null;

function texasCounties(): Promise<CountyFeature[]> {
  countyFeatures ??= readFile(COUNTIES_PATH, "utf8")
    .then((s) => (JSON.parse(s) as { features: CountyFeature[] }).features)
    .catch((err: unknown) => {
      countyFeatures = null;
      console.error("[targets] county outlines unavailable", err instanceof Error ? err.message : err);
      return [];
    });
  return countyFeatures;
}

/** The operator numbers on the list, without their live figures. */
export async function getTargetNumbers(): Promise<Set<number>> {
  if (!hasSupabase()) return new Set();
  const sb = await getSupabaseServer();
  const { data, error } = await sb.from("admin_targets").select("operator_no");
  if (error) throw new Error(`getTargetNumbers: ${error.message}`);
  return new Set(((data ?? []) as { operator_no: number }[]).map((r) => r.operator_no));
}

/** Every target, newest first, with its live figures. */
export async function getTargets(prices: CommodityPrices): Promise<TargetRow[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_targets")
    .select("operator_no, name, city, state, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getTargets: ${error.message}`);
  const rows = (data ?? []) as TargetDbRow[];
  if (rows.length === 0) return [];

  const nums = rows.map((r) => r.operator_no);
  const [points, production, counties, pricing, outlines] = await Promise.all([
    operatorPoints(),
    getOperatorsLast12(nums).catch((err: unknown) => {
      console.error("[targets] production unavailable", err instanceof Error ? err.message : err);
      return new Map<number, { oil: number; gas: number; months: number }>();
    }),
    getOperatorCounties(nums).catch((err: unknown) => {
      console.error("[targets] counties unavailable", err instanceof Error ? err.message : err);
      return new Map<number, number[]>();
    }),
    getWellPricingOrNull(),
    texasCounties(),
  ]);

  return rows.map((r) => {
    const pt = points.get(r.operator_no);
    const placed = pt && Number.isFinite(pt.lng) && Number.isFinite(pt.lat);
    const live: TargetLive = {
      wells: pt ? { total: pt.w, active: pt.wa ?? pt.w } : undefined,
      address: pt?.a || null,
      position:
        pt && Number.isFinite(pt.lng) && Number.isFinite(pt.lat) ? { lng: pt.lng, lat: pt.lat } : undefined,
      production: production.get(r.operator_no),
      countyCodes: counties.get(r.operator_no),
      hqCountyCode: placed ? countyAt(pt.lng, pt.lat, outlines) : null,
    };
    return targetRow(
      { operatorNo: r.operator_no, name: r.name, city: r.city, state: r.state, createdAt: r.created_at },
      live,
      prices,
      pricing
    );
  });
}

/** One target with its live figures, or null when it is not on the list. */
export async function getTarget(operatorNo: number, prices: CommodityPrices): Promise<TargetRow | null> {
  const rows = await getTargets(prices);
  return rows.find((r) => r.operatorNo === operatorNo) ?? null;
}
