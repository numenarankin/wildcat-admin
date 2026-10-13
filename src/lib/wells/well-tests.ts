import type { SupabaseClient } from "@supabase/supabase-js";
import { listReadingsByTank, type TankProduct, type TankReading } from "@/lib/tanks/tanks";
import { listTicketsByTank, type RunTicket } from "@/lib/tanks/run-tickets";
import { listReadingsByMeter, type MeterReading } from "@/lib/meters/meters";
import { swdMeterVolumeInWindow } from "@/lib/meters/swd-meters";
import {
  buildTankLevelSeries,
  deriveSegments,
  type Segment,
} from "@/lib/tanks/tank-series";
import {
  tankWindowVolume,
  wellTestRates,
  windowCoverage,
  type TankCoverage,
  type TestTankRole,
  thusFarVolumes,
  type ThusFar,
} from "@/lib/wells/well-test-derive";

/**
 * Well tests — the well-level rate check that drives BOTH the battery's oil split
 * and every water split, and feeds the Well Test Report.
 *
 * A test isolates ONE well to a tank over a clock span (`startAt` → `endAt`) while
 * the rest of the battery keeps producing into its other tank(s). It NAMES the
 * isolation tank and the control tank(s) and stores no levels of its own: both
 * rates are read from the standard tank reading series over the window (hauls
 * excluded) by `resolveWellTestVolumes`, so there is one source of truth for a
 * gauge and correcting a reading re-derives every test that spans it. Water comes
 * from the same window — node throughput when the test names a water meter/tank,
 * else the barrels the operator typed (most wells have nothing metering test
 * water). See `docs/plans/well-level-testing.md`.
 *
 * Nothing about a test is MEASURED at entry any more: the pumper gauges the
 * battery on the ordinary round, and the test declares a window over gauges that
 * already exist (`docs/plans/well-test-window-model.md`). A named tank that was
 * not gauged either side of the window measures nothing rather than zero, and
 * `coverage` says which tank that was.
 *
 * A test with NO isolation tank is document- or AI-sourced (ingest, `add_well_test`):
 * its stored `test_oil_bbls` / `test_gas_mcf` / `test_water_bbls` ARE the volumes.
 * One rule, applied in `resolveWellTestVolumes`: a node makes the volume derived,
 * no node makes the stored column the source.
 *
 * The per-day RATE (`volume / span-in-days`) is what allocation weights by, and
 * GOR / %oil / %water are DERIVED from the volumes (never stored — the ratios are
 * duration-invariant). The span is fractional, so a sub-day test reads an accurate
 * rate. The pure derivations here are dependency-free (types only) so they
 * unit-test without a database.
 *
 * Data-access follows the `@/lib/tanks/tanks` idiom: every helper takes the
 * caller's request-scoped RLS client (`getSupabaseServer()`) as its first
 * argument; the `well_tests` RLS policies scope reads/writes to the caller's
 * org. Never hand these the service-role admin client.
 */

/** Where a test's water was measured: a meter (normal) or a tank gauge. */
export interface WaterNodeRef {
  type: "meter" | "tank";
  id: string;
}

