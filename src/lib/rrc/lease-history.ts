import "server-only";

import { hasRrcDb } from "@/lib/scout/rrc-db";
import type { RrcLeaseKey } from "@/lib/rrc/link";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { memo } from "@/lib/cache/request-cache";
import { cachedWells } from "@/lib/wells/wells";
import {
  apiDigits,
  loadRecordSlices,
  mergeMonths,
  monthlyForKey,
  ownedMonths,
  sliceKey,
  type RecordSlice,
} from "./record-split";
import {
  expandMonthlyToDaily,
  type LeaseHistorySeries,
  type RrcMonth,
} from "./lease-history-series";

/**
 * The state's production history for one of our leases, as a daily series.
 *
 * A new account's charts are empty until the operator has entered a month or two
 * of tank readings, while Texas has been publishing that lease's production for
 * decades. This reads the public record and hands it to the chart so the graph
 * opens with the lease's actual history behind it.
 *
 * ## Strictly for display
 *
 * These are the state's monthly numbers spread flat across their days — an
 * estimate of a rate, not a measurement. Revenue comes from settlement
 * statements, and produced volumes come from the operator's own tanks; neither
 * may read this. The one place it earns influence beyond drawing a line is the
 * decline fit, where decades of real history is exactly the input an Arps curve
 * wants. See `src/app/leases/[lease]/page.tsx` for where the two are joined.
 *
 * Returns an empty series for every "no" — setting off, mirror unconfigured,
 * lease not identified in the public record, nothing reported. A missing history
 * is a chart that starts later, never an error on the page.
 */
export const EMPTY_HISTORY: LeaseHistorySeries = { oil: [], gas: [] };

/** Log prefix, so every reason this feature shows nothing is greppable. */
const LOG = "[rrc-history]";

/**
 * The lease's records, cut from the FLEET's.
 *
 * One `loadRecordSlices` over every API the org holds, memoized per request
 * and cached an hour per process, is the same read `/production`'s fleet-rate
 * path makes; this page used to resolve each lease on its own (a stored-key
 * read, a wells read, a wellbore lookup, then the slice build again) which was
 * four dependent round trips per lease. A lease's slice is the fleet's slice
 * with `ourWellNos` narrowed to that lease's wells: the denominator (every well
 * on the record) and the W-10 tests are the record's and do not change.
 */
async function leaseRecordSlices(
  sb: Awaited<ReturnType<typeof getRequestSupabase>>,
  leaseId: string,
  scope: RrcScope
): Promise<RecordSlice[]> {
  const wells = await cachedWells(sb);
  const mine = new Set(
    wells
      .filter((w) => w.leaseId === leaseId)
      .map((w) => apiDigits(w.apiWellNo))
      .filter((a): a is string => !!a)
  );
  if (mine.size === 0) return [];
  // Whole-history months, prefetched as each record is found: that is the
  // key `ownedMonths` reads below.
  const fleet =
    scope === "fleet"
      ? await memo(sb, "rrc-fleet-slices", () =>
          loadRecordSlices(
            wells.map((w) => w.apiWellNo),
            { months: {} }
          )
        )
      : // Only this lease's wells: the same records, the same denominator
        // (every well on each record comes from `wellbore`, not from us), one
        // or two production reads instead of the fleet's.
        await loadRecordSlices([...mine], { months: {} });
  const out: RecordSlice[] = [];
  for (const s of fleet) {
    const ours = Object.entries(s.wellNoByApi).filter(([api]) => mine.has(api));
    if (ours.length === 0) continue;
    out.push({
      ...s,
      ourWellNos: [...new Set(ours.map(([, wellNo]) => wellNo))],
      wellNoByApi: Object.fromEntries(ours),
    });
  }
  return out;
}

/** Every lease's stored (human-confirmed) key, one read for the org. */
function storedLeaseKeys(sb: Awaited<ReturnType<typeof getRequestSupabase>>) {
  return memo(sb, "lease-rrc-keys", async () => {
    const out = new Map<string, RrcLeaseKey>();
    const { data, error } = await sb
      .from("leases")
      .select("id, rrc_lease_no, rrc_district, rrc_oil_gas_code");
    if (error) {
      // Same distinction `getStoredLeaseKey` draws: "no key" vs "no column".
      console.warn(
        `storedLeaseKeys failed (${error.code}: ${error.message})` +
          (error.code === "42703"
            ? " — 2026080800900_lease_rrc_identity.sql has not been applied; run: supabase db push"
            : "")
      );
      return out;
    }
    for (const r of (data ?? []) as {
      id: string;
      rrc_lease_no: string | null;
      rrc_district: string | null;
      rrc_oil_gas_code: string | null;
    }[]) {
      if (!r.rrc_lease_no || !r.rrc_district || !r.rrc_oil_gas_code) continue;
      out.set(r.id, {
        oilGasCode: r.rrc_oil_gas_code as "O" | "G",
        districtNo: r.rrc_district,
        leaseNo: r.rrc_lease_no,
      });
    }
    return out;
  });
}

/**
 * The records this lease is read from, stored key first, then the records its
 * wells sit on by how many of them sit there. The same order and the same
 * records `resolveLeaseKeys` derives, without its per-lease reads.
 */
function leaseKeys(
  stored: RrcLeaseKey | undefined,
  slices: RecordSlice[]
): RrcLeaseKey[] {
  const keys: RrcLeaseKey[] = [];
  const seen = new Set<string>();
  const add = (k: RrcLeaseKey) => {
    const id = `${k.oilGasCode}/${k.districtNo}/${k.leaseNo}`;
    if (seen.has(id)) return;
    seen.add(id);
    keys.push(k);
  };
  if (stored) add(stored);
  for (const s of [...slices].sort((a, b) => b.ourWellNos.length - a.ourWellNos.length)) {
    add(sliceKey(s));
  }
  return keys;
}

