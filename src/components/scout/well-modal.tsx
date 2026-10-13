"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, ShieldAlert } from "lucide-react";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { WellLocationMap } from "./well-location-map";
import { DossierSummary } from "./dossier-summary";
import { InjectionChart } from "./injection-chart";
import { ProductionChart } from "./production-chart";
import { wellStatus } from "./wells-map";
import { ProductionSummary } from "./production-summary";
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
import { summariseWell } from "@/lib/ai/scout-summary";
import { api8, fmtDate8, titleCase, partyName } from "@/lib/scout/format";
import { idleFor, lateralFeet, P5_ORG } from "@/lib/scout/dossier-format";
import {
  CEMENT_MEASURE,
  H15_STATUS,
  H15_TEST_TYPE,
  INJ_MODE,
  casingLabel,
  PLUG_WELL_TYPE,
  W10_METHOD,
  h15Method,
  injTypeLabel,
  isH15Problem,
} from "@/lib/scout/rrc-uic";
import { leaseKeyFromWellbore, type PdqLeaseKey } from "@/lib/scout/lease-key";
import type {
  WellDossier,
  Wl14b2Flags,
  WellTypeName,
} from "@/lib/scout/rrc-types";
import type { WellDetail } from "@/lib/scout/types";

type TabKey =
  | "summary"
  | "production"
  | "injection"
  | "status"
  | "compliance"
  | "filings"
  | "completions"
  | "principals"
  | "location";

/** RRC well-type domain → how it should read. Colors follow the map encoding. */
const TYPE_TONE: Record<string, "producing" | "idle" | "injection" | "dead"> = {
  PRODUCING: "producing",
  "SHUT IN": "idle",
  "SHUT IN-MULTI-COMPL": "idle",
  "TEMP ABANDONED": "idle",
  "NO PRODUCTION": "idle",
  INJECTION: "injection",
  "GAS STRG-INJECTION": "injection",
  "WATER SUPPLY": "injection",
  "PARTIAL PLUG": "dead",
};

const TONE_CLASS = {
  producing: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  idle: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  injection: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  dead: "bg-muted text-muted-foreground",
} as const;

/** The thirteen 14(b)(2) reason flags, in the order the RRC lists them. */
/** The whole row, for the loading state. Counts are unknown until data lands. */
const ALL_TABS: ModalTab<TabKey>[] = [
  { key: "summary", label: "Summary" },
  { key: "production", label: "Production" },
  { key: "injection", label: "Injection" },
  { key: "status", label: "Status" },
  { key: "compliance", label: "Compliance" },
  { key: "filings", label: "Filings" },
  { key: "completions", label: "Completions" },
  { key: "principals", label: "Principals" },
  { key: "location", label: "Location" },
];

const B2_REASONS: { key: keyof Wl14b2Flags; label: string }[] = [
  { key: "ext_status", label: "Extension status" },
  { key: "mech_integ", label: "Mechanical integrity" },
  { key: "plg_ord_sf", label: "Plugging order / surface" },
  { key: "pollution", label: "Pollution" },
  { key: "fldops_hold", label: "Field ops hold" },
  { key: "h15_prob", label: "H-15 problem" },
  { key: "h15_delq", label: "H-15 delinquent" },
  { key: "oper_delq", label: "Operator delinquent" },
  { key: "dist_sfp", label: "District SFP" },
  { key: "dist_sf_clnup", label: "District surface cleanup" },
  { key: "dist_st_plg", label: "District state plugging" },
  { key: "good_faith", label: "Good faith" },
  { key: "well_other", label: "Other" },
];

function typeBadge(type: WellTypeName | null) {
  if (!type) return null;
  const tone = TYPE_TONE[type] ?? "dead";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {titleCase(type)}
    </span>
  );
}

function bearing(aLat: number, aLon: number, bLat: number, bLon: number): string {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x =
    Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
    Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return `${Math.round((deg + 360) % 360)}°`;
}

/*
 * ===========================================================================
 * WELL MODAL — the dossier for one wellbore (API number).
 * ===========================================================================
 *
 * DATA IT NEEDS  (prop `well: WellDossier | null`, see `@/lib/scout/rrc-types`)
 *   header       WellboreRow       the EWA row for this API x lease x field
 *   current      boolean           header.on_schedule === "Y"
 *   status       WellStatus|null   null when !current
 *   compliance   WellCompliance|null
 *   filings      WellFilings|null
 *   location     WellLocation      surface + bottomhole + survey
 *   completions  WellboreRow[]     EVERY ewa row for this api_number
 *
 * WIRING NOTES
 *   - Everything comes from `ewa_wellbore` except `location`, which joins
 *     `wells_surface` (LAT83/LONG83, SYMNUM, RELIAB) and `wells_bottom`
 *     (LAT83/LONG83, API10, STCODE) on api_number, plus the survey abstract
 *     from `gis_surveys`. Use the NAD83 pair; NAD27 is ~100 m off.
 *   - `current` DECIDES THE TAB SET. Of 1,368,247 EWA rows only 440,452 are
 *     `on_schedule = 'Y'`, and on the rest `well_type_name`, the 14(b)(2)
 *     flags, `curr_inact_*`, `p5_org_status` and every filing date are BLANK.
 *     Pass `status`/`compliance`/`filings` as null for those rows — the modal
 *     hides Status, Compliance and Filings rather than rendering empty tabs.
 *   - `completions` is the whole point of the EWA grain: one row per
 *     well x lease x field. Query all rows for the api_number, do NOT dedupe.
 *     A row with `on_schedule = 'N'` here is a PREVIOUS operator of the hole.
 *   - Dates arrive as CCYYMMDD strings/ints; `fmtDate8` handles them. Depth is
 *     `api_depth`. `curr_inact_yrs`/`curr_inact_mos` are the RRC's own
 *     inactivity clock — do not compute an inactivity figure from production.
 *   - The Production tab shows the LEASE's series, because that is the only
 *     grain Texas publishes. It is not a per-well meter and must never be
 *     labelled as one; the "Allocated to this well" toggle is an even split
 *     across the lease's on-schedule wells and says so on screen. The tab is
 *     hidden entirely when `production` is empty (historic wellbores have no
 *     current lease to read a series from).
 *
 * OPTIONAL EXTRAS  (used by the Scout map, ignored by the RRC browser)
 *   archon       WellDetail | null  Archon's row for the same API, for its
 *                officers list — the one thing the RRC mirror does not carry.
 *   loading      render the spinner instead of a body, for callers that fetch
 *                on open rather than handing over a finished dossier.
 *   apiNumber    the API being fetched, so the header can name it before the
 *                dossier lands.
 *
 * CALLBACKS
 *   onSelectOperator(operator_number)  -> open the operator dossier
 *   onSelectLease({oil_gas_code, district_no, lease_no}) -> open the lease modal.
 *     Those three columns are the lease key everywhere in PDQ. OPTIONAL: on a
 *     surface with no lease modal the lease reads as text rather than as a link
 *     that goes nowhere.
 *   onSelectPrincipal(name) -> open the principal panel. Optional, same reason.
 */