/** One rate test on a well. Volumes are TOTALS over the `startAt`→`endAt` span. */
export interface WellTest {
  id: string;
  wellId: string;
  /** ISO timestamp the test started (the open observation). */
  startAt: string;
  /**
   * ISO timestamp the test ended (rate basis = span in days), or null while the
   * test is still OPEN — the close observation hasn't been recorded. An open test
   * is not operative: it yields no rates and weights nothing.
   */
  endAt: string | null;
  /**
   * Calendar date the test completed (`YYYY-MM-DD`, from `endAt`; the start date
   * while open). Anchors "as of" / freshness selection and display; derived, not
   * separately entered.
   */
  testDate: string;
  /** Span in days (the rate basis), fractional; null while the test is open. */
  durationDays: number | null;
  /** The tank the tested well was routed to, or null (document-sourced test). */
  isolationTankId: string | null;
  /** The tank(s) carrying the rest of the battery's production during the test. */
  controlTankIds: string[];
  /** Where the water was measured, or null when the volume was typed in. */
  waterNode: WaterNodeRef | null;
  /**
   * Oil measured over the test, barrels, or null. Derived from the isolation
   * tank's series when the test names one, else the stored column.
   */
  oilBbls: number | null;
  /** Gas measured over the test, MCF, or null (never derived — gas is metered). */
  gasMcf: number | null;
  /** Water measured over the test, barrels, or null. Derived or typed (see above). */
  waterBbls: number | null;
  /**
   * Σ control-tank production over the window, barrels — the rest of the battery.
   * Null when the test names no control tank, so there is nothing to compare with.
   */
  controlBbls: number | null;
  /**
   * `oil ÷ (oil + control)`, 0–1 — this well's share of its battery over the test.
   * Null when not derivable. This is what the battery timeline pools.
   */
  frac: number | null;
  /** Days the well sat shut-in immediately before the test, or null. */
  preTestShutInDays: number | null;
  /** Free-text remarks, or "". */
  notes: string;
  /**
   * Per-tank coverage of the test window, filled by `resolveWellTestVolumes`.
   *
   * A test collects no gauges: it names tanks and a window, and the tanks' own
   * series supply the volumes. When a named tank was not gauged either side of
   * the window there is nothing to measure, and the volume comes back null. This
   * says WHICH tank, so the surface can name it instead of showing a blank rate.
   * Empty on a document-sourced test (it names no tanks) and on an open one.
   * Optional so a hand-built test (fixtures, the AI write path) need not carry
   * an annotation only the resolver produces; read it as `?? []`.
   */
  coverage?: TankCoverage[];
  /**
   * What an OPEN test has measured so far (`thusFarVolumes`), filled by
   * `resolveWellTestVolumes`; null on a closed test, a test naming no tank, or
   * one whose named tanks have not all been gauged since it started. Provisional
   * by construction: nothing else reads it, so an open test still weights
   * nothing.
   */
  thusFar?: ThusFar | null;
}

/** A well test as supplied by the UI, before it has a row id. */
export interface WellTestInput {
  /** ISO timestamp the test started. */
  startAt: string;
  /** ISO timestamp the test ended, or null/omitted to leave the test open. */
  endAt?: string | null;
  /** The tank the well was isolated to. */
  isolationTankId?: string | null;
  /** The tank(s) carrying the rest of the battery's production. */
  controlTankIds?: string[];
  /** Where the water was measured; omit for a typed `waterBbls`. */
  waterNode?: WaterNodeRef | null;
  oilBbls?: number | null;
  gasMcf?: number | null;
  waterBbls?: number | null;
  preTestShutInDays?: number | null;
  notes?: string;
}

// --- Derivations (pure) ----------------------------------------------------

/** Fractional days between two ISO timestamps, or null if unusable (span <= 0). */
export function spanDays(startAt: string, endAt: string): number | null {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = (end - start) / 86_400_000;
  return days > 0 ? days : null;
}

/**
 * Days basis for a test's rate — the fractional `startAt`→`endAt` span, falling
 * back to the (legacy) `durationDays`, then 1, when the timestamps are unusable.
 * An OPEN test (no `endAt`) has no basis: callers must treat its rates as absent.
 */
function basisDays(t: WellTest): number | null {
  if (t.endAt) {
    const span = spanDays(t.startAt, t.endAt);
    if (span != null) return span;
  }
  if (t.durationDays != null && Number.isFinite(t.durationDays) && t.durationDays > 0) {
    return t.durationDays;
  }
  return null;
}

/**
 * A test's per-day rate for a product: total volume ÷ duration. Oil / water are
 * barrels/day, gas is MCF/day. Returns 0 when the volume is missing (so a test
 * that didn't measure a stream contributes no weight for it).
 */
export function testRate(t: WellTest, product: TankProduct): number {
  const total =
    product === "water" ? t.waterBbls : product === "oil" ? t.oilBbls : null;
  if (total == null || !Number.isFinite(total)) return 0;
  const days = basisDays(t);
  if (days == null) return 0;
  return total / days;
}

/** Per-day gas rate (MCF/day) — gas has no `TankProduct`, so it's its own fn. */
export function testGasRate(t: WellTest): number {
  if (t.gasMcf == null || !Number.isFinite(t.gasMcf)) return 0;
  const days = basisDays(t);
  if (days == null) return 0;
  return t.gasMcf / days;
}

/**
 * A weighted-allocation stream: the tank products plus gas. Lets one weighting
 * core (`@/lib/tanks/weighted`) drive both tank oil/water and gas-meter splits.
 */
export type WeightProduct = TankProduct | "gas";

