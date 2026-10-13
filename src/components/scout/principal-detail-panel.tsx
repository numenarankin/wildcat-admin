"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getPerson } from "@/lib/scout/rrc-people";
import { loadOperatorPoints } from "@/lib/scout/operator-points";
import type { PersonAffiliation, PersonDossier } from "@/lib/scout/rrc-types";
import { fmtUsd, fmtVol, perMonth, P5_STATUS, partyName } from "@/lib/scout/format";
import {
  OperatorListControls,
  useOperatorList,
} from "@/components/scout/operator-list-controls";

/** An affiliation carrying the well count the shared list sorts on. */
interface AffiliationRow extends PersonAffiliation {
  n: number;
  nm: string | null;
  w: number;
}

/**
 * Who a principal is: every P-5 operator the RRC lists them on.
 *
 * Read from the RRC mirror rather than Archon's copy — the same lookup the
 * Person picker and the map's person filter use, so the operators listed here
 * are exactly the ones the map is drawing (`rrc-people.ts`).
 *
 * The list sorts and filters on the same terms as the cluster panel
 * (`operator-list-controls.tsx`), because it is the same kind of list. Well
 * counts come from the operator points — the file behind the map's own dots —
 * so a person's biggest operator here is the same one the map draws biggest.
 */
export function PrincipalDetailPanel({
  name,
  onClose,
  onSelectOperator,
}: {
  name: string | null;
  onClose: () => void;
  onSelectOperator: (operatorNumber: number) => void;
}) {
  const [detail, setDetail] = useState<PersonDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wellCounts, setWellCounts] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    let active = true;
    async function load() {
      if (name == null) return;
      setLoading(true);
      setError(null);
      setDetail(null);
      try {
        const d = await getPerson(name);
        if (active) setDetail(d);
      } catch {
        if (active) setError("Could not load principal detail.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [name]);

  // Well counts, from the client-cached points file the map already loads. Its
  // own failure is not the panel's: without it every row reads zero wells and
  // the well-count sort is flat, which is worse than the list but far better
  // than no list.
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const pts = await loadOperatorPoints();
        if (active) setWellCounts(new Map(pts.map((p) => [p.n, p.w])));
      } catch {
        /* leave counts empty */
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const affiliations = useMemo(
    () => detail?.affiliations ?? [],
    [detail]
  );

  const rows = useMemo<AffiliationRow[]>(
    () =>
      affiliations.map((a) => ({
        ...a,
        n: a.operator_number,
        nm: a.operator_name,
        w: wellCounts.get(a.operator_number) ?? 0,
      })),
    [affiliations, wellCounts]
  );

  const { sort, setSort, activity, setActivity, visible, production, revenueOf } =
    useOperatorList(rows);

  if (name == null) return null;

  const where = affiliations.find((a) => a.officer_city || a.officer_state);
  const location = where
    ? [where.officer_city, where.officer_state].filter(Boolean).join(", ")
    : null;

  return (
    <div className="no-scrollbar flex h-full w-[24rem] shrink-0 flex-col overflow-y-auto border-l bg-background shadow-xl">
      <div className="sticky top-0 flex items-center justify-between border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0">
          <div className="truncate font-heading text-lg font-semibold tracking-tight">
            {partyName(name)}
          </div>
          <div className="text-xs text-muted-foreground">
            Principal / officer{location ? ` · ${location}` : ""}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {loading && <Skeleton className="h-40 w-full" />}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {!loading && !error && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {/* Both counts while filtering, so a short list reads as filtered
                  rather than as a person with fewer companies than they have. */}
              Affiliated operators (
              {visible.length === affiliations.length
                ? affiliations.length
                : `${visible.length} of ${affiliations.length}`}
              )
            </h3>
            {affiliations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No operators on file.</p>
            ) : (
              <>
                <div className="mb-2">
                  <OperatorListControls
                    sort={sort}
                    onSort={setSort}
                    activity={activity}
                    onActivity={setActivity}
                  />
                </div>
                {visible.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No operators with that activity.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y rounded-md border">
                    {visible.map((a, i) => (
                      <li key={`${a.operator_number}-${i}`}>
                        <button
                          onClick={() => onSelectOperator(a.operator_number)}
                          className="flex w-full items-start justify-between gap-2 px-2.5 py-2 text-left hover:bg-muted"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-primary">
                              {partyName(a.operator_name) || `Operator #${a.operator_number}`}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {[
                                a.officer_title,
                                a.p5_status
                                  ? P5_STATUS[a.p5_status] ?? a.p5_status
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                          {/* Mirrors the cluster panel's right rail: the well
                              count always, and the volume behind whichever
                              production sort is active. */}
                          <span className="shrink-0 text-right text-xs text-muted-foreground">
                            <span className="block">
                              {a.w.toLocaleString()} {a.w === 1 ? "well" : "wells"}
                            </span>
                            {sort === "revenue" && (
                              <span className="block">{fmtUsd(revenueOf(a.n))}/mo</span>
                            )}
                            {sort === "oil" && (
                              <span className="block">
                                {fmtVol(Math.round(perMonth(production.get(a.n)?.oil, production.get(a.n)?.months)))} bbl/mo
                              </span>
                            )}
                            {sort === "gas" && (
                              <span className="block">
                                {fmtVol(Math.round(perMonth(production.get(a.n)?.gas, production.get(a.n)?.months)))} MCF/mo
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
