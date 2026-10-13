import type { SupabaseClient } from "@supabase/supabase-js";
import type { GasCampaign } from "@/lib/meters/gas-campaign";
import { gasWindowVolume } from "@/lib/meters/gas-series";
import { listMeterReadings } from "@/lib/meters/meters";

/**
 * Gas-meter well-test campaign data-access — the gas analogue of the battery's
 * campaign layer. A campaign is a set of meter measurements: one BASELINE (all
 * wells online) plus one SHUT-IN per tested well (that well off, the rest on).
 * The per-well split is DERIVED on read from the subtractive fractions (see
 * `@/lib/meters/gas-campaign`). Same client-injected RLS idiom as the rest of
 * `@/lib/meters`: every helper takes the request-scoped client; the
 * `gas_test_campaigns` / `gas_test_measurements` policies scope reads/writes.
 */

type Sb = SupabaseClient;

/** One meter reading in a campaign (baseline or a single well shut in). */
export interface GasTestMeasurement {
  id: string;
  campaignId: string;
  role: "baseline" | "shutin";
  /** The well shut in for this reading; null for the baseline. */
  shutInWellId: string | null;
  /** ISO timestamp the reading window began. */
  startAt: string;
  /** ISO timestamp the reading window ended. */
  endAt: string;
  /**
   * Meter rate over the window (MCF/day), RESOLVED.
   *
   * Derived from the meter's own readings across the window whenever its counter
   * brackets them, so correcting a reading moves the campaign's split with it,
   * the same way correcting a gauge moves a well test. The stored column stands
   * only when the series cannot measure the window: a rate read off a chart, or
   * a meter nobody has entered a counter for.
   */
  mcfPerDay: number;
  /** True when `mcfPerDay` came from the meter series rather than the column.
   *  Optional so a hand-built measurement (fixtures, the create path) need not
   *  carry an annotation only the loader produces. */
  derived?: boolean;
  /**
   * What the meter was making with every well online, MCF/day, for a SHUT-IN.
   *
   * Not entered. The meter was being read before the well was shut in, so the
   * baseline is the rate it made over the window immediately BEFORE this one,
   * read off the same series. Null when that stretch is not covered by the
   * counter, which is the one way a gas test fails to derive. A campaign written
   * under the old model carries its own baseline measurement, and that one wins:
   * it is what the pumper actually measured.
   */
  baselineMcfPerDay?: number | null;
}

/** A campaign with its measurements; `effectiveFrom` is derived, never stored. */
export interface GasTestCampaign {
  id: string;
  meterId: string;
  notes: string;
  createdAt: string;
  /** When the campaign was PUBLISHED (made operative), or null while a draft. A
   * draft is saved but does not affect allocation until it is published. */
  publishedAt: string | null;
  /** min(measurement.startAt) as an ISO `YYYY-MM-DD` date; "" when empty. */
  effectiveFrom: string;
  measurements: GasTestMeasurement[];
}

/** A measurement window + rate as the campaign modal supplies it. */
export interface GasMeasurementInput {
  startAt: string;
  endAt: string;
  mcfPerDay: number;
}

/** Everything needed to create a campaign: one baseline + the shut-in readings. */
export interface GasCampaignInput {
  notes?: string;
  baseline: GasMeasurementInput;
  shutIns: (GasMeasurementInput & { wellId: string })[];
}

interface CampaignRow {
  id: string;
  meter_id: string;
  notes: string | null;
  created_at: string;
  published_at: string | null;
}

interface MeasurementRow {
  id: string;
  campaign_id: string;
  role: string;
  shut_in_well_id: string | null;
  start_at: string;
  end_at: string;
  mcf_per_day: number | null;
}

function mapMeasurement(r: MeasurementRow): GasTestMeasurement {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    role: r.role === "baseline" ? "baseline" : "shutin",
    shutInWellId: r.shut_in_well_id ?? null,
    startAt: r.start_at,
    endAt: r.end_at,
    mcfPerDay: r.mcf_per_day ?? 0,
    derived: false,
  };
}

/** A meter reading, as the window math wants it. */
type SeriesReading = {
  date: string;
  time: string;
  mcf: number | null;
  cumulativeMcf: number | null;
};

/** MCF/day the meter made over a window, or null when the counter misses it. */
function windowRate(
  readings: SeriesReading[],
  fromMs: number,
  toMs: number
): number | null {
  const days = (toMs - fromMs) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) return null;
  const mcf = gasWindowVolume(
    readings.map((r) => ({
      date: r.date,
      time: r.time,
      mcf: r.mcf,
      cumulativeMcf: r.cumulativeMcf,
    })),
    fromMs,
    toMs
  );
  return mcf == null ? null : mcf / days;
}

/**
 * One measurement's rates re-read from the meter series.
 *
 * The measured rate comes from the measurement's own window; the stored column
 * stands only when the series cannot measure it (a rate read off a chart, or a
 * meter with no counter). A shut-in also gets its BASELINE from the equal-length
 * window immediately before it: what the meter was making with the well still
 * on. That is the comparison the test is, and nobody has to type it.
 */