/** Per-day test rate for any weighted stream (bbl/day for oil/water, MCF/day gas). */
export function testRateFor(t: WellTest, product: WeightProduct): number {
  return product === "gas" ? testGasRate(t) : testRate(t, product);
}

/**
 * Gas–oil ratio (MCF per barrel of oil), or null when oil is zero / missing
 * (an undefined ratio, shown as "—" rather than infinity). Duration-invariant,
 * so it reads the same off totals or rates.
 */
export function gor(t: WellTest): number | null {
  const oil = t.oilBbls;
  if (oil == null || !Number.isFinite(oil) || oil <= 0) return null;
  const gas = t.gasMcf ?? 0;
  return gas / oil;
}

/**
 * Oil cut — oil as a percent of total liquid (oil + water), or null when there
 * is no liquid. `pctOil + pctWater === 100` whenever either is defined.
 */
export function pctOil(t: WellTest): number | null {
  const oil = t.oilBbls ?? 0;
  const water = t.waterBbls ?? 0;
  const liquid = oil + water;
  if (liquid <= 0) return null;
  return (oil / liquid) * 100;
}

/** Water cut — water as a percent of total liquid (oil + water), or null. */
export function pctWater(t: WellTest): number | null {
  const oil = t.oilBbls ?? 0;
  const water = t.waterBbls ?? 0;
  const liquid = oil + water;
  if (liquid <= 0) return null;
  return (water / liquid) * 100;
}

/**
 * The most recent test on or before `onDate`, or null. Independent of input
 * order. This is the test the weighted engine and the report treat as
 * "current" for a period (paired with a freshness check).
 */
export function latestTestAsOf(
  tests: WellTest[],
  onDate: string
): WellTest | null {
  let best: WellTest | null = null;
  for (const t of tests) {
    if (t.testDate > onDate) continue;
    if (!best || t.testDate >= best.testDate) best = t;
  }
  return best;
}

// --- Data-access -----------------------------------------------------------

type Sb = SupabaseClient;

const TEST_COLS =
  "id, well_id, start_at, end_at, test_date, duration_days, test_oil_bbls, " +
  "test_gas_mcf, test_water_bbls, pre_test_shut_in_days, notes, " +
  "isolation_tank_id, control_tank_ids, water_node_type, water_node_id";

interface WellTestRow {
  id: string;
  well_id: string;
  start_at: string | null;
  end_at: string | null;
  test_date: string;
  duration_days: number | null;
  test_oil_bbls: number | null;
  test_gas_mcf: number | null;
  test_water_bbls: number | null;
  pre_test_shut_in_days: number | null;
  notes: string | null;
  isolation_tank_id: string | null;
  control_tank_ids: string[] | null;
  water_node_type: string | null;
  water_node_id: string | null;
}

function mapTest(r: WellTestRow): WellTest {
  // Fall back to the legacy date column for rows written before the timestamp
  // migration reached this environment (the backfill fills them normally).
  const startAt = r.start_at ?? `${r.test_date}T00:00:00Z`;
  // A missing end_at with a legacy duration is a pre-timestamp row; synthesize its
  // end so its rate is unchanged. A missing end_at with NO duration is an OPEN
  // test — the close observation is still pending — and stays null.
  const endAt =
    r.end_at ??
    (r.duration_days != null && r.duration_days > 0
      ? new Date(
          Date.parse(startAt) + r.duration_days * 86_400_000
        ).toISOString()
      : null);
  const waterNode: WaterNodeRef | null =
    r.water_node_id && (r.water_node_type === "meter" || r.water_node_type === "tank")
      ? { type: r.water_node_type, id: r.water_node_id }
      : null;
  return {
    id: r.id,
    wellId: r.well_id,
    startAt,
    endAt,
    testDate: r.test_date ?? (endAt ?? startAt).slice(0, 10),
    durationDays: endAt ? spanDays(startAt, endAt) : null,
    isolationTankId: r.isolation_tank_id,
    controlTankIds: r.control_tank_ids ?? [],
    waterNode,
    oilBbls: r.test_oil_bbls,
    gasMcf: r.test_gas_mcf,
    waterBbls: r.test_water_bbls,
    // Filled by `resolveWellTestVolumes` for tests that name tanks; a
    // document-sourced test has no control tank and so no derivable share.
    controlBbls: null,
    frac: null,
    preTestShutInDays: r.pre_test_shut_in_days,
    notes: r.notes ?? "",
    coverage: [],
  };
}

