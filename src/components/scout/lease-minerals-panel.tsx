"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Stat, TableBox, THead, Th } from "./modal-ui";
import { titleCase, partyName } from "@/lib/scout/format";
import {
  cadCoverageSentence,
  fmtInterest,
  fmtInterestPct,
  fmtValue,
  interestTotals,
  interestTypeLabel,
  ownerTypeLabel,
} from "@/lib/scout/cad";
import type { OwnerKey } from "@/lib/scout/cad-owners";
import type { LeaseMinerals } from "@/lib/scout/rrc-types";

/**
 * The Minerals tab: who owns the minerals under one lease, per the county
 * appraisal roll.
 *
 * Fetched when the tab opens rather than carried by the lease dossier: the
 * dossier is the slow modal, and this tab's data is independent of it. Every
 * figure here is the county's valuation for one tax year, said once in the
 * header; the sums are sums, never shares of one (the roll lists what is
 * taxed, and royalty on an Archer lease clusters at 1/8).
 */
export function LeaseMineralsPanel({
  leaseKey,
  countyNo,
  onSelectOwner,
}: {
  leaseKey: { oil_gas_code: string; district_no: string; lease_no: string };
  countyNo: string;
  onSelectOwner?: (owner: OwnerKey) => void;
}) {
  const [minerals, setMinerals] = useState<LeaseMinerals | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "not-covered" | "error">(
    "loading"
  );

  const { oil_gas_code: og, district_no: district, lease_no: no } = leaseKey;
  useEffect(() => {
    let active = true;
    async function load() {
      setState("loading");
      setMinerals(null);
      try {
        const r = await fetch(
          `/api/scout/rrc/lease/${og}/${district}/${no}/minerals?county=${encodeURIComponent(countyNo)}`
        );
        if (!active) return;
        if (r.status === 404) return setState("not-covered");
        if (!r.ok) return setState("error");
        setMinerals((await r.json()) as LeaseMinerals);
        setState("ok");
      } catch {
        if (active) setState("error");
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [og, district, no, countyNo]);

  if (state === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (state === "not-covered") return <Empty>{cadCoverageSentence()}</Empty>;
  if (state === "error" || !minerals) {
    return <Empty>Could not load the mineral roll for this lease.</Empty>;
  }

  const rollLabel = `${minerals.county_name} CAD · ${minerals.tax_year} roll`;
  if (minerals.interests.length === 0) {
    return (
      <Empty>
        Not on the {minerals.county_name} County {minerals.tax_year} mineral roll.
      </Empty>
    );
  }

  // Working interest leads the cards; the table below is largest interest
  // first, whatever its type.
  const CARD_ORDER = ["W", "R", "O"];
  const totals = [...interestTotals(minerals.interests)].sort(
    (a, b) => CARD_ORDER.indexOf(a.type) - CARD_ORDER.indexOf(b.type)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {totals.map((t) => (
          <Stat
            key={t.type}
            label={`${t.label} interest`}
            value={t.count === 0 ? "—" : fmtInterestPct(t.sum)}
            hint={
              t.count === 0
                ? "none on the roll"
                : `${t.count} owner${t.count === 1 ? "" : "s"} · ${fmtInterest(t.sum)}`
            }
          />
        ))}
        <Stat label="Appraised value" value={fmtValue(minerals.value_appraised)} hint={rollLabel} />
      </div>

      <TableBox>
        <table className="w-full text-sm">
          <THead>
            <Th>Owner</Th>
            <Th>Type</Th>
            <Th>Interest</Th>
            <Th right>Percent</Th>
            <Th right>Appraised</Th>
            <Th>Location</Th>
          </THead>
          <tbody className="divide-y">
            {minerals.interests.map((i) => (
              <tr key={i.cad_account} className="hover:bg-muted">
                <td className="px-3 py-1.5 font-medium">
                  {onSelectOwner ? (
                    <button
                      className="text-primary hover:underline"
                      onClick={() =>
                        onSelectOwner({
                          county_no: minerals.county_no,
                          tax_year: minerals.tax_year,
                          owner_id: i.owner_id,
                        })
                      }
                    >
                      {partyName(i.owner_name, { individual: i.owner_type === "I" })}
                      <ArrowUpRight className="ml-0.5 inline size-3" />
                    </button>
                  ) : (
                    partyName(i.owner_name, { individual: i.owner_type === "I" })
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {ownerTypeLabel(i.owner_type) ?? "—"}
                </td>
                <td className="px-3 py-1.5">{interestTypeLabel(i.interest_type)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {fmtInterestPct(i.interest)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {fmtValue(i.value_appraised)}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {[titleCase(i.owner_city), i.owner_state].filter(Boolean).join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
    </div>
  );
}