function resolveRate(
  m: GasTestMeasurement,
  readings: SeriesReading[],
  storedBaseline: number | null
): GasTestMeasurement {
  const fromMs = Date.parse(m.startAt);
  const toMs = Date.parse(m.endAt);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return m;

  const measured = windowRate(readings, fromMs, toMs);
  const out: GasTestMeasurement = {
    ...m,
    ...(measured == null ? {} : { mcfPerDay: measured, derived: true }),
  };
  if (m.role !== "shutin") return out;

  // The campaign's own baseline measurement wins when it has one: an old
  // campaign was measured that way and must keep reading as it did.
  out.baselineMcfPerDay =
    storedBaseline ?? windowRate(readings, fromMs - (toMs - fromMs), fromMs);
  return out;
}

/** Earliest measurement start as an ISO date, or "" when there are none. */
function deriveEffectiveFrom(measurements: GasTestMeasurement[]): string {
  const dates = measurements
    .map((m) => (m.startAt ? m.startAt.slice(0, 10) : ""))
    .filter(Boolean)
    .sort();
  return dates[0] ?? "";
}

/** A campaign's measurements as the pure share math consumes them. */
export function campaignToGasCampaign(campaign: GasTestCampaign): GasCampaign {
  const baseline = campaign.measurements.find((m) => m.role === "baseline");
  const shutIns = campaign.measurements
    .filter((m) => m.role === "shutin" && m.shutInWellId)
    .map((m) => ({ wellId: m.shutInWellId as string, rate: m.mcfPerDay }));
  return { baselineRate: baseline?.mcfPerDay ?? 0, shutIns };
}

/**
 * Campaigns for MANY meters in two reads, grouped by meter, newest first.
 *
 * `listMeterCampaigns` costs three round trips per meter (campaigns,
 * measurements, the meter's readings). A fleet-wide derivation calls it once per
 * gas meter, which was `gas_test_campaigns` 14x on one render. This issues one
 * campaign read and one measurement read for the whole set, and takes the
 * readings from `readingsFor` so a caller that has already bulk-loaded them
 * (the cache layer) supplies them without a third query.
 *
 * The rate resolution is the same code as the per-meter path (`resolveRate`,
 * `deriveEffectiveFrom`), so a campaign reads identically whichever way it was
 * loaded. Meters with no campaigns are present with an empty list.
 */
export async function listMeterCampaignsForMeters(
  sb: Sb,
  meterIds: string[],
  readingsFor: (meterId: string) => Promise<SeriesReading[]>
): Promise<Map<string, GasTestCampaign[]>> {
  const out = new Map<string, GasTestCampaign[]>();
  const ids = [...new Set(meterIds.filter(Boolean))];
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;

  const { data: campaigns, error } = await sb
    .from("gas_test_campaigns")
    .select("id, meter_id, notes, created_at, published_at")
    .in("meter_id", ids)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listMeterCampaignsForMeters: ${error.message}`);
  const rows = (campaigns ?? []) as CampaignRow[];
  if (rows.length === 0) return out;

  const { data: measurements, error: mErr } = await sb
    .from("gas_test_measurements")
    .select("id, campaign_id, role, shut_in_well_id, start_at, end_at, mcf_per_day")
    .in(
      "campaign_id",
      rows.map((r) => r.id)
    )
    .order("start_at", { ascending: true });
  if (mErr) throw new Error(`listMeterCampaignsForMeters (measurements): ${mErr.message}`);

  const byCampaign = new Map<string, GasTestMeasurement[]>();
  for (const m of (measurements ?? []) as MeasurementRow[]) {
    const mapped = mapMeasurement(m);
    (byCampaign.get(mapped.campaignId) ??
      byCampaign.set(mapped.campaignId, []).get(mapped.campaignId)!).push(mapped);
  }

  // Readings once per meter that has a campaign, not once per campaign.
  const metersWithCampaigns = [...new Set(rows.map((r) => r.meter_id))];
  const readingsByMeter = new Map<string, SeriesReading[]>();
  await Promise.all(
    metersWithCampaigns.map(async (id) => {
      readingsByMeter.set(id, await readingsFor(id));
    })
  );

  for (const r of rows) {
    const readings = readingsByMeter.get(r.meter_id) ?? [];
    const raw = byCampaign.get(r.id) ?? [];
    const stored = raw.find((m) => m.role === "baseline");
    const storedRate = stored ? resolveRate(stored, readings, null).mcfPerDay : null;
    const ms = raw.map((m) => resolveRate(m, readings, storedRate));
    out.get(r.meter_id)?.push({
      id: r.id,
      meterId: r.meter_id,
      notes: r.notes ?? "",
      createdAt: r.created_at,
      publishedAt: r.published_at,
      effectiveFrom: deriveEffectiveFrom(ms),
      measurements: ms,
    });
  }
  return out;
}

/** A meter's campaigns (with measurements), newest campaign first. */
export async function listMeterCampaigns(
  sb: Sb,
  meterId: string
): Promise<GasTestCampaign[]> {
  const { data: campaigns, error } = await sb
    .from("gas_test_campaigns")
    .select("id, meter_id, notes, created_at, published_at")
    .eq("meter_id", meterId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listMeterCampaigns: ${error.message}`);
  const rows = (campaigns ?? []) as CampaignRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: measurements, error: mErr } = await sb
    .from("gas_test_measurements")
    .select("id, campaign_id, role, shut_in_well_id, start_at, end_at, mcf_per_day")
    .in("campaign_id", ids)
    .order("start_at", { ascending: true });
  if (mErr) throw new Error(`listMeterCampaigns (measurements): ${mErr.message}`);

  const byCampaign = new Map<string, GasTestMeasurement[]>();
  for (const m of (measurements ?? []) as MeasurementRow[]) {
    const mapped = mapMeasurement(m);
    (byCampaign.get(mapped.campaignId) ??
      byCampaign.set(mapped.campaignId, []).get(mapped.campaignId)!).push(mapped);
  }

  // One read of the meter's series for every campaign on it: the rates are
  // derived from it, and a per-measurement read would be an N+1 over the meter.
  const readings = await listMeterReadings(sb, meterId);

  return rows.map((r) => {
    const raw = byCampaign.get(r.id) ?? [];
    const stored = raw.find((m) => m.role === "baseline");
    const storedRate = stored ? resolveRate(stored, readings, null).mcfPerDay : null;
    const ms = raw.map((m) => resolveRate(m, readings, storedRate));
    return {
      id: r.id,
      meterId: r.meter_id,
      notes: r.notes ?? "",
      createdAt: r.created_at,
      publishedAt: r.published_at,
      effectiveFrom: deriveEffectiveFrom(ms),
      measurements: ms,
    };
  });
}