function testRow(wellId: string, input: WellTestInput) {
  // Persist the timestamps plus the derived date/duration so the legacy
  // date-keyed columns stay consistent for any reader that still uses them. An
  // open test (no end) stores a null duration and dates from its start.
  const endAt = input.endAt || null;
  const testDate = (endAt ?? input.startAt).slice(0, 10);
  return {
    well_id: wellId,
    start_at: input.startAt,
    end_at: endAt,
    test_date: testDate,
    duration_days: endAt ? spanDays(input.startAt, endAt) : null,
    isolation_tank_id: input.isolationTankId ?? null,
    control_tank_ids: input.controlTankIds ?? [],
    water_node_type: input.waterNode?.type ?? null,
    water_node_id: input.waterNode?.id ?? null,
    test_oil_bbls: input.oilBbls ?? null,
    test_gas_mcf: input.gasMcf ?? null,
    test_water_bbls: input.waterBbls ?? null,
    pre_test_shut_in_days: input.preTestShutInDays ?? null,
    notes: input.notes?.trim() || null,
  };
}

/**
 * Fill each test's DERIVED volumes from the standard series — the single place the
 * "a node makes the volume derived, no node makes the stored column the source"
 * rule lives.
 *
 * For every test that names an isolation tank: the isolation and control volumes
 * come from those tanks' level series over the test window (hauls excluded), and
 * `frac = iso ÷ (iso + control)`. For every test that names a water node: the
 * water volume comes from that node's throughput over the same window, overriding
 * any typed value. Tests with neither keep their stored columns untouched.
 *
 * Batched by distinct tank / meter id, not per test: `listAllWellTests` is called
 * org-wide by revenue and the tank snapshot, so this must never be an N+1.
 */
/**
 * Per-entity readers a caller can supply so the test volumes resolve from
 * reads it has already batched. The cache layer passes its batched accessors;
 * without them the three bulk reads below are issued directly, which is the
 * right thing for a script or a single test page.
 */
export interface TestVolumeReaders {
  /**
   * `from` is the earliest day any test needs on that node (its first test's
   * start), so a reader that windows at the RPC reads from there, with the
   * anchor reading before it, rather than the node's whole history. A test's
   * volume is a window over the level series, and the series before the
   * anchor never enters it; on the real org this was three whole-history
   * reads of two tanks on every page that resolves tests.
   */
  tankReadings: (tankId: string, from?: string) => Promise<TankReading[]>;
  tankTickets: (tankId: string, from?: string) => Promise<RunTicket[]>;
  meterReadings: (meterId: string, from?: string) => Promise<MeterReading[]>;
}

