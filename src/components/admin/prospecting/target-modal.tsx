"use client";

import { useEffect, useMemo, useState } from "react";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { Badge } from "@/components/ui/badge";
import { Panel, Row, Stat } from "@/components/scout/modal-ui";
import { getOperatorProfile } from "@/lib/scout/queries";
import type { OperatorProfile, OperatorWell } from "@/lib/scout/types";
import { COUNTY_NAMES } from "@/lib/scout/counties";
import { fmtDate8, fmtPhone, fmtVol, P5_STATUS, partyName, perMonth, titleCase } from "@/lib/scout/format";
import { isInjectionWell } from "@/lib/scout/well-activity";
import { monthlyRevenue } from "@/lib/scout/revenue";
import type { TargetRow } from "@/lib/admin/target-types";
import type { CommodityPrices } from "@/lib/analytics/types";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const dayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function county(code: number | null | undefined): string | null {
  if (code == null) return null;
  return COUNTY_NAMES[code] ?? `County ${code}`;
}

/**
 * A target's dossier: one page, no tabs. What a prospector checks before a
 * call, in the order they check it: the P-5 standing beside the name, the
 * size and production (and what Wildcat would bill for it), then the P-5
 * profile and the people behind the company.
 *
 * Its own modal rather than Recon's `OperatorModal`, which is the research
 * tool with eight tabs; this is the Targets desk's card. The figures are read
 * through the same `getOperatorProfile`, so a number here is the number
 * Recon's Summary tab shows for the same operator.
 */
export function TargetModal({
  target,
  prices,
  onClose,
}: {
  target: TargetRow | null;
  prices: CommodityPrices;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [shown, setShown] = useState<TargetRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!target) return;
      setShown(target);
      setLoading(true);
      setError(null);
      setProfile(null);
      try {
        const p = await getOperatorProfile(target.operatorNo);
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
    // Not cleared when `target` goes null: the modal plays a close animation.
  }, [target]);

  const op = profile?.operator ?? null;
  const wells = useMemo(() => profile?.wells ?? [], [profile]);
  // Recon's four buckets, so the active share here is the share its dossier
  // shows: plugged first, then injecting, then the activity rule.
  const buckets = useMemo(() => {
    const out = { active: 0, inactive: 0, injection: 0, plugged: 0 };
    for (const w of wells as OperatorWell[]) {
      if (w.activity === "plugged") out.plugged++;
      else if (isInjectionWell(w.well_type)) out.injection++;
      else if (w.activity === "active") out.active++;
      else out.inactive++;
    }
    return out;
  }, [wells]);

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
        [op.addr_line1, op.addr_line2, [op.city, op.state, op.zip || ""].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", ")
      )
    : null;

  const producible = buckets.active + buckets.inactive;

  return (
    <SwipeUpModal
      open={target != null}
      onClose={onClose}
      title={partyName(op?.operator_name) || shown?.name || ""}
      description={
        shown == null
          ? undefined
          : [`RRC #${shown.operatorNo}`, op?.city ? titleCase([op.city, op.state].filter(Boolean).join(", ")) : null]
              .filter(Boolean)
              .join(" · ")
      }
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
      className="h-[80vh] max-w-5xl"
    >
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

      {!loading && !error && profile && shown && (
        <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Est. revenue · per month"
              value={usd.format(monthly)}
              hint={`${annual >= 1_000_000 ? usdCompact.format(annual) : usd.format(annual)}/yr · gross`}
              title={`Trailing 12 months of the operator's reported production at $${prices.oilPerBbl.toFixed(2)}/bbl and $${prices.gasPerMcf.toFixed(2)}/MCF. Gross, before royalty, deducts and differentials.`}
            />
            <Stat label="Oil · per month" value={`${fmtVol(Math.round(oilMo))} bbl`} hint={`at $${prices.oilPerBbl.toFixed(2)}/bbl`} />
            <Stat label="Gas · per month" value={`${fmtVol(Math.round(gasMo))} MCF`} hint={`at $${prices.gasPerMcf.toFixed(2)}/MCF`} />
            <Stat
              label="Wells"
              value={profile.wellCount.toLocaleString()}
              hint={
                producible === 0
                  ? undefined
                  : `${Math.round((100 * buckets.active) / producible)}% of producible wells active${profile.capped ? " (sampled)" : ""}`
              }
            />
          </div>

          {/* What this target is worth to Wildcat: the table's own figures. */}
          <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Sub · per month"
              value={shown.projectedUsd != null ? usd.format(shown.projectedUsd) : "—"}
              hint={`${shown.activeWells.toLocaleString()} active wells billed`}
            />
            <Stat
              label="Sub · per year"
              value={shown.projectedYearUsd != null ? usd.format(shown.projectedYearUsd) : "—"}
              hint="12 × monthly"
            />
            <Stat label="Active wells" value={shown.activeWells.toLocaleString()} hint={`of ${shown.totalWells.toLocaleString()} on file`} />
            <Stat label="Target since" value={dayFormatter.format(new Date(shown.createdAt))} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="P-5 profile">
              <div className="px-4 py-2">
                <Row label="Status" value={op?.p5_status ? P5_STATUS[op.p5_status] ?? op.p5_status : null} />
                <Row label="Address" value={address} />
                <Row label="Phone" value={fmtPhone(op?.phone)} />
                <Row label="Last P-5" value={fmtDate8(op?.last_p5_date)} />
                <Row label="Oil gatherer" value={op?.oil_gatherer} />
                <Row label="Gas gatherer" value={op?.gas_gatherer} />
                <Row
                  label="Counties"
                  value={counties.length ? counties.map((c) => county(c)).filter(Boolean).join(", ") : null}
                />
                <Row label="Leases" value={profile.leaseCount.toLocaleString()} />
                <Row label="Permits granted" value={profile.permitTotal.toLocaleString()} />
              </div>
            </Panel>

            <Panel title={`Officers & principals · ${profile.officers.length}`}>
              {profile.officers.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">None on file.</p>
              ) : (
                <ul className="divide-y">
                  {profile.officers.map((o, i) => (
                    <li key={i} className="px-4 py-2">
                      <div className="text-sm font-medium">{partyName(o.officer_name)}</div>
                      <div className="text-xs text-muted-foreground">
                        {[
                          titleCase(o.officer_title),
                          titleCase([o.officer_city, o.officer_state].filter(Boolean).join(", ")),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </SwipeUpModal>
  );
}
