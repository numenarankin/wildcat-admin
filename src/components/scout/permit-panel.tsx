"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { titleCase } from "@/lib/scout/format";
import { formatRate, type WellRate } from "./use-well-rates";

const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

/** How the pin was placed. Shown because the four are not equally trustworthy. */
const SOURCE_LABEL: Record<string, string> = {
  gis: "RRC GIS",
  decimal: "operator-reported",
  dms: "operator-reported (DMS)",
  state_plane: "state plane, projected",
};

/**
 * One drilling permit, in the map's side-panel column.
 *
 * THREE STATES, AND THE PANEL IS A DIFFERENT THING IN EACH (`kind` from
 * `/api/scout/rrc/pending`):
 *
 *   - **pending** — an intent, not a record, so it leads with WHO and HOW LONG
 *     rather than with volumes there are none of. `days` is the number that
 *     carries the signal: submit-to-issue runs 1 to 8 days for permits that are
 *     granted, so anything past a month is stuck or refused and the feed never
 *     says which.
 *   - **approved** — out of the queue. `days` counts from ISSUE now, so nothing
 *     here may call it a wait.
 *   - **drilled** — the permit became a hole. That is the one state with a
 *     wellbore behind it, so it is the only one where the API links and where
 *     there is a well name and production to show.
 */
export function PermitPanel({
  permit,
  onClose,
  onSelectOperator,
  onSelectWell,
  wellRate = null,
  onNeedWellRate,
}: {
  permit: Record<string, unknown> | null;
  onClose: () => void;
  onSelectOperator: (operatorNo: string) => void;
  onSelectWell: (api: string) => void;
  /**
   * The drilled hole's name and trailing rate, from the map's own rate cache —
   * the same numbers its hover popup and the well dossier show, so a permit and
   * the well it became cannot quote different production.
   */
  wellRate?: WellRate | null;
  /** Ask for that rate; a no-op once the API is cached. */
  onNeedWellRate?: (api: string) => void;
}) {
  const kind = str(permit?.kind);
  const api = str(permit?.api);
  /*
   * DRILLED, per the state's record: the permit's API has a completion date or
   * a filed W-2/G-1 (see `getApprovedPermits`). Only then is there a wellbore
   * to open, which is why the API links here and nowhere else — a pending
   * application's API is assigned during processing and points at no hole yet.
   */
  const drilled = kind === "drilled";

  useEffect(() => {
    if (drilled && api) onNeedWellRate?.(api);
  }, [drilled, api, onNeedWellRate]);

  if (!permit) return null;

  const days = num(permit.days);
  const opNo = str(permit.opNo);
  const stale = days != null && days > 30;
  /*
   * Decided, not "approved". A drilled permit is an approved one the operator
   * acted on, and both left the queue: `days` counts from ISSUE for them, so
   * labelling it "N days pending" reported a wait that had already ended — for
   * a well that is making oil.
   */
  const decided = kind === "approved" || drilled;

  return (
    <div className="no-scrollbar flex h-full w-[24rem] shrink-0 flex-col overflow-y-auto border-l bg-background shadow-xl">
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-heading text-lg font-semibold tracking-tight">
              {titleCase(str(permit.lease)) ||
                (decided ? "Drilling permit" : "Pending permit")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {[str(permit.well) && `Well ${str(permit.well)?.trim()}`,
                titleCase(str(permit.county)),
                str(permit.district) && `Dist ${str(permit.district)}`]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {/* A decided permit's clock counts from ISSUE, a pending one's from
              filing, so the two cannot share a label. */}
          <Badge variant={decided ? "default" : stale ? "outline" : "secondary"}>
            {days == null
              ? decided
                ? drilled ? "drilled" : "approved"
                : "pending"
              : decided
                ? `${drilled ? "drilled · " : ""}issued ${days} day${days === 1 ? "" : "s"} ago`
                : `${days} day${days === 1 ? "" : "s"} pending`}
          </Badge>
          {str(permit.purpose) && (
            <Badge variant="outline">{str(permit.purpose)}</Badge>
          )}
          {permit.horiz === 1 && <Badge variant="outline">Horizontal</Badge>}
        </div>
      </div>

      <div className="flex flex-col divide-y">
        <Field label="Operator">
          {opNo ? (
            <button
              onClick={() => onSelectOperator(opNo)}
              className="text-left text-primary hover:underline"
            >
              {titleCase(str(permit.op)) || opNo}
            </button>
          ) : (
            titleCase(str(permit.op)) || "—"
          )}
        </Field>
        <Field label="Total depth">
          {num(permit.depth)?.toLocaleString() ?? "—"} ft
        </Field>
        <Field label={decided ? "Issued" : "Submitted"}>
          {str(permit.submitted) ?? "—"}
        </Field>
        {!decided && <Field label="RRC queue">{str(permit.state) ?? "—"}</Field>}
        <Field label="API">
          {api && drilled ? (
            <button
              onClick={() => onSelectWell(api)}
              className="text-left font-mono text-xs text-primary hover:underline"
            >
              {api}
            </button>
          ) : api ? (
            // Not a link: an API on an undrilled permit is a number the RRC
            // assigned while working the application, and the dossier behind it
            // does not exist yet.
            <span className="font-mono text-xs">{api}</span>
          ) : (
            // 60% of pending applications have no API yet; it is assigned as
            // the application is worked, not when it is filed.
            <span className="text-muted-foreground">not yet assigned</span>
          )}
        </Field>
        {/* THE HOLE IT BECAME. The header above carries what the operator
            INTENDED to call it when they filed; this is the wellbore's own
            name on the schedule and what it has actually made. */}
        {drilled && (
          <>
            <Field label="Well">
              {/* The name opens the same dossier the API does — it is the row a
                  reader actually recognises, and making them click the number
                  beside it was asking them to use the machine's name for it. */}
              {titleCase(wellRate?.name ?? null) ? (
                api ? (
                  <button
                    onClick={() => onSelectWell(api)}
                    className="text-left text-primary hover:underline"
                  >
                    {titleCase(wellRate?.name ?? null)}
                  </button>
                ) : (
                  titleCase(wellRate?.name ?? null)
                )
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Field>
            {/* An em dash covers both "still fetching" and "the record shows
                no volume": the rate cache remembers a miss as null and cannot
                tell them apart, and guessing either way would be a claim about
                a well the panel has not heard back on. */}
            <Field label="Production">
              {formatRate(wellRate) ?? (
                <span className="text-muted-foreground">—</span>
              )}
            </Field>
          </>
        )}
        <Field label="Position">
          <span className="text-muted-foreground">
            {SOURCE_LABEL[str(permit.src) ?? ""] ?? "unknown"}
          </span>
        </Field>
      </div>

      <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        {drilled
          ? "A permit the operator acted on: the state's record carries a completion date or a filed W-2/G-1 for this API, so the hole exists. Open it for the wellbore's own record."
          : decided
            ? "An approved drilling permit. It can be drawn here only because it passed through the pending queue while this mirror was watching: the approved master carries no coordinates, so nothing issued before the window opened appears on this map."
            : "An application the RRC has received and not yet acted on. Approved permits usually issue within 1 to 8 days, so one sitting much longer is in a hearing, a mapping correction, or has been refused — the feed publishes arrivals and never announces a refusal."}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}