export function WellModal({
  well,
  open,
  onClose,
  onBack,
  onSelectOperator,
  onSelectLease,
  onSelectField,
  onSelectPrincipal,
  archon = null,
  loading = false,
  error = null,
  apiNumber,
  elevated = false,
}: {
  well: WellDossier | null;
  open: boolean;
  onClose: () => void;
  /** One step back in a stack of dossiers (see `SwipeUpModal`). */
  onBack?: () => void;
  onSelectOperator: (operatorNumber: string) => void;
  onSelectLease?: (lease: PdqLeaseKey) => void;
  /** Opens the field dossier; plain text when absent. */
  onSelectField?: (fieldNo: string) => void;
  onSelectPrincipal?: (name: string) => void;
  archon?: WellDetail | null;
  loading?: boolean;
  error?: string | null;
  apiNumber?: string;
  /** Raise above another open modal — the operator dossier it was opened from. */
  elevated?: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("summary");
  /*
   * How to split the lease's oil across its wells.
   *
   *   "lease"    no split — the only grain Texas actually publishes
   *   "even"     1 / (wells on schedule). Arithmetic, and it assumes every
   *              well on the lease is the same well.
   *   "tested"   this well's share of the lease's W-10 test rates. The weights
   *              are measured; the level still comes from the lease.
   *
   * Three options rather than a toggle because "even" and "tested" are
   * different KINDS of estimate, and a user who cannot see which one is in
   * force will read whichever number is on screen as the well's production.
   */

  const h = well?.header;
  const s = well?.status;
  // What the hole IS, for the tabs: an injector answers a different question
  // from a producer, and the same rule colours it on the map.
  const injects = wellStatus(s?.well_type_name) === "injection";
  // The date the hole was plugged, or null — the ONLY field that says a well is
  // plugged. See the Dates panel for why the plug lease/operator names cannot.
  const pluggedOn = fmtDate8(Number(s?.plug_date));
  const c = well?.compliance;
  const f = well?.filings;
  const loc = well?.location;
  const inj = well?.injection ?? null;
  const construction = well?.construction ?? null;
  const deepestCasing = construction
    ? construction.filings
        .flatMap((f) => f.casing.map((c) => c.depth_set))
        .filter((d): d is number => d != null)
        .reduce<number | null>((m, d) => (m == null || d > m ? d : m), null)
    : null;
  const h15 = well?.h15 ?? [];
  const w10 = well?.w10 ?? [];
  const g10 = well?.g10 ?? [];
  const plugging = well?.plugging ?? [];

  const reasons = c
    ? B2_REASONS.filter((r) => c.flags[r.key]).map((r) => ({
        ...r,
        value: c.flags[r.key],
      }))
    : [];

  // Memoised for its identity, not its cost: the `?? []` mints a fresh array
  // whenever there is no dossier, which would re-run the allocation below on
  // every render.
  const production = useMemo(() => well?.production ?? [], [well]);
  /*
   * This well's share of every record it sits on, weighted by filed W-10, from
   * the server (`WellDossier.productionByTest`). Falls back to the lease's own
   * series for a hole on no current schedule, where there is nothing to weight.
   */
  const testedSeries = useMemo(() => well?.productionByTest ?? [], [well]);
  const allocated = testedSeries.length > 0;
  const series = allocated ? testedSeries : production;
  const officers = archon?.officers ?? [];

  // The permit the stats describe: the live one, else the most recent. A well
  // with a cancelled 1988 permit and a live 2021 one must read as the 2021 one.
  const livePermit = inj?.permits.find((p) => p.live) ?? inj?.permits[0] ?? null;
  const utilisation =
    inj?.recentBblPerDay != null && inj.permittedBblPerDay
      ? inj.recentBblPerDay / inj.permittedBblPerDay
      : null;
  /*
   * The ceiling the chart reads reported pressure against, and deliberately not
   * `livePermit.max_inj_pressure`. That one falls back to the most recent
   * permit when none is live, which is right for describing a wellbore in the
   * tile above and wrong for a ceiling: a cancelled 1988 limit drawn as today's
   * allowance would invent headroom the hole does not have. Highest PSIG across
   * the LIVE permits only, the same filter `permittedBblPerDay` is summed under.
   */

  /*
   * While the dossier is in flight, show the FULL row.
   *
   * Every tab below is conditional on data that has not arrived yet, so a
   * loading modal offered three tabs and then grew to eight under the cursor.
   * A row that changes shape after it is already on screen reads as a glitch,
   * and it moves whatever the user was about to click.
   */
  const tabs: ModalTab<TabKey>[] = loading
    ? ALL_TABS
    : [
    { key: "summary", label: "Summary" },
    /*
     * Only when there is a series, and never for a hole that injects.
     *
     * An injector takes no share of its lease's oil, so its Production tab could
     * only ever draw zero — and a well whose whole job is putting water back in
     * the ground is not asking that question. A historic wellbore is excluded for
     * the same reason: no current lease to read a series from, and an empty chart
     * reads as "this well makes nothing" rather than "Texas published nothing at
     * this grain".
     */
    ...(!injects && (production.length > 0 || testedSeries.length > 0)
      ? ([{ key: "production", label: "Production" }] as ModalTab<TabKey>[])
      : []),
    // Only for a hole with a UIC record. Most wells have none, and an empty
    // Injection tab reads as a bug rather than as "this well does not inject".
    ...(inj
      ? ([
          { key: "injection", label: "Injection", count: inj.permits.length },
        ] as ModalTab<TabKey>[])
      : []),
    // Hidden for historic wellbores: the columns behind them are blank in the
    // source, and an empty tab reads as a bug.
    ...(well?.current
      ? ([
          { key: "status", label: "Status" },
          { key: "compliance", label: "Compliance", count: reasons.length },
          { key: "filings", label: "Filings" },
        ] as ModalTab<TabKey>[])
      : []),
    { key: "completions", label: "Completions", count: well?.completions.length },
    ...(officers.length > 0 && onSelectPrincipal
      ? ([
          { key: "principals", label: "Principals", count: officers.length },
        ] as ModalTab<TabKey>[])
      : []),
    { key: "location", label: "Location" },
      ];
  const active = tabs.some((t) => t.key === tab) ? tab : "summary";

  const lateral =
    loc?.lat != null && loc.lon != null && loc.bottom_lat != null && loc.bottom_lon != null
      ? {
          feet: lateralFeet(loc.lat, loc.lon, loc.bottom_lat, loc.bottom_lon),
          heading: bearing(loc.lat, loc.lon, loc.bottom_lat, loc.bottom_lon),
        }
      : null;

  /*
   * The lease this hole is on, in the coding the lease record is keyed by.
   *
   * EWA carries the real district label ("7B"), PDQ keys on an internal code
   * ("08"), and passing the label through opens a different operator's lease
   * without erroring. Null for a wellbore with no lease on it, which is what
   * turns the link back into plain text.
   */
  const leaseKey = leaseKeyFromWellbore(
    h?.oil_gas_code,
    h?.district,
    h?.lease_number
  );

  const permitElsewhere =
    f?.recent_permit_operator_no &&
    h?.operator_number &&
    f.recent_permit_operator_no !== h.operator_number;

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      onBack={onBack}
      elevated={elevated}
      title={
        h
          ? `${titleCase(h.lease_name) || "Lease"} ${h.well_no_display ?? h.well_no ?? ""}`
          : "Well"
      }
      description={
        h
          ? [
              `API ${api8(Number(h.api_number))}`,
              titleCase(h.county_name) ? `${titleCase(h.county_name)} County` : null,
              h.district ? `District ${h.district}` : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : // Before the dossier lands there is no lease name to title the
            // modal with, so the API is what identifies it.
            apiNumber
            ? `API ${api8(Number(apiNumber))}`
            : undefined
      }
      headerAction={
        <div className="flex items-center gap-1.5">
          {s && typeBadge(s.well_type_name)}
          {well && !well.current && (
            <Badge variant="outline">Historic record</Badge>
          )}
          {c?.wb_14b2_flag === "Y" && (
            <Badge variant="destructive" className="gap-1">
              <ShieldAlert className="size-3" />
              14(b)(2)
            </Badge>
          )}
        </div>
      }
      className="h-[88vh] max-w-6xl"
    >
      <ModalTabs
        tabs={tabs}
        value={active}
        onChange={setTab}
        showCounts={Boolean(well)}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <LoadingScreen label="Loading well" />
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : !well ? (
        <TabPane>
          <Empty>No well selected.</Empty>
        </TabPane>
      ) : (
        <TabPane bare={false}>
          {active === "summary" && (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Status"
                  value={titleCase(s?.well_type_name) || "Not on schedule"}
                  hint={
                    well.current
                      ? (idleFor(s?.curr_inact_yrs ?? null, s?.curr_inact_mos ?? null)
                          ? `idle ${idleFor(s?.curr_inact_yrs ?? null, s?.curr_inact_mos ?? null)}`
                          : "producing")
                      : "historic wellbore record"
                  }
                />
                <Stat
                  label="Total depth"
                  value={s?.api_depth ? `${s.api_depth.toLocaleString()} ft` : "—"}
                  hint={lateral ? `${lateral.feet.toLocaleString()} ft lateral` : undefined}
                />
                <Stat
                  label="Completed"
                  value={fmtDate8(Number(s?.completion_date)) ?? "—"}
                  hint={
                    s?.orig_completion_dt && s.orig_completion_dt !== s.completion_date
                      ? `originally ${fmtDate8(Number(s.orig_completion_dt))}`
                      : undefined
                  }
                />
                <button
                  className="text-left"
                  onClick={() =>
                    h?.operator_number && onSelectOperator(h.operator_number)
                  }
                >
                  <Stat
                    label="Operator"
                    value={partyName(h?.operator_name) || "—"}
                    hint={h?.on_schedule === "Y" ? "current (on schedule)" : "not current"}
                  />
                </button>
              </div>

              {/* Keyed on the hole: this modal instance is reused as the user
                  clicks from well to well, and without the key the summary of
                  the LAST well would still be sitting above this one's rows. */}
              <DossierSummary
                key={well.api_number}
                run={() => summariseWell(well.api_number)}
              />

              <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-2">
                <Panel title="Wellbore">
                  <div className="px-4 py-2">
                    <Row label="API" value={api8(Number(well.api_number))} mono />
                    <Row label="Well no." value={h?.well_no_display ?? h?.well_no} />
                    <Row label="Type" value={titleCase(s?.well_type_name)} />
                    <Row
                      label="Oil / gas"
                      value={h?.oil_gas_code === "O" ? "Oil" : h?.oil_gas_code === "G" ? "Gas" : null}
                    />
                    <Row label="Setting" value={s?.wb_water_land_code} />
                    <Row
                      label="Multiple completions"
                      value={s?.multi_comp_flag === "Y" ? "Yes" : null}
                    />
                    <Row label="Oil unit no." value={h?.oil_unit_number} />
                    <Row label="County" value={titleCase(h?.county_name)} />
                    <Row label="District" value={h?.district} />
                  </div>
                </Panel>
                <Panel title="Lease & field">
                  <div className="px-4 py-2">
                    <Row
                      label="Lease"
                      value={
                        !h?.lease_number ? null : onSelectLease && leaseKey ? (
                          <button
                            className="text-primary hover:underline"
                            onClick={() => onSelectLease(leaseKey)}
                          >
                            {titleCase(h.lease_name) || h.lease_number}
                            <ArrowUpRight className="ml-0.5 inline size-3" />
                          </button>
                        ) : (
                          titleCase(h.lease_name) || h.lease_number
                        )
                      }
                    />
                    <Row label="Lease no." value={h?.lease_number} mono />
                    <Row
                      label="Field"
                      value={
                        onSelectField && h?.field_number ? (
                          <button
                            className="text-primary hover:underline"
                            onClick={() => onSelectField(h.field_number!)}
                          >
                            {titleCase(h.field_name) || `Field ${h.field_number}`}
                            <ArrowUpRight className="ml-0.5 inline size-3" />
                          </button>
                        ) : (
                          titleCase(h?.field_name)
                        )
                      }
                    />
                    <Row label="Field no." value={h?.field_number} mono />
                    <Row
                      label="Operator"
                      value={
                        h?.operator_number ? (
                          <button
                            className="text-primary hover:underline"
                            onClick={() => onSelectOperator(h.operator_number!)}
                          >
                            {partyName(h.operator_name)}
                            <ArrowUpRight className="ml-0.5 inline size-3" />
                          </button>
                        ) : null
                      }
                    />
                    <Row label="Operator no." value={h?.operator_number} mono />
                    <Row label="P-5 status" value={s ? P5_ORG[s.p5_org_status ?? ""] : null} />
                    <Row label="H-15" value={s ? H15_STATUS[s.h15_status_code ?? ""] : null} />
                  </div>
                </Panel>
              </div>
            </div>
          )}

          {active === "production" && (
            // Same column shell every other tab uses. Rendered as a bare
            // fragment, the chart's footer had nothing holding it above the
            // panel below it and the two drew on top of each other.
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <ProductionSummary monthly={series} />
              <ProductionChart
                monthly={series}
                title={allocated ? "Allocated to this well" : "Lease production"}
              />
              {w10.length > 0 && (
                <Panel title={`W-10 tests on file (${w10.length})`}>
                  <TableBox>
                    <table className="w-full text-sm">
                      <THead>
                        <Th>Tested</Th>
                        <Th>Method</Th>
                        <Th right>Oil (bbl/d)</Th>
                        <Th right>Water</Th>
                        <Th right>Gas (MCF/d)</Th>
                        <Th right>GOR</Th>
                      </THead>
                      <tbody className="divide-y">
                        {w10.slice(0, 20).map((t, i) => (
                          <tr key={i} className="hover:bg-muted">
                            <td className="px-3 py-1.5 tabular-nums">
                              {t.test_date ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {W10_METHOD[t.producing_method ?? ""] ??
                                t.producing_method ??
                                "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.daily_oil?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.daily_water?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.daily_gas?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.gas_oil_ratio?.toLocaleString() ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableBox>
                </Panel>
              )}

              {g10.length > 0 && (
                <Panel title={`G-10 tests on file (${g10.length})`}>
                  <TableBox>
                    <table className="w-full text-sm">
                      <THead>
                        <Th>Tested</Th>
                        <Th right>Gas (MCF/d)</Th>
                        <Th right>Cond (bbl/d)</Th>
                        <Th right>Water</Th>
                        <Th right>SIWH (psi)</Th>
                        <Th right>Potential</Th>
                        <Th>Status</Th>
                      </THead>
                      <tbody className="divide-y">
                        {g10.slice(0, 20).map((t, i) => (
                          <tr key={i} className="hover:bg-muted">
                            <td className="px-3 py-1.5 tabular-nums">
                              {t.test_date ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.daily_gas?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.daily_cond?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.daily_water?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.siwh_press?.toLocaleString() ?? "—"}
                            </td>
                            {/* Potential is only required where the field
                                rules call for it, so a 0 here means "not
                                required", not "this well makes nothing". */}
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.potential ? t.potential.toLocaleString() : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {t.shut_in_flag === "Y"
                                ? `Shut in${t.shut_in_date ? ` ${t.shut_in_date}` : ""}`
                                : "Producing"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableBox>
                </Panel>
              )}
            </div>
          )}

          {active === "injection" && inj && (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Permitted"
                  value={
                    inj.permittedBblPerDay != null
                      ? `${inj.permittedBblPerDay.toLocaleString()} bbl/d`
                      : "—"
                  }
                  hint={
                    inj.permits.filter((p) => p.live).length > 1
                      ? `across ${inj.permits.filter((p) => p.live).length} live permits`
                      : "authorised daily volume"
                  }
                />
                <Stat
                  label="Running at"
                  value={
                    inj.recentBblPerDay != null
                      ? `${Math.round(inj.recentBblPerDay).toLocaleString()} bbl/d`
                      : "—"
                  }
                  hint={`12 months to ${inj.reportedThrough}`}
                />
                {/* A rate against a rate, both bbl/day, so the ratio needs no
                    conversion. The operator modal's disposal tile is a
                    different quantity (a year's volume against a year's
                    allowance) and is labelled "Allowance used" for that
                    reason — do not converge the two names. */}
                <Stat
                  label="Rate vs permitted"
                  value={utilisation != null ? `${Math.round(utilisation * 100)}%` : "—"}
                  hint={
                    utilisation != null && utilisation > 1
                      ? "reported above the permitted rate"
                      : "headroom left on the permit"
                  }
                />
                <Stat
                  label="Injection zone"
                  value={
                    livePermit?.top_inj_zone && livePermit.bot_inj_zone
                      ? `${livePermit.top_inj_zone.toLocaleString()}–${livePermit.bot_inj_zone.toLocaleString()} ft`
                      : "—"
                  }
                  hint={
                    livePermit?.max_inj_pressure
                      ? `max ${livePermit.max_inj_pressure.toLocaleString()} PSIG`
                      : (livePermit?.max_inj_pressure_note ?? undefined)
                  }
                />
              </div>

              {inj.monthly.length > 0 ? (
                <InjectionChart
                  monthly={inj.monthly}
                  reportedThrough={inj.reportedThrough}
                  permittedBblPerDay={inj.permittedBblPerDay}
                  permittedPressurePsig={inj?.permittedPressurePsig ?? null}
                />
              ) : (
                <Empty>
                  This well holds a UIC permit but has never filed an H-10.
                </Empty>
              )}

              <TableBox>
                <table className="w-full text-sm">
                  <THead>
                    <Th>Permit</Th>
                    <Th>Type</Th>
                    <Th>Fluids</Th>
                    <Th right>Max bbl/d</Th>
                    <Th right>Interval</Th>
                    <Th right>Status</Th>
                  </THead>
                  <tbody className="divide-y">
                    {inj.permits.map((p) => (
                      <tr key={p.uic_no} className="hover:bg-muted">
                        <td className="px-3 py-1.5">
                          <div className="font-mono text-xs">
                            {p.uic_no.replace(/^0+/, "") || p.uic_no}
                          </div>
                          {p.is_commercial && (
                            <div className="text-[11px] text-muted-foreground">
                              commercial
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          {injTypeLabel(p.inj_type, p.approved_date) ?? "—"}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {p.fluids.length ? p.fluids.join(", ") : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {p.max_bbl_per_day?.toLocaleString() ?? "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {p.top_inj_zone && p.bot_inj_zone
                            ? `${p.top_inj_zone.toLocaleString()}–${p.bot_inj_zone.toLocaleString()}`
                            : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {p.live ? (
                            <Badge variant="secondary">Live</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {p.w3_date
                                ? `plugged ${p.w3_date}`
                                : p.cancel_date
                                  ? `cancelled ${p.cancel_date}`
                                  : "not activated"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>

              {livePermit && (
                <Panel title="Permit detail">
                  <div className="px-4 py-2">
                    <Row label="UIC no." value={livePermit.uic_no} mono />
                    <Row
                      label="Class"
                      value={
                        livePermit.uic_class === "2"
                          ? "Injection / disposal"
                          : livePermit.uic_class === "5"
                            ? "Storage, geothermal or brine"
                            : livePermit.uic_class
                      }
                    />
                    <Row label="Injection mode" value={INJ_MODE[livePermit.inj_mode ?? ""]} />
                    <Row label="Fluid described as" value={livePermit.fluid_comment} />
                    <Row label="Location" value={livePermit.location} />
                    <Row
                      label="Permit filed"
                      value={livePermit.approved_date}
                    />
                  </div>
                </Panel>
              )}

            </div>
          )}

          {active === "status" && s && (
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-2">
              <Panel title="Dates">
                <div className="px-4 py-2">
                  <Row label="Completed" value={fmtDate8(Number(s.completion_date))} />
                  <Row
                    label="Originally completed"
                    value={fmtDate8(Number(s.orig_completion_dt))}
                  />
                  <Row label="Shut in (wellbore)" value={fmtDate8(Number(s.wb_shut_in_date))} />
                  <Row label="Shut in (well)" value={fmtDate8(Number(s.wl_shut_in_date))} />
                  {/* ONLY WHEN THERE IS A PLUG DATE.
                      `plug_lease_name` / `plug_operator_name` are not a
                      plugging record: 439,654 of the 440,050 wellbores that
                      carry them have no `plug_date` at all, and the value just
                      repeats the row's own current lease and operator. Rendered
                      unconditionally they said "plugged by <the operator
                      running it>" on a PRODUCING well, contradicting every
                      status bucket in Scout — all of which key off `plug_date`
                      (`operator-fleet.ts` wellStatus, `queries.ts` FocusOpts),
                      because that is the RRC's only plugging signal. */}
                  {pluggedOn ? (
                    <>
                      <Row label="Plugged" value={pluggedOn} />
                      <Row
                        label="Plugged as lease"
                        value={titleCase(s.plug_lease_name)}
                      />
                      <Row
                        label="Plugged by"
                        value={partyName(s.plug_operator_name)}
                      />
                    </>
                  ) : null}
                </div>
              </Panel>
              <Panel title="Inactivity">
                <div className="px-4 py-2">
                  <Row
                    label="Currently inactive"
                    value={idleFor(s.curr_inact_yrs, s.curr_inact_mos) ?? "not inactive"}
                  />
                  <Row label="P-5 organization" value={P5_ORG[s.p5_org_status ?? ""]} />
                  <Row label="H-15 status" value={H15_STATUS[s.h15_status_code ?? ""]} />
                  <p className="mt-2 border-t pt-2 text-xs leading-relaxed text-muted-foreground">
                    Inactivity is the RRC&rsquo;s own clock
                    (<span className="font-mono">curr_inact_yrs/mos</span>), not a
                    figure derived from production. A well can be inactive and
                    still sit on a lease that reports volume.
                  </p>
                </div>
              </Panel>
              {plugging.length > 0 && (
                <Panel
                  title={
                    plugging.length === 1
                      ? "Plugging record"
                      : `Plugging records (${plugging.length})`
                  }
                  className="lg:col-span-2"
                >
                  <TableBox>
                    <table className="w-full text-sm">
                      <THead>
                        <Th>Plugged</Th>
                        <Th>Type</Th>
                        <Th right>Depth</Th>
                        <Th right>Plugs</Th>
                        <Th right>Sacks</Th>
                        <Th right>Fresh water</Th>
                        <Th>Cementer</Th>
                      </THead>
                      <tbody className="divide-y">
                        {plugging.map((j, i) => (
                          <tr key={i} className="hover:bg-muted">
                            <td className="px-3 py-1.5 tabular-nums">
                              {j.plug_date ?? "—"}
                              {j.state_funded && (
                                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                                  state funded
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {PLUG_WELL_TYPE[j.well_type ?? ""] ?? j.well_type ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {j.total_depth?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {j.plugs?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {j.cement_sacks?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {j.fresh_water_depth?.toLocaleString() ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {titleCase(j.cement_comp) ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableBox>
                  <p className="px-4 py-2 text-xs leading-relaxed text-muted-foreground">
                    From the operator&rsquo;s own Form W-3. &ldquo;State
                    funded&rdquo; means the Commission plugged the well and the
                    operator did not — the orphaned-well marker.
                  </p>
                </Panel>
              )}
            </div>
          )}

          {active === "compliance" && c && (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <div className="grid shrink-0 gap-3 sm:grid-cols-3">
                <Stat
                  label="Rule 14(b)(2)"
                  value={c.wb_14b2_flag === "Y" ? "Flagged" : "Clear"}
                  hint={
                    c.wb_14b2_flag === "Y"
                      ? `${reasons.length} reason${reasons.length === 1 ? "" : "s"} on file`
                      : undefined
                  }
                />
                <Stat
                  label="Surface equipment"
                  value={c.surf_eqp_viol ? "Violation" : "Clear"}
                />
                <Stat label="W-3X" value={c.w3x_viol ? "Violation" : "Clear"} />
              </div>

              <Panel title="14(b)(2) reasons on file">
                {reasons.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted-foreground">
                    No 14(b)(2) reasons recorded against this wellbore.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {reasons.map((r) => (
                      <li
                        key={r.key}
                        className="flex items-center justify-between gap-4 px-4 py-2 text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <AlertTriangle className="size-3.5 text-amber-600" />
                          {r.label}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {r.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              {/* The test history behind the H-15 letter on the Summary tab.
                  That letter is the CURRENT status; this is what was actually
                  run, when, and by whom — which is what a plugging-liability
                  or acquisition question needs. */}
              {h15.length > 0 && (
                <Panel title={`H-15 tests on file (${h15.length})`}>
                  <TableBox>
                    <table className="w-full text-sm">
                      <THead>
                        <Th>Tested</Th>
                        <Th>Type</Th>
                        <Th>Method</Th>
                        <Th right>Fluid level</Th>
                        <Th right>Status</Th>
                      </THead>
                      <tbody className="divide-y">
                        {h15.slice(0, 25).map((t, i) => (
                          <tr key={i} className="hover:bg-muted">
                            <td className="px-3 py-1.5 tabular-nums">
                              {t.test_date ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {H15_TEST_TYPE[t.test_type ?? ""] ?? "—"}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {h15Method(t.test_type, t.fluid_method, t.mech_method) ??
                                "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {t.top_of_fluid
                                ? `${t.top_of_fluid.toLocaleString()} ft`
                                : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              {isH15Problem(t.status) ? (
                                <Badge variant="destructive">
                                  {H15_STATUS[t.status ?? ""] ?? t.status}
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {H15_STATUS[t.status ?? ""] ?? t.status ?? "—"}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableBox>
                  {h15.length > 25 && (
                    <p className="px-4 py-2 text-xs text-muted-foreground">
                      Showing the 25 most recent of {h15.length} filings.
                    </p>
                  )}
                </Panel>
              )}

            </div>
          )}

          {active === "filings" && f && (
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-2">
              <Panel title="Reports">
                <div className="px-4 py-2">
                  <Row label="W-2 / G-1 filed" value={fmtDate8(Number(f.w2_g1_filed_date))} />
                  <Row label="W-2 / G-1 date" value={fmtDate8(Number(f.w2_g1_date))} />
                  <Row label="W-3 (plugging) filed" value={fmtDate8(Number(f.w3_file_date))} />
                  <Row
                    label="P-5 renews"
                    value={
                      f.p5_renewal_month && f.p5_renewal_year
                        ? `${f.p5_renewal_month}/${f.p5_renewal_year}`
                        : null
                    }
                  />
                  <Row label="RRC record modified" value={fmtDate8(Number(f.modified_dt))} />
                </div>
              </Panel>
              <Panel title="Most recent permit">
                <div className="px-4 py-2">
                  <Row label="Permit no." value={f.recent_permit} mono />
                  <Row label="Lease on permit" value={titleCase(f.recent_permit_lease_name)} />
                  <Row
                    label="Filed by"
                    value={
                      f.recent_permit_operator_no ? (
                        <button
                          className="text-primary hover:underline"
                          onClick={() => onSelectOperator(f.recent_permit_operator_no!)}
                        >
                          #{f.recent_permit_operator_no}
                        </button>
                      ) : null
                    }
                  />
                  {permitElsewhere && (
                    <p className="mt-2 flex gap-2 border-t pt-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      The most recent permit was filed by a different operator
                      than the one currently on schedule — often the trace of a
                      sale or a takeover in progress.
                    </p>
                  )}
                </div>
              </Panel>
            </div>
          )}

          {active === "completions" && (
            <>
              {well.completions.length === 0 ? (
                <Empty>No completion records for this wellbore.</Empty>
              ) : (
                <TableBox>
                  <table className="w-full text-sm">
                    <THead>
                      <Th>Lease</Th>
                      <Th>Field</Th>
                      <Th>Type</Th>
                      <Th>Operator</Th>
                      <Th right>Current</Th>
                    </THead>
                    <tbody className="divide-y">
                      {well.completions.map((r, i) => {
                        // Each completion is a different lease, so each row gets
                        // its own key rather than reusing the header's.
                        const rowKey = leaseKeyFromWellbore(
                          r.oil_gas_code,
                          r.district,
                          r.lease_number
                        );
                        return (
                        <tr key={i} className="hover:bg-muted">
                          <td className="px-3 py-1.5">
                            <div className="font-medium">
                              {onSelectLease && rowKey ? (
                                <button
                                  className="text-primary hover:underline"
                                  onClick={() => onSelectLease(rowKey)}
                                >
                                  {titleCase(r.lease_name)}
                                  <ArrowUpRight className="ml-0.5 inline size-3" />
                                </button>
                              ) : (
                                titleCase(r.lease_name)
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              #{r.lease_number} · Dist {r.district}
                            </div>
                          </td>
                          <td className="px-3 py-1.5">{titleCase(r.field_name)}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {r.oil_gas_code === "O" ? "Oil" : "Gas"}
                          </td>
                          <td className="px-3 py-1.5">{partyName(r.operator_name)}</td>
                          <td className="px-3 py-1.5 text-right">
                            {r.on_schedule === "Y" ? (
                              <Badge variant="secondary">On schedule</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableBox>
              )}

              {/* How the hole was BUILT, which is a different question from
                  which leases it is completed on. Same tab because it is the
                  one a reader opens asking "how is this well completed"; a
                  heading rather than a new tab because the plan's rule is that
                  a new tab needs a justification. */}
              {construction && construction.filings.length > 0 && (
                <>
                  {/* Deliberately NO total-depth tile here. The Summary tab
                      already shows one, from EWA, and the Well Bore Database's
                      figure agrees with it to a mean of 2 ft across 384,582
                      wells — so a second tile would be the same number under a
                      second name, which is how a reader ends up hunting for a
                      discrepancy that does not exist. */}
                  <div className="grid shrink-0 gap-3 sm:grid-cols-3">
                    <Stat
                      label="Casing strings"
                      value={String(
                        construction.filings.reduce((n, f) => n + f.casing.length, 0)
                      )}
                      hint={
                        deepestCasing != null
                          ? `deepest set at ${deepestCasing.toLocaleString()} ft`
                          : "no set depths recorded"
                      }
                    />
                    <Stat
                      label="Completed interval"
                      value={
                        construction.shallowest_perf && construction.deepest_perf
                          ? `${construction.shallowest_perf.toLocaleString()}–${construction.deepest_perf.toLocaleString()} ft`
                          : construction.has_open_hole
                            ? "Open hole"
                            : "—"
                      }
                      hint={
                        construction.has_open_hole &&
                        construction.shallowest_perf != null
                          ? "plus uncased hole below"
                          : "shallowest to deepest perforation on record"
                      }
                    />
                    <Stat
                      label="Filings on record"
                      value={String(construction.filings.length)}
                      hint="each one a completion or recompletion"
                    />
                  </div>

                  {construction.filings
                    .filter((f) => f.casing.length > 0 || f.perforations.length > 0)
                    .map((f, i) => (
                      <Panel
                        key={f.file_date ?? `undated-${i}`}
                        title={`Wellbore construction — ${
                          f.file_date ?? "filing date not recorded"
                        }`}
                      >
                        <div className="px-4 py-2">
                          {f.perforations.length > 0 && (
                            <>
                              <div className="pb-1 pt-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                Perforations
                              </div>
                              <ul className="pb-2 text-sm">
                                {f.perforations.map((p, j) => (
                                  <li key={j} className="flex justify-between py-0.5">
                                    <span className="text-muted-foreground">
                                      {p.open_hole
                                        ? "Open hole"
                                        : `Interval ${p.seq ?? j + 1}`}
                                    </span>
                                    <span className="font-medium tabular-nums">
                                      {/* A null top is "not recorded", NOT the
                                          surface — printing 0 would put the
                                          completion in the freshwater zone. */}
                                      {p.top_ft != null && p.bottom_ft != null
                                        ? `${p.top_ft.toLocaleString()}–${p.bottom_ft.toLocaleString()} ft`
                                        : p.bottom_ft != null
                                          ? `to ${p.bottom_ft.toLocaleString()} ft (top not recorded)`
                                          : "—"}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                          {f.casing.length > 0 && (
                            <>
                              <div className="border-t pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                Casing
                              </div>
                              <ul className="text-sm">
                                {f.casing.map((c, j) => (
                                  <li key={j} className="flex justify-between gap-4 py-0.5">
                                    <span className="text-muted-foreground">
                                      {casingLabel(c.size_in) ?? "size not recorded"}
                                      {c.weight_lb_ft
                                        ? ` · ${c.weight_lb_ft} lb/ft`
                                        : ""}
                                    </span>
                                    <span className="text-right font-medium tabular-nums">
                                      {c.depth_set
                                        ? `set ${c.depth_set.toLocaleString()} ft`
                                        : "depth not recorded"}
                                      {c.cement_amount
                                        ? ` · ${c.cement_amount.toLocaleString()} ${
                                            CEMENT_MEASURE[c.cement_measure ?? ""] ??
                                            "cement"
                                          }`
                                        : ""}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                          {f.plug_back_ft != null && (
                            <Row
                              label="Plugged back to"
                              value={`${f.plug_back_ft.toLocaleString()} ft`}
                            />
                          )}
                        </div>
                      </Panel>
                    ))}

                </>
              )}

              {/* THE FILED PAPERWORK — the W-2 (oil) or G-1 (gas) completion
                  report, as distinct from the Well Bore Database's account of
                  the same hole above.

                  Only the FORMATION record is rendered. The packet also carries
                  casing, and so does the section above: 78,164 of the 79,173
                  wells that have a report also have Well Bore Database casing,
                  so showing both would put two casing lists on nearly every
                  well — two internally-correct answers to one question, which
                  reads as a discrepancy to hunt down rather than as two
                  filings. One list, from one source, stated.

                  Formations are what nothing else in this modal has: the rock
                  the bit went through, at what depth, and which zones the
                  operator certified as isolated. */}
              {well.completionReports.map((rep) => (
                <Panel
                  key={rep.tracking_no ?? rep.completion_date ?? "packet"}
                  title={`Completion report — ${
                    rep.completion_date ??
                    rep.approved_date ??
                    "date not recorded"
                  }`}
                >
                  <div className="px-4 py-2">
                    <Row label="Purpose" value={titleCase(rep.purpose_of_filing)} />
                    <Row label="Type" value={titleCase(rep.completion_type)} />
                    <Row label="Profile" value={titleCase(rep.wellbore_profile)} />
                    <Row label="Spudded" value={rep.spud_date} />
                    <Row label="Approved" value={rep.approved_date} />
                    <Row
                      label="Lease acreage"
                      value={
                        rep.total_acres
                          ? `${Number(rep.total_acres).toLocaleString()} ac`
                          : null
                      }
                    />
                    <Row label="Producing wells on lease" value={rep.producing_wells} />
                    <Row
                      label="Survey"
                      value={[
                        titleCase(rep.survey),
                        rep.survey_block ? `Blk ${rep.survey_block}` : null,
                        rep.survey_section ? `Sec ${rep.survey_section}` : null,
                        rep.survey_abstract,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />

                    {rep.formations.length > 0 && (
                      <>
                        <div className="border-t pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Formations
                        </div>
                        <table className="w-full text-sm">
                          <tbody className="divide-y">
                            {rep.formations.map((f, j) => (
                              <tr key={j}>
                                <td className="py-0.5 pr-3">
                                  {titleCase(f.formation) || "—"}
                                  {f.remark && (
                                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                                      {f.remark}
                                    </span>
                                  )}
                                </td>
                                <td className="py-0.5 pr-3 text-right text-xs text-muted-foreground">
                                  {/* Isolated is the one that carries weight:
                                      it is the operator certifying they cased
                                      a zone off. "Encountered" alone is just
                                      "the bit went through it". */}
                                  {f.isolated === "Y"
                                    ? "isolated"
                                    : f.encountered === "Y"
                                      ? "encountered"
                                      : ""}
                                </td>
                                <td className="w-24 py-0.5 text-right font-medium tabular-nums">
                                  {f.depth
                                    ? `${Number(f.depth).toLocaleString()} ft`
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}

                    {rep.otherSections.length > 0 && (
                      <div className="border-t pt-2 text-[11px] text-muted-foreground">
                        Also in this packet:{" "}
                        {rep.otherSections
                          .map((o) => `${titleCase(o.tag)} (${o.rows})`)
                          .join(", ")}
                      </div>
                    )}
                  </div>
                </Panel>
              ))}
            </>
          )}

          {active === "principals" && onSelectPrincipal && (
            <>
              <Panel
                title={`Officers on file${
                  archon?.operator?.operator_display_name ??
                  archon?.operator?.operator_name
                    ? ` — ${titleCase(
                        archon.operator.operator_display_name ??
                          archon.operator.operator_name
                      )}`
                    : ""
                }`}
              >
                <ul className="divide-y">
                  {officers.map((o, i) => (
                    <li key={i}>
                      <button
                        onClick={() =>
                          o.officer_name && onSelectPrincipal(o.officer_name)
                        }
                        className="w-full px-4 py-2 text-left hover:bg-muted"
                      >
                        <div className="text-sm font-medium text-primary">
                          {partyName(o.officer_name)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
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
              </Panel>
            </>
          )}

          {active === "location" && loc && (
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-2">
              <WellLocationMap location={loc} />
              <Panel title="Coordinates">
                <div className="px-4 py-2">
                  <Row
                    label="Surface"
                    value={loc.lat != null ? `${loc.lat.toFixed(5)}, ${loc.lon?.toFixed(5)}` : null}
                    mono
                  />
                  <Row
                    label="Bottomhole"
                    value={
                      loc.bottom_lat != null
                        ? `${loc.bottom_lat.toFixed(5)}, ${loc.bottom_lon?.toFixed(5)}`
                        : null
                    }
                    mono
                  />
                  <Row
                    label="Lateral"
                    value={
                      lateral && lateral.feet > 100
                        ? `${lateral.feet.toLocaleString()} ft at ${lateral.heading}`
                        : lateral
                          ? "vertical"
                          : null
                    }
                  />
                  <Row label="API-10" value={loc.api10} mono />
                  <Row label="State code" value={loc.stcode} mono />
                  <Row label="Abstract" value={loc.abstract_label} />
                  <Row label="Survey" value={titleCase(loc.survey_name)} />
                  <Row label="Block" value={loc.block_number} />
                  <Row label="Symbol" value={loc.symbol_num} mono />
                  <Row
                    label="Coordinate reliability"
                    value={
                      loc.reliability
                        ? `code ${loc.reliability}${loc.reliability === "15" ? " (most common)" : ""}`
                        : null
                    }
                  />
                  <p className="mt-2 border-t pt-2 text-xs leading-relaxed text-muted-foreground">
                    NAD83; the RRC&rsquo;s NAD27 pair sits ~100 m away and is
                    never rendered. Symbol and reliability are RRC code values —
                    their legends are not in the mirror, so they show as codes
                    rather than guessed labels.
                  </p>
                </div>
              </Panel>
            </div>
          )}
        </TabPane>
      )}
    </SwipeUpModal>
  );
}
