"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { ScoutWellsMap, type MapWell } from "./wells-map";
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
import { api8, fmtVol, titleCase, partyName } from "@/lib/scout/format";
import {
  fmtInterest,
  fmtInterestPct,
  fmtValue,
  interestTotals,
  interestTypeLabel,
  ownerTypeLabel,
} from "@/lib/scout/cad";
import type { OwnerKey } from "@/lib/scout/cad-owners";
import { getFocusWells } from "@/lib/scout/queries";
import type { FocusWell } from "@/lib/scout/types";
import type { OwnerDossier } from "@/lib/scout/rrc-types";

type TabKey = "interests" | "map" | "coowners";

/*
 * ===========================================================================
 * OWNER MODAL — the dossier for one mineral owner on a county roll.
 * ===========================================================================
 *
 * The operator modal's shape over a different party: the RRC says who runs a
 * lease, the county appraisal roll says who OWNS the minerals under it. Every
 * figure is the county's valuation for one tax year, named once in the
 * description; the volumes are the mirror's, over the twelve months ending at
 * the reported edge, and say so.
 *
 * DATA IT NEEDS  (prop `owner: OwnerDossier | null`, `/api/scout/cad/owners/..`)
 *   identity     name as filed, owner type, mailing address, county, tax year
 *   interests    one per lease: the mirror's lease name and operator, the
 *                taxed interest and type, appraised value, 12-month volumes
 *   coOwners     other owners on the same leases, by leases shared
 *
 * The Map tab asks the focus query with the owner's key -- the same read the
 * map's owner mode runs -- so the dots here are the dots there.
 */