export async function resolveWellTestVolumes(
  sb: Sb,
  tests: WellTest[],
  readers?: TestVolumeReaders
): Promise<WellTest[]> {
  const tankIds = new Set<string>();
  const waterMeterIds = new Set<string>();
  const waterTankIds = new Set<string>();
  for (const t of tests) {
    if (t.isolationTankId) tankIds.add(t.isolationTankId);
    for (const id of t.controlTankIds) tankIds.add(id);
    if (t.waterNode?.type === "meter") waterMeterIds.add(t.waterNode.id);
    if (t.waterNode?.type === "tank") waterTankIds.add(t.waterNode.id);
  }
  const allTankIds = [...new Set([...tankIds, ...waterTankIds])];
  if (allTankIds.length === 0 && waterMeterIds.size === 0) return tests;

  // The first day each node is asked about: its earliest test's start. The
  // level series is rebuilt from the windowed read's anchor, so nothing a test
  // measures can sit before it. See `TestVolumeReaders`.
  const firstDayByNode = new Map<string, string>();
  const need = (id: string | null | undefined, startAt: string) => {
    if (!id) return;
    const day = startAt.slice(0, 10);
    const cur = firstDayByNode.get(id);
    if (cur === undefined || day < cur) firstDayByNode.set(id, day);
  };
  for (const t of tests) {
    need(t.isolationTankId, t.startAt);
    for (const id of t.controlTankIds) need(id, t.startAt);
    need(t.waterNode?.id, t.startAt);
  }
  let earliest: string | undefined;
  for (const day of firstDayByNode.values()) {
    if (earliest === undefined || day < earliest) earliest = day;
  }

  const byId = async <T,>(ids: string[], read: (id: string, from?: string) => Promise<T[]>) => {
    const lists = await Promise.all(ids.map((id) => read(id, firstDayByNode.get(id))));
    return new Map(ids.map((id, i) => [id, lists[i]]));
  };
  const [readingsByTank, ticketsByTank, readingsByMeter] = await Promise.all([
    readers ? byId(allTankIds, readers.tankReadings) : listReadingsByTank(sb, allTankIds, earliest),
    readers ? byId(allTankIds, readers.tankTickets) : listTicketsByTank(sb, allTankIds, earliest),
    readers
      ? byId([...waterMeterIds], readers.meterReadings)
      : listReadingsByMeter(sb, [...waterMeterIds], earliest),
  ]);

  // One level series per tank, built once and reused by every test touching it.
  const segmentsByTank = new Map<string, Segment[]>();
  for (const id of allTankIds) {
    segmentsByTank.set(
      id,
      deriveSegments(
        buildTankLevelSeries(readingsByTank.get(id) ?? [], ticketsByTank.get(id) ?? [])
      )
    );
  }

  return tests.map((t) => {
    const isolationBbls = t.isolationTankId
      ? tankWindowVolume(
          segmentsByTank.get(t.isolationTankId) ?? [],
          t.startAt,
          t.endAt
        )
      : null;

    let controlBbls: number | null = null;
    if (t.isolationTankId && t.controlTankIds.length > 0) {
      controlBbls = 0;
      for (const id of t.controlTankIds) {
        const v = tankWindowVolume(segmentsByTank.get(id) ?? [], t.startAt, t.endAt);
        if (v == null) {
          controlBbls = null;
          break;
        }
        controlBbls += v;
      }
    }

    let waterBbls = t.waterBbls;
    if (t.waterNode && t.endAt) {
      const fromMs = Date.parse(t.startAt);
      const toMs = Date.parse(t.endAt);
      waterBbls =
        t.waterNode.type === "meter"
          ? swdMeterVolumeInWindow(
              readingsByMeter.get(t.waterNode.id) ?? [],
              fromMs,
              toMs
            )
          : tankWindowVolume(
              segmentsByTank.get(t.waterNode.id) ?? [],
              t.startAt,
              t.endAt
            );
    }

    const rates = wellTestRates(
      { startAt: t.startAt, endAt: t.endAt },
      { isolationBbls, controlBbls, waterBbls }
    );

    // Which named tanks could actually measure this window. A test that names no
    // tank (document / AI-sourced) reports nothing: its volumes are its own.
    const named: { tankId: string; role: TestTankRole; segments: Segment[] }[] = [];
    if (t.isolationTankId) {
      named.push({
        tankId: t.isolationTankId,
        role: "isolation",
        segments: segmentsByTank.get(t.isolationTankId) ?? [],
      });
      for (const id of t.controlTankIds) {
        named.push({
          tankId: id,
          role: "control",
          segments: segmentsByTank.get(id) ?? [],
        });
      }
    }
    if (t.waterNode?.type === "tank") {
      named.push({
        tankId: t.waterNode.id,
        role: "water",
        segments: segmentsByTank.get(t.waterNode.id) ?? [],
      });
    }

    const thusFar =
      t.endAt == null && t.isolationTankId
        ? thusFarVolumes(
            segmentsByTank.get(t.isolationTankId) ?? [],
            t.controlTankIds.map((id) => segmentsByTank.get(id) ?? []),
            t.startAt
          )
        : null;

    return {
      ...t,
      coverage: windowCoverage(named, t.startAt, t.endAt),
      thusFar,
      // A named isolation tank makes the series authoritative for oil; otherwise
      // the stored column stands (document / AI-sourced test).
      oilBbls: t.isolationTankId ? isolationBbls : t.oilBbls,
      waterBbls,
      controlBbls,
      frac: rates.frac,
    };
  });
}

/** A well's tests, most recent first, with derived volumes resolved. */
export async function listWellTests(
  sb: Sb,
  wellId: string
): Promise<WellTest[]> {
  const { data, error } = await sb
    .from("well_tests")
    .select(TEST_COLS)
    .eq("well_id", wellId)
    .order("start_at", { ascending: false });
  if (error) throw new Error(`listWellTests: ${error.message}`);
  return resolveWellTestVolumes(
    sb,
    ((data ?? []) as unknown as WellTestRow[]).map(mapTest)
  );
}

