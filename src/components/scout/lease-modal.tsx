"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { Badge } from "@/components/ui/badge";
import { ProductionChart } from "./production-chart";
import { ProductionSummary } from "./production-summary";
import { DispositionPanel } from "./disposition-panel";
import { LeaseMineralsPanel } from "./lease-minerals-panel";
import { ScoutWellsMap, wellStatus, type MapWell } from "./wells-map";
import { DossierSummary } from "./dossier-summary";
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
import { summariseLease } from "@/lib/ai/scout-summary";
import { api8, fmtVol, titleCase, partyName } from "@/lib/scout/format";
import { perMonthOf } from "@/lib/scout/dossier-format";
import { districtLabel } from "@/lib/scout/rrc-districts";
import { cadCoverage } from "@/lib/scout/cad";
import type { OwnerKey } from "@/lib/scout/cad-owners";
import { LoadingScreen } from "@/components/ui/loading-screen";
import type { LeaseDossier } from "@/lib/scout/rrc-types";
import { P4_PRODUCT, P4_RECORD_TYPE, P4_ROLE } from "@/lib/scout/rrc-uic";

type TabKey =
  | "summary"
  | "production"
  | "balances"
  | "disposition"
  | "counties"
  | "wells"
  | "purchaser"
  | "minerals"
  | "map";

const rate1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });


const num = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString();

/** Sum a measure over the last `months` REPORTED cycles. */
/*
 * ===========================================================================
 * LEASE MODAL — the dossier for one lease (oil_gas_code, district_no, lease_no).
 * ===========================================================================
 *
 * WHY IT IS THE CENTRE OF SCOUT
 * Texas reports production BY LEASE. Operator numbers are roll-ups of this and
 * per-well oil is an allocation of it, so this is the only grain where the
 * volumes are as published.
 *
 * DATA IT NEEDS  (prop `lease: LeaseDossier | null`)
 *   identity     oil_gas_code + district_no + lease_no (the PDQ lease key),
 *                lease_name, field_no/field_name, field_type, gas_well_no,
 *                operator_no/operator_name, district_name
 *   off_schedule LEASE_OFF_SCHED_FLAG === "Y"  (regulatory_lease)
 *   severance    LEASE_SEVERANCE_FLAG === "Y"  (regulatory_lease)
 *   monthly      LeaseMonth[]  — every cycle, oldest first
 *   disposition  per stream, per cycle, keyed by RRC disposition code
 *   counties     the county split for a lease that crosses lines
 *   wells        the wells completed on it
 *
 * WIRING NOTES
 *   - `monthly` <- `lease_cycle` filtered on the three key columns, ordered by
 *     cycle. It is indexed for exactly this lookup; a single lease's history is
 *     a needle query, not a scan. Map all 25 columns — the Allowables tab reads
 *     oil_allow / gas_allow / cond_limit / csgd_limit / *_ending_bal /
 *     gas_lift_inj_vol / csgd_gas_lift, and none of them appear anywhere else.
 *   - `LeaseMonth.reported` is false for cycles the RRC has not published yet
 *     (the last ~3). `prod_report_filed` is the RRC's own flag and is "N" on 18%
 *     of lease-months statewide. Both are zeros in the volume columns and the UI
 *     distinguishes them; if you collapse them the charts start lying.
 *   - `counties` <- `county_lease_cycle` (CNTY_LSE_* columns) grouped by
 *     COUNTY_NO. This is the only correct lease->county attribution; the lease
 *     record itself carries a district, not a county.
 *   - `wells` <- `well_completion` joined to `ewa_wellbore` for the type.
 *     `well_root_no` groups sidetracks, so two rows can be the same hole.
 *   - `off_schedule` is TRUE for 310,473 of 548,047 leases — the majority. It is
 *     styled quietly on purpose. `severance` (40,805) is the rare, loud one.
 */
