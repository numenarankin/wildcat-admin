"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { LoadingScreen } from "@/components/ui/loading-screen";
import {
  ScoutWellsMap,
  wellStatus,
  type MapPermit,
  type MapWell,
} from "./wells-map";
import {
  getOperatorProfile,
  getOperatorWellRates,
} from "@/lib/scout/queries";
import type {
  OperatorProfile,
  OperatorWell,
  OperatorWellRates,
} from "@/lib/scout/types";
import { COUNTY_NAMES } from "@/lib/scout/counties";
import {
  ACTIVITY_LABEL,
  buildActivity,
  wellLabel,
  type ActivityEvent,
} from "@/lib/scout/operator-activity";
import { isInjectionWell } from "@/lib/scout/well-activity";
import { monthlyRevenue } from "@/lib/scout/revenue";
import {
  api8,
  fmtDate8,
  fmtPhone,
  fmtVol,
  perMonth,
  titleCase,
  P5_STATUS,
  partyName,
} from "@/lib/scout/format";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { districtLabel } from "@/lib/scout/rrc-districts";
import { leaseKeyFromArchon, type PdqLeaseKey } from "@/lib/scout/lease-key";
import {
  Empty,
  ModalTabs,
  Panel,
  Row,
  Stat,
  TabPane,
  TableBox,
  THead,
  Th,
  type ModalTab,
} from "./modal-ui";
import type { CommodityPrices } from "@/lib/analytics/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BarField, Range } from "./map-filters";

/** A per-month production band (oil bbl, gas MCF); null = unbounded. */
interface ProductionBand {
  minOil: number | null;
  maxOil: number | null;
  minGas: number | null;
  maxGas: number | null;
}

const NO_BAND: ProductionBand = { minOil: null, maxOil: null, minGas: null, maxGas: null };

function bandSet(b: ProductionBand): boolean {
  return b.minOil != null || b.maxOil != null || b.minGas != null || b.maxGas != null;
}

/**
 * Whether a row's per-month oil and gas fall in the band, inclusive.
 *
 * A row with no figure (null) fails as soon as any bound is set, the same rule
 * as the map's production band: unknown is not zero, and cannot be shown to be
 * inside a range.
 */
function inBand(oil: number | null, gas: number | null, b: ProductionBand): boolean {
  if (!bandSet(b)) return true;
  if (oil == null || gas == null) return false;
  return (
    (b.minOil == null || oil >= b.minOil) &&
    (b.maxOil == null || oil <= b.maxOil) &&
    (b.minGas == null || gas >= b.minGas) &&
    (b.maxGas == null || gas <= b.maxGas)
  );
}

/**
 * The production filter at the top of the Leases and Active wells tabs: the
 * map bar's own oil and gas pairs, in its units, so "500 bbl/mo" means the same
 * thing in both places.
 */
function ProductionFilter({
  band,
  onChange,
}: {
  band: ProductionBand;
  onChange: (b: ProductionBand) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
      <BarField label="Oil bbl/mo">
        <Range
          label="oil in bbl per month"
          min={band.minOil}
          max={band.maxOil}
          onMin={(v) => onChange({ ...band, minOil: v })}
          onMax={(v) => onChange({ ...band, maxOil: v })}
        />
      </BarField>
      <BarField label="Gas MCF/mo">
        <Range
          label="gas in MCF per month"
          min={band.minGas}
          max={band.maxGas}
          onMin={(v) => onChange({ ...band, minGas: v })}
          onMax={(v) => onChange({ ...band, maxGas: v })}
        />
      </BarField>
      {bandSet(band) && (
        <Button size="xs" variant="ghost" onClick={() => onChange(NO_BAND)}>
          Clear production
        </Button>
      )}
    </div>
  );
}

type TabKey =
  | "summary"
  | "leases"
  | "active"
  | "inactive"
  | "injection"
  | "plugged"
  | "permits"
  | "activity"
  | "map";

/** Today, for the expiry strike-through. One Date, not one per permit row. */
const TODAY = new Date().toISOString().slice(0, 10);

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function county(code: number | null | undefined): string | null {
  if (code == null) return null;
  return COUNTY_NAMES[code] ?? `County ${code}`;
}