/** Tests for a set of wells, keyed by well id (each list newest-first). Powers
 * battery-level well tests (the battery's member wells) in one round trip. */
export async function listWellTestsByWell(
  sb: Sb,
  wellIds: string[]
): Promise<Map<string, WellTest[]>> {
  const out = new Map<string, WellTest[]>();
  const ids = [...new Set(wellIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await sb
    .from("well_tests")
    .select(TEST_COLS)
    .in("well_id", ids)
    .order("start_at", { ascending: false });
  if (error) throw new Error(`listWellTestsByWell: ${error.message}`);
  const resolved = await resolveWellTestVolumes(
    sb,
    ((data ?? []) as unknown as WellTestRow[]).map(mapTest)
  );
  for (const t of resolved) {
    const list = out.get(t.wellId);
    if (list) list.push(t);
    else out.set(t.wellId, [t]);
  }
  return out;
}

/** Every well test in the org (for the Well Test Report), newest first. */
export async function listAllWellTests(
  sb: Sb,
  readers?: TestVolumeReaders
): Promise<WellTest[]> {
  const { data, error } = await sb
    .from("well_tests")
    .select(TEST_COLS)
    .order("start_at", { ascending: false });
  if (error) throw new Error(`listAllWellTests: ${error.message}`);
  return resolveWellTestVolumes(
    sb,
    ((data ?? []) as unknown as WellTestRow[]).map(mapTest),
    readers
  );
}

/**
 * Every operative well test as a battery-timeline sample — well, end date, derived
 * share. Only tests that named an isolation tank and resolved a `frac` count; open
 * and document-sourced tests contribute nothing to the oil split.
 */
export async function listWellTestFracs(
  sb: Sb,
  /** The org's tests when the caller already holds them (`cachedWellTests`);
   *  the fracs pool and the water pool used to each read and resolve the whole
   *  table, and resolving means three bulk reading loads. */
  have?: WellTest[]
): Promise<
  { wellId: string; endDate: string; frac: number | null; testId: string }[]
> {
  const tests = have ?? (await listAllWellTests(sb));
  return tests
    .filter((t) => t.frac != null && t.endAt)
    .map((t) => ({
      wellId: t.wellId,
      endDate: (t.endAt as string).slice(0, 10),
      frac: t.frac,
      testId: t.id,
    }));
}

/**
 * Every operative well test's WATER rate (bbl/day), keyed by well — the pool the
 * node water splits resolve from. A test counts once it has a closed window and a
 * water volume, whether that came from a metered node or was typed in.
 */
export async function listWellTestWaterRates(
  sb: Sb,
  have?: WellTest[]
): Promise<
  {
    wellId: string;
    date: string;
    endAt: string;
    waterBbls: number;
    intervalDays: number;
  }[]
> {
  const tests = have ?? (await listAllWellTests(sb));
  const out: {
    wellId: string;
    date: string;
    endAt: string;
    waterBbls: number;
    intervalDays: number;
  }[] = [];
  for (const t of tests) {
    if (!t.endAt || t.waterBbls == null || t.durationDays == null) continue;
    if (!(t.durationDays > 0)) continue;
    out.push({
      wellId: t.wellId,
      date: t.endAt.slice(0, 10),
      endAt: t.endAt,
      waterBbls: t.waterBbls,
      intervalDays: t.durationDays,
    });
  }
  return out;
}

/** Record a well test; returns the new row id. */
export async function addWellTest(
  sb: Sb,
  wellId: string,
  input: WellTestInput
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("well_tests")
    .insert(testRow(wellId, input))
    .select("id")
    .single();
  if (error) throw new Error(`addWellTest: ${error.message}`);
  return { id: data.id };
}

/** Update a well test, scoped to its well. */
export async function updateWellTest(
  sb: Sb,
  wellId: string,
  id: string,
  input: WellTestInput
): Promise<void> {
  const { error } = await sb
    .from("well_tests")
    .update(testRow(wellId, input))
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`updateWellTest: ${error.message}`);
}

/** Delete a well test, scoped to its well. */
export async function deleteWellTest(
  sb: Sb,
  wellId: string,
  id: string
): Promise<void> {
  const { error } = await sb
    .from("well_tests")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`deleteWellTest: ${error.message}`);
}