export function LeaseModal({
  lease,
  open,
  onClose,
  onBack,
  onSelectOperator,
  onSelectWell,
  onSelectField,
  onSelectOwner,
  loading = false,
  error = null,
  keyHint,
  elevated = false,
}: {
  lease: LeaseDossier | null;
  open: boolean;
  onClose: () => void;
  /** One step back in a stack of dossiers (see `SwipeUpModal`). */
  onBack?: () => void;
  onSelectOperator: (operatorNumber: string) => void;
  onSelectWell: (api: string) => void;
  /** Opens the field dossier. Optional so callers that have no field
   *  modal mounted keep rendering the name as plain text. */
  onSelectField?: (fieldNo: string) => void;
  /** Opens a mineral owner's dossier from the Minerals tab. Optional so callers
   *  without an owner modal mounted keep rendering the name as plain text. */
  onSelectOwner?: (owner: OwnerKey) => void;
  /** For callers that fetch on open rather than handing over a finished dossier. */
  loading?: boolean;
  error?: string | null;
  /** The lease being fetched, so the header can name it before the dossier lands. */
  keyHint?: { oil_gas_code: string; district_no: string; lease_no: string };
  /** Raise above another open modal — the well or operator it was opened from. */
  elevated?: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("summary");
  const p4 = lease?.p4 ?? { connections: [], filings: [] };

  const monthly = lease?.monthly ?? [];
  const oilMo = perMonthOf(monthly, "oil_prod_vol");
  const gasMo = perMonthOf(monthly, "gas_prod_vol");
  const unfiled = monthly.filter((m) => m.reported && m.prod_report_filed === "N").length;
  const reported = monthly.filter((m) => m.reported).length;
  const lastFlowing = [...monthly].reverse().find((m) => m.oil_prod_vol || m.gas_prod_vol);
  /*
   * The county whose mineral roll the Minerals tab reads: the lease's dominant
   * county (`counties` is ordered by oil). Only a county with a roll loaded
   * gets the tab at all -- one county today (see `cadCoverage`) -- so a lease
   * elsewhere never shows a tab that can only say "not covered".
   */
  const roll = lease ? cadCoverage(lease.counties[0]?.county_no) : null;

  const tabs: ModalTab<TabKey>[] = [
    { key: "summary", label: "Summary" },
    { key: "production", label: "Production" },
    { key: "balances", label: "Allowables" },
    { key: "disposition", label: "Disposition" },
    { key: "counties", label: "Counties", count: lease?.counties.length },
    { key: "wells", label: "Wells", count: lease?.wells.length },
    ...(roll ? ([{ key: "minerals", label: "Minerals" }] as ModalTab<TabKey>[]) : []),
    // Only when the P-4 says something. A lease with no connections and no
    // filings would otherwise open an empty tab, which reads as a bug rather
    // than as "the state has nothing on file".
    // Present while loading too, so the row does not grow under the cursor once
    // the dossier lands.
    ...(loading || p4.connections.length > 0 || p4.filings.length > 0
      ? ([
          {
            key: "purchaser",
            label: "Purchaser",
            count: loading ? undefined : p4.filings.length,
          },
        ] as ModalTab<TabKey>[])
      : []),
    { key: "map", label: "Map" },
  ];

  const latest = monthly.filter((m) => m.reported).at(-1);

  /*
   * The lease's holes, flattened for the map.
   *
   * Coloured by the LEASE's commodity, not the well's: `well_completion` gives
   * a well type (PRODUCING / INJECTION / SHUT IN), never oil-vs-gas, and the
   * lease key already settles which one this is. The type goes in the popup,
   * where it is the more useful of the two anyway.
   *
   * Memoised on `lease` because `ScoutWellsMap` keys its data effect on the
   * array's identity and would otherwise re-fit the viewport every render.
   */
  const mapWells = useMemo<MapWell[]>(
    () =>
      (lease?.wells ?? [])
        .filter((w) => w.lat != null && w.lon != null)
        .map((w) => ({
          api: Number(w.api_number),
          lng: w.lon as number,
          lat: w.lat as number,
          og: lease?.oil_gas_code ?? "",
          status: wellStatus(w.well_type_name),
          // A plugged hole keeps its own encoding on the page map; the lease
          // record carries no plugging flag, so nothing is claimed here.
          label: `${titleCase(lease?.lease_name) || "Lease"} ${w.well_no ?? ""}`.trim(),
          sub: [api8(Number(w.api_number)), titleCase(w.well_type_name), titleCase(w.county_name)]
            .filter(Boolean)
            .join(" · "),
        })),
    [lease]
  );
  const ungeocoded = (lease?.wells.length ?? 0) - mapWells.length;

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      onBack={onBack}
      elevated={elevated}
      title={
        titleCase(lease?.lease_name) ||
        `Lease ${lease?.lease_no ?? keyHint?.lease_no ?? ""}`
      }
      description={
        lease
          ? [
              `${lease.oil_gas_code === "O" ? "Oil" : "Gas"} lease #${lease.lease_no}`,
              // `district_name` is already the real RRC label ("09"), so it and
              // `districtLabel(district_no)` are the same string — printing
              // both gave "District 09 · 09". The code itself (13) is internal
              // and is never shown.
              `District ${lease.district_name || districtLabel(lease.district_no)}`,
              titleCase(lease.field_name),
            ]
              .filter(Boolean)
              .join(" · ")
          : // Before the dossier lands the key is all there is to name it by.
            keyHint
            ? `${keyHint.oil_gas_code === "O" ? "Oil" : "Gas"} lease #${keyHint.lease_no} · District ${districtLabel(keyHint.district_no)}`
            : undefined
      }
      headerAction={
        <div className="flex items-center gap-1.5">
          {/* Severance is rare (40,805 of 548,047) — loud. Off-schedule is the
              majority (310,473) — quiet, or it screams on most leases. */}
          {lease?.severance && <Badge variant="destructive">Severed</Badge>}
          {lease?.off_schedule && <Badge variant="outline">Off schedule</Badge>}
        </div>
      }
      className="h-[88vh] max-w-6xl"
    >
      <ModalTabs
        tabs={tabs}
        value={tab}
        onChange={setTab}
        showCounts={Boolean(lease)}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <LoadingScreen label="Loading lease" />
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : !lease ? (
        <TabPane>
          <Empty>No lease selected.</Empty>
        </TabPane>
      ) : (
        // The map owns its whole pane (no padding, no scroll); every other tab
        // scrolls inside it — same contract as the operator dossier.
        <TabPane bare={tab === "map"}>
          {tab === "summary" && (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Oil · per month"
                  value={`${fmtVol(Math.round(oilMo))} bbl`}
                  hint={`${reported} reported months on file`}
                />
                <Stat
                  label="Gas · per month"
                  value={`${fmtVol(Math.round(gasMo))} MCF`}
                />
                <Stat
                  label="Wells on lease"
                  value={lease.wells.length.toLocaleString()}
                  hint={`${lease.counties.length} count${lease.counties.length === 1 ? "y" : "ies"}`}
                />
                <Stat
                  label="Reports not filed"
                  value={unfiled.toLocaleString()}
                  hint={`of ${reported} reported months`}
                  title="Months where the RRC has published the cycle but this lease filed no production report. They read as zero volume and are not the same as a shut-in."
                />
              </div>

              {/* Keyed on the lease for the same reason the well modal keys on
                  the API: the instance outlives the record it is showing. */}
              <DossierSummary
                key={`${lease.oil_gas_code}-${lease.district_no}-${lease.lease_no}`}
                run={() =>
                  summariseLease(
                    lease.oil_gas_code,
                    lease.district_no,
                    lease.lease_no
                  )
                }
              />

              <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
                <Panel title="Lease record">
                  <div className="px-4 py-2">
                    <Row label="Lease no." value={lease.lease_no} mono />
                    <Row
                      label="Type"
                      value={lease.oil_gas_code === "O" ? "Oil" : "Gas"}
                    />
                    {/* The real district label, not PDQ's internal code — the
                        code has values (11, 13, 14) that name no real district. */}
                    <Row
                      label="District"
                      value={lease.district_name || districtLabel(lease.district_no)}
                    />
                    <Row
                      label="Field"
                      value={
                        onSelectField && lease.field_no ? (
                          <button
                            className="text-primary hover:underline"
                            onClick={() => onSelectField(lease.field_no!)}
                          >
                            {titleCase(lease.field_name) || `Field ${lease.field_no}`}
                            <ArrowUpRight className="ml-0.5 inline size-3" />
                          </button>
                        ) : (
                          titleCase(lease.field_name)
                        )
                      }
                    />
                    <Row label="Field no." value={lease.field_no} mono />
                    <Row label="Field type" value={lease.field_type} />
                    <Row label="Gas well no." value={lease.gas_well_no} />
                    <Row
                      label="Operator"
                      value={
                        lease.operator_no ? (
                          <button
                            className="text-primary hover:underline"
                            onClick={() => onSelectOperator(lease.operator_no!)}
                          >
                            {partyName(lease.operator_name)}
                            <ArrowUpRight className="ml-0.5 inline size-3" />
                          </button>
                        ) : null
                      }
                    />
                    <Row
                      label="Schedule"
                      value={lease.off_schedule ? "Off schedule" : "On schedule"}
                    />
                    <Row
                      label="Severance"
                      value={lease.severance ? "Severed" : "None"}
                    />
                  </div>
                </Panel>

                <Panel title={`Latest reported cycle${latest ? ` · ${latest.cycle}` : ""}`}>
                  <div className="px-4 py-2">
                    <Row label="Oil" value={`${num(latest?.oil_prod_vol)} bbl`} />
                    <Row label="Oil allowable" value={num(latest?.oil_allow)} />
                    <Row label="Oil in tank" value={num(latest?.oil_ending_bal)} />
                    <Row label="Gas" value={`${num(latest?.gas_prod_vol)} MCF`} />
                    <Row label="Gas allowable" value={num(latest?.gas_allow)} />
                    <Row label="Condensate" value={`${num(latest?.cond_prod_vol)} bbl`} />
                    <Row label="Casinghead" value={`${num(latest?.csgd_prod_vol)} MCF`} />
                    <Row
                      label="Report filed"
                      value={latest?.prod_report_filed === "N" ? "No" : "Yes"}
                    />
                    {lastFlowing && (
                      <Row label="Last month with volume" value={lastFlowing.cycle} />
                    )}
                  </div>
                </Panel>
              </div>
            </div>
          )}

          {tab === "production" && (
            <TabPane>
              <ProductionSummary monthly={monthly} />
              <ProductionChart monthly={monthly} />
            </TabPane>
          )}

          {tab === "balances" && (
            <>
              <TableBox>
                <table className="w-full text-sm">
                  <THead>
                    <Th>Cycle</Th>
                    <Th right>Oil</Th>
                    <Th right>Oil allow</Th>
                    <Th right>In tank</Th>
                    <Th right>Gas</Th>
                    <Th right>Gas allow</Th>
                    <Th right>Gas lift inj.</Th>
                    <Th right>Filed</Th>
                  </THead>
                  <tbody className="divide-y">
                    {[...monthly]
                      .reverse()
                      .slice(0, 240)
                      .map((m) => (
                        <tr key={m.cycle} className="hover:bg-muted">
                          <td className="px-3 py-1.5 font-mono text-xs">{m.cycle}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{num(m.oil_prod_vol)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{num(m.oil_allow)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{num(m.oil_ending_bal)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{num(m.gas_prod_vol)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{num(m.gas_allow)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{num(m.gas_lift_inj_vol)}</td>
                          <td className="px-3 py-1.5 text-right">
                            {!m.reported ? (
                              <span className="text-xs text-muted-foreground">pending</span>
                            ) : m.prod_report_filed === "N" ? (
                              <span className="text-xs text-amber-600 dark:text-amber-400">no</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">yes</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableBox>
            </>
          )}

          {tab === "disposition" && (
            <DispositionPanel disposition={lease.disposition} />
          )}

          {tab === "counties" && (
            <>
              <TableBox>
                <table className="w-full text-sm">
                  <THead>
                    <Th>County</Th>
                    <Th right>Oil (bbl)</Th>
                    <Th right>Gas (MCF)</Th>
                    <Th right>Condensate</Th>
                    <Th right>Casinghead</Th>
                  </THead>
                  <tbody className="divide-y">
                    {lease.counties.map((c) => (
                      <tr key={c.county_no} className="hover:bg-muted">
                        <td className="px-3 py-1.5">{titleCase(c.county_name)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{num(c.oil_prod_vol)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{num(c.gas_prod_vol)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{num(c.cond_prod_vol)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{num(c.csgd_prod_vol)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            </>
          )}

          {tab === "wells" && (
            <>
              <TableBox>
                <table className="w-full text-sm">
                  <THead>
                    <Th>API</Th>
                    <Th>Well</Th>
                    <Th>Status</Th>
                    <Th>County</Th>
                    <Th right>Oil (bbl/d)</Th>
                    <Th right>Gas (MCF/d)</Th>
                    <Th right>Root</Th>
                  </THead>
                  <tbody className="divide-y">
                    {lease.wells.map((w) => (
                      <tr
                        key={w.api_number}
                        onClick={() => onSelectWell(w.api_number)}
                        className="cursor-pointer hover:bg-muted"
                      >
                        <td className="px-3 py-1.5 font-mono text-xs text-primary">
                          {api8(Number(w.api_number))}
                        </td>
                        <td className="px-3 py-1.5">{w.well_no}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {titleCase(w.well_type_name)}
                        </td>
                        <td className="px-3 py-1.5">{titleCase(w.county_name)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {w.oil_bbl_per_day == null
                            ? "—"
                            : rate1.format(w.oil_bbl_per_day)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {w.gas_mcf_per_day == null
                            ? "—"
                            : rate1.format(w.gas_mcf_per_day)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                          {w.well_root_no}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            </>
          )}

          {/* Mounted only while its tab is open: a Mapbox instance in a hidden
              pane would boot and size itself to a zero-height container. */}
          {tab === "purchaser" && (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              {p4.connections.length > 0 && (
                <Panel title="Who takes this lease's product">
                  <TableBox>
                    <table className="w-full text-sm">
                      <THead>
                        <Th>Product</Th>
                        <Th>Role</Th>
                        <Th>Company</Th>
                        <Th right>Share</Th>
                        <Th right>Since</Th>
                      </THead>
                      <tbody className="divide-y">
                        {p4.connections.map((c, i) => (
                          <tr key={i} className="hover:bg-muted">
                            <td className="px-3 py-1.5">
                              {P4_PRODUCT[c.product_code ?? ""] ?? c.product_code}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {P4_ROLE[c.type_code ?? ""] ?? c.type_code}
                            </td>
                            <td className="px-3 py-1.5 font-medium">
                              {partyName(c.operator_name) ||
                                (c.gpn_no ? `#${c.gpn_no}` : "—")}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {c.actual_percent != null
                                ? `${Math.round(c.actual_percent * 1000) / 10}%`
                                : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {c.effective_date ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableBox>
                </Panel>
              )}

              {p4.filings.length > 0 && (
                <Panel title={`Filing history (${p4.filings.length})`}>
                  <TableBox>
                    <table className="w-full text-sm">
                      <THead>
                        <Th>Effective</Th>
                        <Th>Changed</Th>
                        <Th>Operator on the filing</Th>
                        <Th right>Type</Th>
                      </THead>
                      <tbody className="divide-y">
                        {p4.filings.slice(0, 60).map((f, i) => (
                          <tr key={i} className="hover:bg-muted">
                            <td className="px-3 py-1.5 tabular-nums">
                              {f.effective_date ?? "—"}
                            </td>
                            <td className="px-3 py-1.5">
                              <div className="flex flex-wrap gap-1">
                                {f.changes.map((c) => (
                                  <Badge
                                    key={c}
                                    variant={
                                      c === "Operator" || c === "Purchaser"
                                        ? "secondary"
                                        : "outline"
                                    }
                                  >
                                    {c}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {partyName(f.operator_name) ||
                                (f.operator_no && f.operator_no !== "000000"
                                  ? `#${f.operator_no}`
                                  : "—")}
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">
                              {P4_RECORD_TYPE[f.record_type ?? ""] ?? f.record_type}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableBox>
                  {p4.filings.length > 60 && (
                    <p className="px-4 py-2 text-xs text-muted-foreground">
                      Showing the 60 most recent of {p4.filings.length} filings.
                    </p>
                  )}
                </Panel>
              )}

            </div>
          )}

          {tab === "minerals" && roll && (
            <LeaseMineralsPanel
              leaseKey={{
                oil_gas_code: lease.oil_gas_code,
                district_no: lease.district_no,
                lease_no: lease.lease_no,
              }}
              countyNo={roll.countyNo}
              onSelectOwner={onSelectOwner}
            />
          )}

          {tab === "map" && (
            <ScoutWellsMap
              wells={mapWells}
              onSelectWell={(api) => onSelectWell(api8(api))}
              note={
                ungeocoded > 0
                  ? `${ungeocoded} of ${lease.wells.length} wells are not geocoded by the RRC and are not plotted.`
                  : undefined
              }
              empty={
                lease.wells.length === 0
                  ? "No wells are completed on this lease."
                  : "None of this lease's wells carry coordinates."
              }
            />
          )}
        </TabPane>
      )}
    </SwipeUpModal>
  );
}