/** Counties for a lease, from the wells bridged to it. "—" when none are known. */
function leaseCounties(codes: number[]): string {
  const names = codes.map((c) => county(c)).filter(Boolean) as string[];
  if (names.length === 0) return "—";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/**
 * What a person calls the hole: the lease and the well number, together.
 *
 * `wellLabel` rather than a local join, because the Activity feed names the
 * same wells from a different row shape and the two lists have to call a hole
 * one thing. Null when the wellbore row carries neither half.
 */
function wellName(w: OperatorWell): string | null {
  return wellLabel(w.lease_name, w.well_no);
}

/** One well-bucket tab: the name, the API, where it is, and what it makes. */
function WellTable({
  wells,
  onSelectWell,
  empty,
  estimateOf,
}: {
  wells: OperatorWell[];
  onSelectWell: (api: number, lng: number | null, lat: number | null) => void;
  empty: string;
  /**
   * This well's estimated month — oil, gas and the dollars they come to — or
   * null when there is none to give it. A test-weighted SHARE of the lease's
   * filed month (see `getOperatorWellRates`), never a measurement of the hole,
   * and only a running well gets one.
   */
  estimateOf: (well: OperatorWell) => { oil: number; gas: number; usd: number } | null;
}) {
  /*
   * Richest first, and stable underneath.
   *
   * A fleet list is read to find the wells worth having, so the money leads.
   * Wells with no estimate — not running, or their record has not been read —
   * sort last rather than as zero-dollar wells, because they are unknown rather
   * than empty. Ties fall back to the API, so the order is fixed while the
   * estimates are still landing and settles rather than shuffles when they do.
   */
  const rows = useMemo(() => {
    const rev = new Map(wells.map((w) => [w.api_number, estimateOf(w)?.usd ?? null]));
    return [...wells].sort((a, b) => {
      const ra = rev.get(a.api_number);
      const rb = rev.get(b.api_number);
      if (ra == null && rb == null) return a.api_number - b.api_number;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return rb - ra || a.api_number - b.api_number;
    });
  }, [wells, estimateOf]);

  if (wells.length === 0) {
    return <Empty>{empty}</Empty>;
  }
  return (
    <TableBox>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="border-b bg-muted text-xs text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Well</th>
            <th className="px-3 py-2 text-left font-medium">County</th>
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-right font-medium">District</th>
            <th className="px-3 py-2 text-right font-medium">Depth (ft)</th>
            {/* "Est." on all three: they are one number split three ways, and
                the two volumes are as estimated as the dollars are. */}
            <th className="px-3 py-2 text-right font-medium">Est. oil (bbl/mo)</th>
            <th className="px-3 py-2 text-right font-medium">Est. gas (MCF/mo)</th>
            <th className="px-3 py-2 text-right font-medium">Est. $/mo</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((w) => {
            const est = estimateOf(w);
            return (
              <tr
                key={w.api_number}
                onClick={() => onSelectWell(w.api_number, w.longitude, w.latitude)}
                className="cursor-pointer hover:bg-muted"
              >
                <td className="px-3 py-1.5">
                  <div className="font-medium text-primary">
                    {wellName(w) ?? api8(w.api_number)}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {api8(w.api_number)}
                  </div>
                </td>
                <td className="px-3 py-1.5">{county(w.county_code) ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {/* The RRC's own type, not the commodity: on an injection or
                      inactive list, "Oil" says nothing the tab has not. */}
                  {titleCase(w.well_type) || w.oil_gas_label || "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {w.admin_district ?? "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {w.total_depth ? w.total_depth.toLocaleString() : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {est == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    fmtVol(Math.round(est.oil))
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {est == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    fmtVol(Math.round(est.gas))
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {est == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    usdCompact.format(est.usd)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableBox>
  );
}

/**
 * One event on the Activity feed.
 *
 * TWO TARGETS, IN TWO CELLS, rather than one clickable row: an event names a
 * hole and the lease that hole is on, and both are worth opening. Splitting
 * them means neither click is a guess about which the reader meant.
 *
 * A permit row usually has no well to open — `rrc.permit` carries no API, and
 * only the applications this mirror watched through the pending feed recovered
 * one — and no lease NUMBER at all, so its lease reads as text. That is the
 * record being honest about itself, not a missing wire.
 */
function ActivityRow({
  event,
  point,
  onSelectWell,
  onSelectLease,
}: {
  event: ActivityEvent;
  /** The well's position, from the fleet list; null when it has none. */
  point: { lng: number | null; lat: number | null } | null;
  onSelectWell: (api: number, lng: number | null, lat: number | null) => void;
  onSelectLease?: (lease: PdqLeaseKey) => void;
}) {
  const api = event.api;
  const lease = event.lease;
  const leaseName = titleCase(event.lease_name);
  return (
    <tr className="hover:bg-muted">
      <td className="px-3 py-1.5 tabular-nums">{event.date}</td>
      <td className="px-3 py-1.5 text-muted-foreground">
        {ACTIVITY_LABEL[event.kind]}
      </td>
      <td className="px-3 py-1.5">
        {api != null ? (
          <button
            className="text-left font-medium text-primary hover:underline"
            onClick={() => onSelectWell(api, point?.lng ?? null, point?.lat ?? null)}
          >
            {event.name}
            <ArrowUpRight className="ml-0.5 inline size-3" />
          </button>
        ) : (
          <span className="font-medium">{event.name}</span>
        )}
        {event.detail && (
          <div
            className={cn(
              "text-[11px] text-muted-foreground",
              // The API reads as a number and lines up with the well tables;
              // "well 3A" is a name and does not.
              /^\d+$/.test(event.detail) && "font-mono"
            )}
          >
            {event.detail}
          </div>
        )}
      </td>
      <td className="px-3 py-1.5">
        {lease && onSelectLease ? (
          <button
            className="text-left text-primary hover:underline"
            onClick={() => onSelectLease(lease)}
          >
            {leaseName || `Lease ${lease.lease_no}`}
            <ArrowUpRight className="ml-0.5 inline size-3" />
          </button>
        ) : (
          leaseName || "—"
        )}
      </td>
      <td className="px-3 py-1.5 text-muted-foreground">{event.county ?? "—"}</td>
    </tr>
  );
}

/**
 * The operator dossier: P-5 profile, principals, leases, the three well buckets,
 * and their wells on a map — a full-screen modal rather than another side panel,
 * so a click from the map opens one surface instead of a stack of them.
 *
 * Everything it shows comes from a single `getOperatorProfile` call, so the
 * counts on the tabs, the counties on the leases and the buckets on the wells
 * are all derived from the same read and cannot disagree.
 */
export function OperatorModal({
  operatorNumber,
  prices,
  onClose,
  onBack,
  onSelectWell,
  onSelectPrincipal,
  onSelectLease,
  elevated = false,
}: {
  operatorNumber: number | null;
  /** Live topbar quotes, behind the revenue estimate. */
  prices: CommodityPrices;
  onClose: () => void;
  /** One step back in a stack of dossiers (see `SwipeUpModal`). */
  onBack?: () => void;
  onSelectWell: (api: number, lng: number | null, lat: number | null) => void;
  onSelectPrincipal: (name: string) => void;
  /** Omitted on a surface with no lease modal; the lease then reads as text. */
  onSelectLease?: (lease: PdqLeaseKey) => void;
  /** Raise above the well dossier when this is the one that was opened last. */
  elevated?: boolean;
}) {
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [shownNumber, setShownNumber] = useState<number | null>(null);
  const [tab, setTab] = useState<TabKey>("summary");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rates, setRates] = useState<OperatorWellRates | null>(null);
  /*
   * Which year buckets are expanded. The newest opens itself and the rest stay
   * shut, because the point of the buckets is that a 3,000-event operator is
   * readable at a glance; opening all of them would be the infinite scroll the
   * buckets exist to prevent.
   *
   * State is the years the reader has FLIPPED, not the years that are open, so
   * the default needs no effect to install it and cannot fight the reader for
   * it. Cleared with the rest of the dossier when another operator is opened.
   */
  const [flippedYears, setFlippedYears] = useState<number[]>([]);
  /** The Leases and Active wells tabs' production filters, one each: a
   *  lease's volume and a well's share are different scales. */
  const [leaseBand, setLeaseBand] = useState<ProductionBand>(NO_BAND);
  const [wellBand, setWellBand] = useState<ProductionBand>(NO_BAND);
  // Which operator the request in flight (or already landed) belongs to. A ref,
  // not state: it only guards the fetch from re-firing, and setting it during
  // the effect would be a render nobody is waiting on.
  const ratesFor = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (operatorNumber == null) return;
      setShownNumber(operatorNumber);
      setTab("summary");
      setLoading(true);
      setError(null);
      setProfile(null);
      // The rates belong to the operator that was open, so they leave with it.
      setRates(null);
      ratesFor.current = null;
      // Ditto the Activity tab's expanded years: they are this operator's
      // years, and a 2024 left open here would open the next operator's 2024.
      setFlippedYears([]);
      // And the production filters: this operator's bands, not the next one's.
      setLeaseBand(NO_BAND);
      setWellBand(NO_BAND);
      try {
        const p = await getOperatorProfile(operatorNumber);
        if (active) setProfile(p);
      } catch {
        if (active) setError("Could not load operator detail.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
    // Deliberately NOT cleared when `operatorNumber` goes null: the modal plays
    // a close animation, and clearing here would blank it mid-flight.
  }, [operatorNumber]);

  const op = profile?.operator ?? null;
  const wells = useMemo(() => profile?.wells ?? [], [profile]);
  /*
   * FOUR BUCKETS, MUTUALLY EXCLUSIVE, in this order: plugged, injecting, then
   * the activity rule.
   *
   * Injection is pulled out ahead of active/inactive rather than added
   * alongside them, so the four counts still add up to the fleet — an injector
   * used to sit in Active, where it read as a producer. The test is
   * `wellStatus`, the same one that colours these wells blue on the map, so the
   * tab and the dot cannot disagree; and because it answers "inactive" first, a
   * shut-in injector lands in Inactive, which is what its colour says too.
   */
  const buckets = useMemo(() => {
    const out = {
      active: [] as OperatorWell[],
      inactive: [] as OperatorWell[],
      injection: [] as OperatorWell[],
      plugged: [] as OperatorWell[],
    };
    for (const w of wells) {
      if (w.activity === "plugged") out.plugged.push(w);
      // `isInjectionWell`, not the map's blue-dot test: that one also counts
      // water-supply and storage holes, which the importer files as producers.
      // The two lists are of the same fleet and have to agree.
      else if (isInjectionWell(w.well_type)) out.injection.push(w);
      else if (w.activity === "active") out.active.push(w);
      else out.inactive.push(w);
    }
    return out;
  }, [wells]);

  /*
   * The fleet flattened for the map. Memoised on `wells` because
   * `ScoutWellsMap` keys its data effect on the array's identity, and a fresh
   * one every render would re-fit the viewport on every keystroke elsewhere in
   * the modal.
   */
  const mapWells = useMemo<MapWell[]>(
    () =>
      wells
        .filter((w) => w.latitude != null && w.longitude != null)
        .map((w) => ({
          api: w.api_number,
          lng: w.longitude as number,
          lat: w.latitude as number,
          og: w.oil_gas_label?.startsWith("O")
            ? "O"
            : w.oil_gas_label?.startsWith("G")
              ? "G"
              : "",
          plugged: Boolean(w.is_plugged),
          status: wellStatus(w.well_type),
          label: api8(w.api_number),
          sub: [
            w.county_code != null ? COUNTY_NAMES[w.county_code] : null,
            w.oil_gas_label,
            // What the RRC says about the hole, not about its lease: the
            // buckets stopped being a production proxy, so the sub-line had to
            // stop describing one.
            w.activity === "plugged"
              ? "Plugged"
              : w.activity === "active"
                ? "Active"
                : "Inactive",
          ]
            .filter(Boolean)
            .join(" · "),
        })),
    [wells]
  );

  /*
   * Richest lease first, by the DOLLARS the table prints.
   *
   * The server hands these back ordered by oil rate, which is not the same
   * order: a gas lease making no oil sorts last there and can out-earn every
   * oil lease above it. One sort, on the column a reader is scanning for.
   */
  const leases = useMemo(() => {
    const rows = profile?.leases ?? [];
    return [...rows].sort(
      (a, b) =>
        monthlyRevenue(
          perMonth(b.oil_last12, b.months),
          perMonth(b.gas_last12, b.months),
          prices
        ) -
        monthlyRevenue(
          perMonth(a.oil_last12, a.months),
          perMonth(a.gas_last12, a.months),
          prices
        )
    );
  }, [profile, prices]);
  // Filtered on the figures the table prints, rounded as it rounds them:
  // `perMonth` reads a lease with nothing filed as 0 and the row says 0, so a
  // "max 100" keeps it, and a row reading 64 passes "min 64".
  const shownLeases = useMemo(
    () =>
      leases.filter((l) =>
        inBand(
          Math.round(perMonth(l.oil_last12, l.months)),
          Math.round(perMonth(l.gas_last12, l.months)),
          leaseBand
        )
      ),
    [leases, leaseBand]
  );

  /*
   * PER-WELL PRODUCTION, from the app's one estimator.
   *
   * `getOperatorWellRates` returns each hole's share of its lease's last filed
   * month, weighted by the W-10/G-10 in effect — the same split the well's own
   * page, the lease dossier's Wells tab and the map's hover label read. It is
   * fetched on the first well tab opened rather than with the dossier because it
   * is the expensive half (one production read per record the fleet touches),
   * and a reader who only wants the P-5 record should not pay for it.
   */
  const wantRates =
    tab === "active" || tab === "inactive" || tab === "injection" || tab === "plugged";
  useEffect(() => {
    if (!wantRates || operatorNumber == null) return;
    if (ratesFor.current === operatorNumber) return;
    ratesFor.current = operatorNumber;
    let active = true;
    void getOperatorWellRates(operatorNumber)
      .then((r) => {
        // Checked against the ref as well as the closure: a modal reopened on a
        // different operator mid-flight must not take this answer.
        if (active && ratesFor.current === operatorNumber) setRates(r);
      })
      .catch(() => {
        // A rate is context, not content: the list stands without it.
      });
    return () => {
      active = false;
    };
  }, [wantRates, operatorNumber]);

  /*
   * ONLY RUNNING WELLS CARRY A NUMBER.
   *
   * The split already drops service holes, wells drilled after the month, and
   * wells the state records as shut in (`sharesByMonth`). What it cannot drop is
   * a hole the RRC never filed a shut-in date for but whose own row says it has
   * been idle for years — which is how an inactive well came to be showing a
   * monthly rate. This tab knows that from `activity`, so it withholds the
   * estimate rather than printing production against a well that is not making
   * any. Inactive, injection and plugged rows read "—" by rule, not by accident.
   */
  const activeApis = useMemo(
    () => new Set(buckets.active.map((w) => w.api_number)),
    [buckets.active]
  );

  const wellEstimate = useCallback(
    (w: OperatorWell) => {
      if (!activeApis.has(w.api_number)) return null;
      const r = rates?.byApi[w.api_number];
      if (!r) return null;
      return { oil: r.oil, gas: r.gas, usd: monthlyRevenue(r.oil, r.gas, prices) };
    },
    [rates, activeApis, prices]
  );
  // The Active wells tab under its production filter, on the rounded figure
  // the row prints. A well with no estimate reads "—", so it is unknown rather
  // than zero and a set bound drops it.
  const shownActive = useMemo(
    () =>
      buckets.active.filter((w) => {
        const est = wellEstimate(w);
        return inBand(
          est ? Math.round(est.oil) : null,
          est ? Math.round(est.gas) : null,
          wellBand
        );
      }),
    [buckets.active, wellEstimate, wellBand]
  );
  // The trailing window's sums, over the cycles this operator actually filed.
  // `months` is the divisor rather than a flat twelve: the RRC's ~3-month lag is
  // already outside the window, but an operator's own late filing is not.
  const months = profile?.last12.months ?? null;
  const oilMo = perMonth(profile?.last12.oil_last12, months);
  const gasMo = perMonth(profile?.last12.gas_last12, months);
  const monthly = monthlyRevenue(oilMo, gasMo, prices);
  const annual = monthly * 12;

  const counties = useMemo(() => {
    const set = new Set<number>();
    for (const w of wells) if (w.county_code != null) set.add(w.county_code);
    return [...set].sort((a, b) => a - b);
  }, [wells]);

  const address = op
    ? titleCase(
        [
          op.addr_line1,
          op.addr_line2,
          [op.city, op.state, op.zip || ""].filter(Boolean).join(" "),
        ]
          .filter(Boolean)
          .join(", ")
      )
    : null;

  const sampleNote = profile?.capped
    ? `Well tabs cover the first ${wells.length.toLocaleString()} of ${profile.wellCount.toLocaleString()} wellbores.`
    : null;

  const leaseCount = profile?.leaseCount ?? 0;
  // Big operators hold more leases than one fetch returns; the table shows the
  // highest-producing slice and says so rather than letting the tab count and
  // the row count silently disagree.
  const leaseNote =
    leases.length < leaseCount
      ? `Showing the ${leases.length.toLocaleString()} highest-producing of ${leaseCount.toLocaleString()} leases.`
      : null;

  // Memoised for identity, not for cost: `?? []` makes a new array every render,
  // which would re-run the map's data effect (and re-frame it) on every keystroke
  // elsewhere in the modal.
  const permits = useMemo(() => profile?.permits ?? [], [profile]);
  const mapPermits = useMemo<MapPermit[]>(
    () =>
      permits
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => ({
          id: `${p.permit_number}-${p.permit_seq}`,
          lng: p.lon as number,
          lat: p.lat as number,
          drilled: p.drilled,
          label: titleCase(p.lease_name) || `Permit ${p.permit_number ?? ""}`,
          sub: [
            p.well_number ? `well ${p.well_number.trim()}` : null,
            p.issued_date ? `issued ${p.issued_date}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
    [permits]
  );

  /*
   * THE ACTIVITY FEED, built from the payload that is already here.
   *
   * Every event on it comes out of `profile` — the permit slice the Permits tab
   * renders, the wellbore events read in the same round trip, and the P-5 date
   * off the operator record — so opening this tab costs no query at all, and
   * the feed's permit count for a year is a second reading of the same rows the
   * Permits tab shows rather than a second fetch that could cover a different
   * set.
   */
  const activity = useMemo(
    () =>
      buildActivity({
        permits,
        wellEvents: profile?.wellEvents ?? [],
        lastP5Date: op?.last_p5_date,
        operatorName: op?.operator_name,
      }),
    [permits, profile, op]
  );
  const activityCount = useMemo(
    () => activity.reduce((n, y) => n + y.count, 0),
    [activity]
  );

  /*
   * Where each well is, for the feed's click-through. The event rows carry an
   * API and no position (they are wellbore rows, not location rows); the fleet
   * list already holds the coordinates, so the two are joined here rather than
   * read again. A well with no coordinate still opens — the side panel takes
   * nulls and simply does not fly the map.
   */
  const wellPoint = useMemo(() => {
    const m = new Map<number, { lng: number | null; lat: number | null }>();
    for (const w of wells) m.set(w.api_number, { lng: w.longitude, lat: w.latitude });
    return m;
  }, [wells]);

  // Open by default: the newest bucket only. See `flippedYears` above.
  const newestYear = activity[0]?.year ?? null;
  const yearIsOpen = (year: number) =>
    (year === newestYear) !== flippedYears.includes(year);
  const toggleYear = (year: number) =>
    setFlippedYears((prev) =>
      prev.includes(year) ? prev.filter((y) => y !== year) : [...prev, year]
    );

  // Said only when something is missing from the feed: a truncated list whose
  // header count disagrees with its rows is the one thing worth a line here.
  const truncations = [
    profile?.wellEventsCapped
      ? `the most recent ${profile.wellEvents.length.toLocaleString()} completion and plugging records`
      : null,
    profile && profile.permitTotal > permits.length
      ? `the ${permits.length.toLocaleString()} most recently issued of ${profile.permitTotal.toLocaleString()} permits`
      : null,
  ].filter((t): t is string => t !== null);
  const activityNote = truncations.length
    ? `Covers ${truncations.join(" and ")}.`
    : null;

  const TABS: ModalTab<TabKey>[] = [
    { key: "summary", label: "Summary" },
    { key: "leases", label: "Leases", count: leaseCount },
    { key: "active", label: "Active wells", count: buckets.active.length },
    { key: "inactive", label: "Inactive wells", count: buckets.inactive.length },
    { key: "injection", label: "Injection", count: buckets.injection.length },
    { key: "plugged", label: "Plugged wells", count: buckets.plugged.length },
    // The database's count, not `permits.length`: the table is the newest 200.
    { key: "permits", label: "Permits", count: profile?.permitTotal },
    // The feed's own size, not the fleet's or the permit register's: this count
    // is the number of rows the tab holds, and it is capped where they are.
    { key: "activity", label: "Activity", count: activityCount },
    { key: "map", label: "Map" },
  ];

  // A well opens as a dossier stacked ON this one, so this one stays open
  // underneath: Back on the well returns here. (It used to close itself first,
  // from when a well opened in a side panel behind the modal; that left Back
  // with nothing to go back to.)
  const selectWell = (api: number, lng: number | null, lat: number | null) => {
    onSelectWell(api, lng, lat);
  };
  // A principal still hands off to a side panel behind the modal, so the modal
  // gets out of the way rather than burying what the click just opened.
  const selectPrincipal = (name: string) => {
    onClose();
    onSelectPrincipal(name);
  };

  return (
    <SwipeUpModal
      open={operatorNumber != null}
      onClose={onClose}
      onBack={onBack}
      elevated={elevated}
      title={partyName(op?.operator_name) || `Operator #${shownNumber ?? ""}`}
      description={
        shownNumber == null
          ? undefined
          : [
              `RRC #${shownNumber}`,
              op?.city ? titleCase([op.city, op.state].filter(Boolean).join(", ")) : null,
            ]
              .filter(Boolean)
              .join(" · ")
      }
      // The P-5 standing is the first thing a prospector checks, so it reads as
      // a badge beside the name rather than as a word in a run-on subtitle.
      headerAction={
        op?.p5_status ? (
          <Badge
            variant={
              op.p5_status === "D" || op.p5_status === "R"
                ? "destructive"
                : op.p5_status === "A" || op.p5_status === "X"
                  ? "secondary"
                  : "outline"
            }
            className="mr-1"
          >
            P-5 {P5_STATUS[op.p5_status] ?? op.p5_status}
          </Badge>
        ) : null
      }
      className="h-[88vh] max-w-6xl"
    >
      <ModalTabs
        tabs={TABS}
        value={tab}
        onChange={setTab}
        showCounts={Boolean(profile)}
      />

      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <LoadingScreen label="Loading operator" />
        </div>
      )}
      {error && !loading && (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {!loading && !error && profile && (
        // The map tab owns its whole pane (no padding, no scroll); every other
        // tab scrolls inside it.
        <TabPane bare={tab === "map"}>
          {tab === "summary" && (
            // Fills the pane: the stat row is fixed and the two panes below
            // take the rest, so a short profile leaves no dead white space.
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Est. revenue · per month"
                  value={usd.format(monthly)}
                  hint={`${
                    annual >= 1_000_000 ? usdCompact.format(annual) : usd.format(annual)
                  }/yr · gross`}
                  // The caveats belong on the number, not in a paragraph under
                  // the row: whole-lease volume, today's quotes, before deducts.
                  title={`Trailing 12 months of whole-lease production on the leases this operator's wells sit on, at $${prices.oilPerBbl.toFixed(
                    2
                  )}/bbl and $${prices.gasPerMcf.toFixed(
                    2
                  )}/MCF. Counts volume other working-interest owners are paid for; gross, before royalty, deducts and differentials.`}
                />
                <Stat
                  label="Oil · per month"
                  value={`${fmtVol(Math.round(oilMo))} bbl`}
                  hint={`at $${prices.oilPerBbl.toFixed(2)}/bbl`}
                />
                <Stat
                  label="Gas · per month"
                  value={`${fmtVol(Math.round(gasMo))} MCF`}
                  hint={`at $${prices.gasPerMcf.toFixed(2)}/MCF`}
                />
                <Stat
                  label="Wells"
                  value={profile.wellCount.toLocaleString()}
                  /*
                   * ONE RATIO, not four counts. How much of a fleet is still
                   * running is the question a prospector is asking, and four
                   * numbers made them work it out. The counts are all still
                   * there, each on its own tab.
                   *
                   * ACTIVE OVER ACTIVE PLUS INACTIVE. Injection and plugged
                   * wells are not in the denominator because neither could be
                   * producing: an injector is doing its job, and a plugged hole
                   * is finished. Counting them drags the ratio down for a
                   * disposal-heavy operator and for an old one with a long
                   * plugged tail, which reads as an operator letting wells go
                   * idle when it is neither. What is left is the wells that
                   * COULD be producing, and the share of them that are.
                   *
                   * The denominator is named rather than implied: under a well
                   * count of 1,200, a bare "58% active" reads as 58% of 1,200.
                   */
                  hint={
                    buckets.active.length + buckets.inactive.length === 0
                      ? undefined
                      : `${Math.round(
                          (100 * buckets.active.length) /
                            (buckets.active.length + buckets.inactive.length)
                        )}% of producible wells active${
                          profile.capped ? " (sampled)" : ""
                        }`
                  }
                />
              </div>

              <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
                <Panel title="P-5 profile">
                  <div className="px-4 py-2">
                    <Row
                      label="Status"
                      value={
                        op?.p5_status
                          ? P5_STATUS[op.p5_status] ?? op.p5_status
                          : null
                      }
                    />
                    <Row label="Address" value={address} />
                    <Row label="Phone" value={fmtPhone(op?.phone)} />
                    <Row label="Last P-5" value={fmtDate8(op?.last_p5_date)} />
                    <Row label="Oil gatherer" value={op?.oil_gatherer} />
                    <Row label="Gas gatherer" value={op?.gas_gatherer} />
                    <Row
                      label="Counties"
                      value={
                        counties.length
                          ? counties
                              .map((c) => county(c))
                              .filter(Boolean)
                              .join(", ")
                          : null
                      }
                    />
                    <Row label="Leases" value={leaseCount.toLocaleString()} />
                    {sampleNote && (
                      <p className="border-t pt-2 text-xs text-muted-foreground">
                        {sampleNote}
                      </p>
                    )}
                  </div>
                </Panel>

                <Panel title={`Officers & principals · ${profile.officers.length}`}>
                  {profile.officers.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">
                      None on file.
                    </p>
                  ) : (
                    <ul className="divide-y">
                      {profile.officers.map((o, i) => (
                        <li key={i}>
                          <button
                            onClick={() =>
                              o.officer_name && selectPrincipal(o.officer_name)
                            }
                            className="w-full px-4 py-2 text-left hover:bg-muted"
                          >
                            <div className="text-sm font-medium text-primary">
                              {partyName(o.officer_name)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {[
                                titleCase(o.officer_title),
                                titleCase(
                                  [o.officer_city, o.officer_state]
                                    .filter(Boolean)
                                    .join(", ")
                                ),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            </div>
          )}

          {tab === "leases" &&
            (leases.length === 0 ? (
              <Empty>No leases on record for this operator.</Empty>
            ) : (
              <>
                {/* Only the truncation warning survives here. The rest of what
                    this line used to say (12-month window, whole-lease volume,
                    county bridged from the wells) is stable prose the reader
                    scrolls past every time; the row count disagreeing with the
                    tab count is not. */}
                {leaseNote && (
                  <p className="shrink-0 text-xs text-muted-foreground">
                    {leaseNote}
                  </p>
                )}
                <ProductionFilter band={leaseBand} onChange={setLeaseBand} />
                {shownLeases.length === 0 ? (
                  <Empty>No leases in this production range.</Empty>
                ) : (
                <TableBox>
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b bg-muted text-xs text-muted-foreground">
                        <th className="px-3 py-2 text-left font-medium">Lease</th>
                        <th className="px-3 py-2 text-left font-medium">County</th>
                        <th className="px-3 py-2 text-right font-medium">Wells</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Oil (bbl/mo)
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Gas (MCF/mo)
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Est. $/mo
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {shownLeases.map((l) => {
                        // Archon stores the PDQ district code and a numeric
                        // lease number; the mirror is keyed on the padded
                        // string. Null only for a malformed row.
                        const key = leaseKeyFromArchon(
                          l.oil_gas_code,
                          l.district_no,
                          l.lease_no
                        );
                        return (
                        <tr
                          key={`${l.oil_gas_code}-${l.district_no}-${l.lease_no}`}
                          className="hover:bg-muted"
                        >
                          <td className="px-3 py-1.5">
                            <div
                              className="truncate font-medium"
                              title={titleCase(l.lease_name) || undefined}
                            >
                              {onSelectLease && key ? (
                                <button
                                  className="text-left text-primary hover:underline"
                                  onClick={() => onSelectLease(key)}
                                >
                                  {titleCase(l.lease_name) || `Lease ${l.lease_no}`}
                                  <ArrowUpRight className="ml-0.5 inline size-3" />
                                </button>
                              ) : (
                                titleCase(l.lease_name) || `Lease ${l.lease_no}`
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {/* The real district, not PDQ's internal code:
                                  this table used to read "Dist 13", which is a
                                  district that does not exist. */}
                              #{key?.lease_no ?? l.lease_no} · Dist{" "}
                              {districtLabel(String(l.district_no).padStart(2, "0"))} ·{" "}
                              {l.oil_gas_code === "O" ? "Oil" : "Gas"}
                            </div>
                          </td>
                          <td className="px-3 py-1.5">
                            {leaseCounties(l.county_codes)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {l.well_count.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmtVol(Math.round(perMonth(l.oil_last12, l.months)))}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmtVol(Math.round(perMonth(l.gas_last12, l.months)))}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {usdCompact.format(
                              monthlyRevenue(
                                perMonth(l.oil_last12, l.months),
                                perMonth(l.gas_last12, l.months),
                                prices
                              )
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableBox>
                )}
              </>
            ))}

          {(tab === "active" ||
            tab === "inactive" ||
            tab === "injection" ||
            tab === "plugged") && (
            <>
              {/* The bucket definitions used to be spelled out here on every
                  well tab. They are fixed rules, not facts about this operator,
                  so they read as noise above the table; the sample cap is still
                  disclosed on Summary, which is where `sampleNote` renders.

                  The estimate columns DO get a line, because a dash there is
                  ambiguous and the reader cannot tell which it is: still
                  loading, past the record cap, or a well that is not running. */}
              {tab === "active" && (
                <p className="shrink-0 text-xs text-muted-foreground">
                  {rates == null
                    ? "Estimating each well's share of its lease…"
                    : rates.capped
                      ? "Estimates cover this operator's first 150 lease records; the rest read “—”."
                      : "Estimates split each lease's last filed month across its running wells, by W-10/G-10 test."}
                </p>
              )}
              {tab === "active" && buckets.active.length > 0 && (
                <ProductionFilter band={wellBand} onChange={setWellBand} />
              )}
              <WellTable
                wells={tab === "active" ? shownActive : buckets[tab]}
                onSelectWell={selectWell}
                estimateOf={wellEstimate}
                empty={
                  tab === "active"
                    ? bandSet(wellBand) && buckets.active.length > 0
                      ? "No active wells in this production range."
                      : "No active wells."
                    : tab === "inactive"
                      ? "No inactive wells."
                      : tab === "injection"
                        ? "No injection or disposal wells."
                        : "No plugged wells."
                }
              />
            </>
          )}

          {/*
            * Granted drilling permits, newest issue first.
            *
            * No "permits in the last 12 months" figure, for the reason the
            * table is capped at all: the busiest operators file more than the
            * sample holds, so any window this could compute would be a real
            * number for small operators and a wrong one for exactly the
            * operators it would matter for. The honest total is on the tab.
            */}
          {tab === "permits" &&
            (permits.length === 0 ? (
              <Empty>No drilling permits on file for this operator.</Empty>
            ) : (
              <>
                {profile.permitTotal > permits.length && (
                  <p className="shrink-0 text-xs text-muted-foreground">
                    Showing the {permits.length.toLocaleString()} most recently
                    issued of {profile.permitTotal.toLocaleString()} permits.
                  </p>
                )}
                <TableBox>
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b bg-muted text-xs text-muted-foreground">
                        <th className="px-3 py-2 text-left font-medium">Permit</th>
                        <th className="px-3 py-2 text-left font-medium">Lease</th>
                        <th className="px-3 py-2 text-left font-medium">County</th>
                        <th className="px-3 py-2 text-right font-medium">District</th>
                        <th className="px-3 py-2 text-right font-medium">Depth (ft)</th>
                        {/* Filed as well as issued, because they are two
                            different events months apart and the Activity feed
                            lists them as two. A reader counting a year's
                            filings has to be able to count them HERE, against
                            the same payload the feed merges. */}
                        <th className="px-3 py-2 text-right font-medium">Filed</th>
                        <th className="px-3 py-2 text-right font-medium">Issued</th>
                        <th className="px-3 py-2 text-right font-medium">Expires</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {permits.map((p) => {
                        // A lapsed permit is still a fact: a well that was
                        // approved and never drilled. Muted, not hidden and not
                        // flagged red — lapsing is ordinary.
                        const expired =
                          p.expires_date != null && p.expires_date < TODAY;
                        return (
                          <tr
                            key={`${p.permit_number}-${p.permit_seq}`}
                            className="hover:bg-muted"
                          >
                            <td className="px-3 py-1.5 font-mono text-xs">
                              {p.permit_number ?? "—"}
                              {/* 99 is the original; anything lower is an
                                  amendment and worth saying so. */}
                              {p.permit_seq && p.permit_seq !== "99" && (
                                <span className="ml-1.5 text-[11px] text-muted-foreground">
                                  amd {p.permit_seq}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5">
                              <div>{titleCase(p.lease_name) || "—"}</div>
                              {p.well_number && (
                                <div className="text-[11px] text-muted-foreground">
                                  well {p.well_number.trim()}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-1.5">
                              {titleCase(p.county_name) || "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                              {p.district_name ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {p.total_depth?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {p.filed_date ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {p.issued_date ?? "—"}
                            </td>
                            <td
                              className={cn(
                                "px-3 py-1.5 text-right tabular-nums",
                                expired && "text-muted-foreground line-through"
                              )}
                            >
                              {p.expires_date ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableBox>
              </>
            ))}

          {/*
            * ONE MERGED TIMELINE, newest first, bucketed by year.
            *
            * The four well tabs answer "what does this operator hold now"; this
            * one answers "what have they been doing", which no other tab can:
            * a permit filed and then granted is two rows months apart here, and
            * the shape of the years is the whole story a prospector is after.
            */}
          {tab === "activity" &&
            (activity.length === 0 ? (
              <Empty>No dated permits, completions or pluggings on record.</Empty>
            ) : (
              <>
                {activityNote && (
                  <p className="shrink-0 text-xs text-muted-foreground">
                    {activityNote}
                  </p>
                )}
                <TableBox>
                  <table className="w-full text-sm">
                    <THead>
                      <Th>Date</Th>
                      <Th>Event</Th>
                      <Th>Well or permit</Th>
                      <Th>Lease</Th>
                      <Th>County</Th>
                    </THead>
                    <tbody className="divide-y">
                      {activity.map((y) => {
                        const open = yearIsOpen(y.year);
                        return (
                          <Fragment key={y.year}>
                            <tr
                              onClick={() => toggleYear(y.year)}
                              className="cursor-pointer bg-muted/60 hover:bg-muted"
                            >
                              <td colSpan={5} className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <ChevronRight
                                    className={cn(
                                      "size-3.5 text-muted-foreground transition-transform",
                                      open && "rotate-90"
                                    )}
                                  />
                                  <span className="font-semibold tabular-nums">
                                    {y.year}
                                  </span>
                                  <span className="tabular-nums text-muted-foreground">
                                    {y.count.toLocaleString()}
                                  </span>
                                  {/* The lag, drawn rather than hidden: the RRC
                                      is still filing into this year, so its
                                      count is a floor and not a total. Same
                                      honesty the production strip applies to
                                      its unreported tail. */}
                                  {y.partial && (
                                    <Badge
                                      variant="outline"
                                      title="Permits, completion reports and plugging reports reach the RRC months after the work, so this year is still filling in."
                                    >
                                      Incomplete
                                    </Badge>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {open &&
                              y.events.map((e) => (
                                <ActivityRow
                                  key={e.id}
                                  event={e}
                                  onSelectWell={selectWell}
                                  onSelectLease={onSelectLease}
                                  point={wellPoint.get(e.api ?? -1) ?? null}
                                />
                              ))}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </TableBox>
              </>
            ))}

          {/* Mounted only while its tab is open: a Mapbox instance in a hidden
              pane would boot and size itself to a zero-height container. */}
          {tab === "map" && (
            <ScoutWellsMap
              wells={mapWells}
              permits={mapPermits}
              onSelectWell={selectWell}
              note={[
                wells.length - mapWells.length > 0
                  ? `${(wells.length - mapWells.length).toLocaleString()} of ${wells.length.toLocaleString()} wells carry no coordinates and are not plotted.`
                  : null,
                // Said out loud because it is most of them: the permit register
                // holds no coordinates, and only permits this mirror watched
                // pass through the pending queue can be placed at all.
                permits.length - mapPermits.length > 0
                  ? `${mapPermits.length.toLocaleString()} of ${permits.length.toLocaleString()} recent permits carry a position.`
                  : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined}
              empty="None of this operator's wells carry coordinates."
            />
          )}
        </TabPane>
      )}
    </SwipeUpModal>
  );
}