export function OwnerModal({
  owner,
  open,
  onClose,
  onBack,
  onSelectLease,
  onSelectOwner,
  onSelectOperator,
  onSelectWell,
  loading = false,
  error = null,
  keyHint,
  elevated = false,
}: {
  owner: OwnerDossier | null;
  open: boolean;
  onClose: () => void;
  /** One step back in a stack of dossiers (see `SwipeUpModal`). */
  onBack?: () => void;
  onSelectLease: (lease: { oil_gas_code: string; district_no: string; lease_no: string }) => void;
  /** Opens another owner's dossier (a co-owner). */
  onSelectOwner: (owner: OwnerKey) => void;
  onSelectOperator?: (operatorNumber: string) => void;
  onSelectWell?: (api: string) => void;
  loading?: boolean;
  error?: string | null;
  /** The owner being fetched, so the header can name them before the dossier lands. */
  keyHint?: { name?: string | null };
  elevated?: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("interests");
  const interests = useMemo(() => owner?.interests ?? [], [owner]);
  const totals = interestTotals(interests);
  const leaseCount = new Set(
    interests.map((i) => `${i.oil_gas_code}/${i.district_no}/${i.lease_no}`)
  ).size;
  const value = interests.reduce((s, i) => s + (i.value_appraised ?? 0), 0);
  // The owner's share of each lease's twelve months, summed: net of interest,
  // so a 1/8 royalty on a 10,000 bbl lease reads as 1,250.
  const netOil = interests.reduce((s, i) => s + i.interest * i.oil_12mo, 0);
  const netGas = interests.reduce((s, i) => s + i.interest * i.gas_12mo, 0);

  const tabs: ModalTab<TabKey>[] = [
    { key: "interests", label: "Interests", count: owner ? interests.length : undefined },
    { key: "map", label: "Map" },
    { key: "coowners", label: "Co-owners", count: owner?.coOwners.length },
  ];

  const address = owner
    ? [owner.addr1, owner.addr2, [titleCase(owner.city), owner.state, owner.zip].filter(Boolean).join(" ")]
        .filter(Boolean)
        .map(String)
    : [];

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      onBack={onBack}
      elevated={elevated}
      title={
        partyName(owner?.name ?? keyHint?.name, { individual: owner?.owner_type === "I" }) ||
        "Mineral owner"
      }
      description={
        owner
          ? [
              ownerTypeLabel(owner.owner_type),
              [titleCase(owner.city), owner.state].filter(Boolean).join(", ") || null,
              `${owner.county_name} County · ${owner.tax_year} mineral roll`,
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      headerAction={
        owner ? (
          <div className="flex items-center gap-1.5">
            {totals
              .filter((t) => t.count > 0)
              .map((t) => (
                <Badge key={t.type} variant="outline">
                  {t.count} {t.label.toLowerCase()}
                </Badge>
              ))}
          </div>
        ) : undefined
      }
      className="h-[88vh] max-w-6xl"
    >
      <ModalTabs tabs={tabs} value={tab} onChange={setTab} showCounts={Boolean(owner)} />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <LoadingScreen label="Loading owner" />
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : !owner ? (
        <TabPane>
          <Empty>No owner selected.</Empty>
        </TabPane>
      ) : (
        <TabPane bare={tab === "map"}>
          {tab === "interests" && (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Appraised value"
                  value={fmtValue(value)}
                  hint={`${owner.county_name} CAD · ${owner.tax_year} roll`}
                />
                <Stat
                  label="Leases"
                  value={leaseCount.toLocaleString()}
                  hint={`${interests.length} interest${interests.length === 1 ? "" : "s"}`}
                />
                <Stat
                  label="Net oil · 12 mo"
                  value={`${fmtVol(Math.round(netOil))} bbl`}
                  hint={`interest × lease volume, through ${owner.reportedThrough}`}
                />
                <Stat
                  label="Net gas · 12 mo"
                  value={`${fmtVol(Math.round(netGas))} MCF`}
                  hint="whole-lease gas × interest; RRC lags ~3 months"
                />
              </div>

              <div className="grid shrink-0 gap-4 lg:grid-cols-2">
                <Panel title="Owner record">
                  <div className="px-4 py-2">
                    <Row label="Name as filed" value={owner.name} />
                    <Row label="Type" value={ownerTypeLabel(owner.owner_type)} />
                    <Row label="Second owner" value={titleCase(owner.owner2_name)} />
                    <Row label="Owner id" value={owner.owner_id} mono />
                    <Row label="Roll" value={`${owner.county_name} County · ${owner.tax_year}`} />
                  </div>
                </Panel>
                <Panel title="Mailing address">
                  <div className="px-4 py-2">
                    {address.length === 0 ? (
                      <p className="py-1.5 text-sm text-muted-foreground">None on the roll.</p>
                    ) : (
                      address.map((line, i) => (
                        <p key={i} className="py-0.5 text-sm font-medium">
                          {titleCase(line)}
                        </p>
                      ))
                    )}
                    {owner.country && owner.country !== "United States" && (
                      <p className="py-0.5 text-sm text-muted-foreground">{owner.country}</p>
                    )}
                  </div>
                </Panel>
              </div>

              <TableBox>
                <table className="w-full text-sm">
                  <THead>
                    <Th>Lease</Th>
                    <Th>Operator</Th>
                    <Th>Type</Th>
                    <Th right>Interest</Th>
                    <Th right>Appraised</Th>
                    <Th right>Oil · 12 mo</Th>
                    <Th right>Gas · 12 mo</Th>
                  </THead>
                  <tbody className="divide-y">
                    {interests.map((i) => (
                      <tr
                        key={i.cad_account}
                        onClick={() =>
                          onSelectLease({
                            oil_gas_code: i.oil_gas_code,
                            district_no: i.district_no,
                            lease_no: i.lease_no,
                          })
                        }
                        className="cursor-pointer hover:bg-muted"
                      >
                        <td className="px-3 py-1.5">
                          <span className="font-medium text-primary">
                            {titleCase(i.lease_name) || `Lease ${i.lease_no}`}
                          </span>
                          <span className="block font-mono text-[11px] text-muted-foreground">
                            {i.oil_gas_code === "O" ? "Oil" : "Gas"} #{i.lease_no} · District{" "}
                            {i.district_name ?? i.district_no}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {onSelectOperator && i.operator_no ? (
                            <button
                              className="text-primary hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectOperator(i.operator_no!);
                              }}
                            >
                              {partyName(i.operator_name) || `#${i.operator_no}`}
                              <ArrowUpRight className="ml-0.5 inline size-3" />
                            </button>
                          ) : (
                            partyName(i.operator_name) || "—"
                          )}
                        </td>
                        <td className="px-3 py-1.5">{interestTypeLabel(i.interest_type)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          <span className="font-mono text-xs">{fmtInterest(i.interest)}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {fmtInterestPct(i.interest)}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {fmtValue(i.value_appraised)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {i.months === 0 ? "—" : `${fmtVol(i.oil_12mo)} bbl`}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {i.months === 0 ? "—" : `${fmtVol(i.gas_12mo)} MCF`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            </div>
          )}

          {tab === "map" && (
            <OwnerWellsMap
              owner={owner}
              onSelectWell={onSelectWell}
            />
          )}

          {tab === "coowners" && (
            owner.coOwners.length === 0 ? (
              <Empty>No other owner shares a lease with this one on the roll.</Empty>
            ) : (
              <TableBox>
                <table className="w-full text-sm">
                  <THead>
                    <Th>Owner</Th>
                    <Th>Type</Th>
                    <Th right>Leases shared</Th>
                  </THead>
                  <tbody className="divide-y">
                    {owner.coOwners.map((c) => (
                      <tr
                        key={c.owner_id}
                        onClick={() =>
                          onSelectOwner({
                            county_no: owner.county_no,
                            tax_year: owner.tax_year,
                            owner_id: c.owner_id,
                          })
                        }
                        className="cursor-pointer hover:bg-muted"
                      >
                        <td className="px-3 py-1.5 font-medium text-primary">
                          {partyName(c.name, { individual: c.owner_type === "I" })}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {ownerTypeLabel(c.owner_type) ?? "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {c.shared_leases.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            )
          )}
        </TabPane>
      )}
    </SwipeUpModal>
  );
}

/**
 * The owner's wells, from the same focus query the map's owner mode runs, so
 * the dossier and the map cannot disagree about which holes the roll covers.
 * Mounted only while its tab is open: a Mapbox instance in a hidden pane
 * would size itself to a zero-height container.
 */
function OwnerWellsMap({
  owner,
  onSelectWell,
}: {
  owner: OwnerDossier;
  onSelectWell?: (api: string) => void;
}) {
  const [wells, setWells] = useState<FocusWell[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { county_no, tax_year, owner_id } = owner;

  useEffect(() => {
    let active = true;
    async function load() {
      setWells(null);
      setFailed(false);
      await getFocusWells({
      operatorNumbers: null,
      excludePlugged: false,
      countyCodes: null,
      districts: null,
      oilGas: null,
      statuses: null,
      wellTypes: null,
      minDepth: null,
      maxDepth: null,
      minCompletionYear: null,
      maxCompletionYear: null,
      minOilRate: null,
      maxOilRate: null,
      minGasRate: null,
      maxGasRate: null,
      shapes: [],
      owner: { countyNo: county_no, taxYear: tax_year, ownerId: owner_id },
    })
        .then((r) => {
          if (active) setWells(r.wells);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    }
    void load();
    return () => {
      active = false;
    };
  }, [county_no, tax_year, owner_id]);

  const mapWells = useMemo<MapWell[]>(
    () =>
      (wells ?? []).map((w) => ({
        api: w.api,
        lng: w.lng,
        lat: w.lat,
        og: w.og ?? "",
        status: w.dead ? "inactive" : w.swd ? "injection" : undefined,
        label: api8(w.api),
      })),
    [wells]
  );

  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-destructive">Could not load the owner&apos;s wells.</p>
      </div>
    );
  }
  if (wells === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoadingScreen label="Loading wells" />
      </div>
    );
  }
  return (
    <ScoutWellsMap
      wells={mapWells}
      onSelectWell={(api) => onSelectWell?.(api8(api))}
      empty="None of this owner's leases carry an on-schedule, geocoded well."
    />
  );
}