/**
 * Records reached only through the lease's STORED RRC number, with none of their
 * wells matched to ours, are read unscaled. We have no evidence we own less than
 * all of one, and shrinking a working chart on no evidence is the worse error.
 */
async function monthlyForLease(
  leaseId: string,
  keys: RrcLeaseKey[],
  slices: RecordSlice[]
): Promise<RrcMonth[]> {
  // Anything `leaseKeys` holds that no slice covers — in practice the stored
  // key when it names a record none of our wells sit on. Read whole, so this
  // can only ever subtract production we do not own, never lose a record we
  // were already showing.
  const covered = new Set(
    slices.map((s) => `${s.oilGasCode}/${s.pdqDistrict}/${s.leaseNo}`)
  );
  const extra = keys.filter(
    (k) => !covered.has(`${k.oilGasCode}/${k.districtNo}/${k.leaseNo}`)
  );

  const [owned, unscaled] = await Promise.all([
    Promise.all(slices.map(ownedMonths)),
    Promise.all(extra.map((k) => monthlyForKey(k))),
  ]);

  for (const s of slices) {
    if (s.ourWellNos.length < s.wells.length) {
      console.info(
        `${LOG} ${leaseId}: ${s.oilGasCode}/${s.district}/${s.leaseNo} has ` +
          `${s.wells.length} wells on the state's record and we hold ` +
          `${s.ourWellNos.length}; the chart shows our share of it`
      );
    }
  }
  return mergeMonths([...owned, ...unscaled]);
}

/** A lease's public record, loaded but not yet cut against its own data. */
export interface LeaseRrcMonths {
  months: RrcMonth[];
  /** `O/08/12345 + G/08/234567`, for the log line. */
  keyText: string;
}

/**
 * Load the lease's public-record months. Null, with the reason logged, when
 * there is nothing to show.
 *
 * Split from the cut (`leaseRrcSeries`) so a caller can START this beside the
 * lease's own series and apply the boundary once both are in hand. The
 * boundary is the operator's first measured day, which only the series know;
 * awaiting them first put the whole RRC read after the whole Supabase read.
 */
/**
 * Which records to load a lease's history from.
 *
 * `fleet`: one `loadRecordSlices` over every API the org holds, memoized per
 * request and cached an hour per process, then cut to the lease. The list
 * page reads every lease and this is one read for all of them. `lease`: only
 * this lease's wells' records. A detail page reads one lease, and the fleet
 * path costs it one `lease_production` read PER RECORD IN THE ORG (14 on the
 * harness fleet, ~275ms each on the mirror) for the one or two it draws.
 */
export type RrcScope = "fleet" | "lease";

export async function leaseRrcMonths(
  leaseId: string,
  opts: { scope?: RrcScope } = {}
): Promise<LeaseRrcMonths | null> {
  if (!hasRrcDb()) {
    console.warn(`${LOG} ${leaseId}: no history — RRC_DATABASE_URL is not set`);
    return null;
  }
  try {
    const sb = await getRequestSupabase();
    // The stored-key read has no dependency on the record, so it goes out in
    // the same tick as the wells roster rather than after the slices.
    const stored = storedLeaseKeys(sb);
    const slices = await leaseRecordSlices(sb, leaseId, opts.scope ?? "fleet");
    const keys = leaseKeys((await stored).get(leaseId), slices);
    if (keys.length === 0) {
      // By far the most common reason for an empty chart, and previously a
      // silent one: the lease has no identity in the public record, either
      // because it predates the import writing one or because the columns that
      // hold it were never migrated.
      console.warn(
        `${LOG} ${leaseId}: no history — could not resolve an RRC lease key. ` +
          `No key stored on the lease, and none of its wells carry an API ` +
          `number that is on a current P-5 schedule.`
      );
      return null;
    }

    const months = await monthlyForLease(leaseId, keys, slices);
    const keyText = keys
      .map((k) => `${k.oilGasCode}/${k.districtNo}/${k.leaseNo}`)
      .join(" + ");
    if (months.length === 0) {
      console.warn(
        `${LOG} ${leaseId}: no history — rrc.lease_production has no rows for ${keyText}`
      );
      return null;
    }
    return { months, keyText };
  } catch (error) {
    // The chart simply starts where the operator's own data starts.
    console.error(`${LOG} ${leaseId}: failed`, error);
    return null;
  }
}

/**
 * Cut loaded months to end before `before`.
 *
 * `before` is the operator's earliest own production date (null when they have
 * recorded none), so the two series meet exactly once and never overlap.
 */
export function leaseRrcSeries(
  leaseId: string,
  loaded: LeaseRrcMonths | null,
  before: string | null
): LeaseHistorySeries {
  if (!loaded) return EMPTY_HISTORY;
  const { months, keyText } = loaded;
  const series = expandMonthlyToDaily(months, before);
  console.info(
    `${LOG} ${leaseId} (${keyText}): ${months.length} months ` +
      `${months[0].cycle.slice(0, 7)}..${months[months.length - 1].cycle.slice(0, 7)} → ` +
      `${series.oil.length} oil / ${series.gas.length} gas daily points, ` +
      `cut before ${before ?? "(nothing measured yet — full history)"}`
  );
  return series;
}

/** The lease's public-record history, cut to end before `before`. */
export async function leaseRrcHistory(
  leaseId: string,
  before: string | null
): Promise<LeaseHistorySeries> {
  return leaseRrcSeries(leaseId, await leaseRrcMonths(leaseId), before);
}