/**
 * Create a gas campaign on a meter: one baseline measurement + one shut-in per
 * tested well. Exactly one baseline is enforced here (the write path), not by a
 * DB constraint. `org_id` comes from the RLS default. Returns the campaign id.
 */
export async function createGasCampaign(
  sb: Sb,
  meterId: string,
  input: GasCampaignInput
): Promise<{ id: string }> {
  // New campaigns start as DRAFTS (published_at null); publishing is a separate
  // step, so saving here never touches allocation.
  const { data: campaign, error } = await sb
    .from("gas_test_campaigns")
    .insert({ meter_id: meterId, notes: input.notes || null })
    .select("id")
    .single();
  if (error) throw new Error(`createGasCampaign: ${error.message}`);
  const campaignId = campaign.id as string;

  const { error: mErr } = await sb
    .from("gas_test_measurements")
    .insert(measurementPayload(campaignId, input));
  if (mErr) {
    // Roll back the orphaned campaign header so a partial write leaves nothing.
    await sb.from("gas_test_campaigns").delete().eq("id", campaignId);
    throw new Error(`createGasCampaign (measurements): ${mErr.message}`);
  }
  return { id: campaignId };
}

/** The `gas_test_measurements` insert payload (baseline + shut-ins) for a campaign. */
function measurementPayload(campaignId: string, input: GasCampaignInput) {
  return [
    {
      campaign_id: campaignId,
      role: "baseline",
      shut_in_well_id: null,
      start_at: input.baseline.startAt,
      end_at: input.baseline.endAt,
      mcf_per_day: input.baseline.mcfPerDay,
    },
    ...input.shutIns
      .filter((s) => s.wellId)
      .map((s) => ({
        campaign_id: campaignId,
        role: "shutin",
        shut_in_well_id: s.wellId,
        start_at: s.startAt,
        end_at: s.endAt,
        mcf_per_day: s.mcfPerDay,
      })),
  ];
}

/**
 * Replace a draft campaign's measurements (and notes) with a new set — the pumper
 * editing a saved draft. Deletes the old measurements, then inserts the new ones.
 * Does not change `published_at`.
 */
export async function updateGasCampaign(
  sb: Sb,
  campaignId: string,
  input: GasCampaignInput
): Promise<void> {
  const upd = await sb
    .from("gas_test_campaigns")
    .update({ notes: input.notes || null })
    .eq("id", campaignId);
  if (upd.error) throw new Error(`updateGasCampaign: ${upd.error.message}`);

  const del = await sb
    .from("gas_test_measurements")
    .delete()
    .eq("campaign_id", campaignId);
  if (del.error) throw new Error(`updateGasCampaign (clear): ${del.error.message}`);

  const { error } = await sb
    .from("gas_test_measurements")
    .insert(measurementPayload(campaignId, input));
  if (error) throw new Error(`updateGasCampaign (measurements): ${error.message}`);
}

/** Publish a campaign — mark it operative so its derived period joins the
 * timeline. Re-publishing just refreshes the timestamp. */
export async function publishGasCampaign(sb: Sb, id: string): Promise<void> {
  const { error } = await sb
    .from("gas_test_campaigns")
    .update({ published_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`publishGasCampaign: ${error.message}`);
}

/** Delete a campaign (its measurements cascade via the FK). */
export async function deleteGasCampaign(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("gas_test_campaigns").delete().eq("id", id);
  if (error) throw new Error(`deleteGasCampaign: ${error.message}`);
}
