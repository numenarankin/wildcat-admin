"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Move } from "@/components/analytics/move-pair";
import { SortableTable, type SortColumn } from "@/components/admin/analytics/sortable-table";
import { VisitorPanel } from "@/components/admin/gtm/visitor-panel";
import { VisitorsMap } from "@/components/admin/gtm/visitors-map";
import { getLandingData, getLandingMap } from "@/lib/admin/gtm/actions";
import { count, demoName, fmtDateTime, fmtDuration, pageName, percent } from "@/lib/admin/gtm/format";
import type { DemoTableRow, GtmRange, LandingData, MapPoint, VisitorTableRow } from "@/lib/admin/gtm/types";

type Tab = "landing";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [{ id: "landing", label: "Landing" }];

type View = "visitors" | "map" | "demos";
const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: "visitors", label: "Visitors" },
  { value: "map", label: "Map" },
  { value: "demos", label: "Demos" },
];

const PRESETS = [7, 30, 90] as const;
type Preset = (typeof PRESETS)[number];

/** The analytics page's segmented window control. */
function PresetToggle({
  value,
  onChange,
  label,
  custom,
}: {
  value: Preset | "custom";
  onChange: (v: Preset | "custom") => void;
  label: string;
  /** Offer a Custom option (the map's range). */
  custom?: boolean;
}) {
  const options: (Preset | "custom")[] = custom ? [...PRESETS, "custom"] : [...PRESETS];
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5 rounded-sm bg-muted p-0.5">
      {options.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={value === d}
          onClick={() => onChange(d)}
          className={cn(
            "rounded-sm px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
            value === d && "bg-background text-foreground shadow-sm hover:text-foreground"
          )}
        >
          {d === "custom" ? "Custom" : `${d}D`}
        </button>
      ))}
    </div>
  );
}

/** The dashboard's stat tile, with one move: against the same span just before. */
function GtmStat({ label, value, move, hint }: { label: string; value: string; move?: number | null; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[0.15rem] border px-4 py-3">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="truncate text-lg font-semibold tabular-nums">{value}</span>
        {move !== undefined && hint ? (
          <span className="text-xs tabular-nums">
            <Move value={move} hint={hint} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

const VISITOR_COLUMNS: SortColumn<VisitorTableRow>[] = [
  { key: "company", label: "Visitor", numeric: false, sortValue: (r) => r.company ?? "", cell: (r) => r.company ?? "Anonymous", className: "font-medium" },
  { key: "location", label: "Location", numeric: false, sortValue: (r) => r.location, cell: (r) => r.location ?? "—", className: "text-muted-foreground" },
  { key: "visits", label: "Visits", numeric: true, sortValue: (r) => r.visits, cell: (r) => count.format(r.visits) },
  { key: "engaged", label: "Engaged", numeric: true, sortValue: (r) => r.engagedMs, cell: (r) => fmtDuration(r.engagedMs) },
  { key: "scroll", label: "Max scroll", numeric: true, sortValue: (r) => r.maxScrollPct, cell: (r) => `${r.maxScrollPct}%` },
  { key: "demos", label: "Demos", numeric: true, sortValue: (r) => r.demosWatched, cell: (r) => count.format(r.demosWatched) },
  { key: "lastSeen", label: "Last seen", numeric: true, sortValue: (r) => r.lastSeenAt, cell: (r) => fmtDateTime(r.lastSeenAt) },
];

const DEMO_COLUMNS: SortColumn<DemoTableRow>[] = [
  { key: "demo", label: "Demo", numeric: false, sortValue: (r) => demoName(r.demo), cell: (r) => demoName(r.demo), className: "font-medium" },
  { key: "page", label: "Page", numeric: false, sortValue: (r) => r.path, cell: (r) => pageName(r.path), className: "text-muted-foreground" },
  { key: "plays", label: "Plays", numeric: true, sortValue: (r) => r.plays, cell: (r) => count.format(r.plays) },
  { key: "viewers", label: "Viewers", numeric: true, sortValue: (r) => r.uniqueViewers, cell: (r) => count.format(r.uniqueViewers) },
  {
    key: "progress",
    label: "Avg furthest",
    numeric: true,
    sortValue: (r) => r.avgProgressPct,
    cell: (r) => (r.avgProgressPct == null ? "—" : `${Math.round(r.avgProgressPct)}%`),
  },
  {
    key: "completion",
    label: "Finished",
    numeric: true,
    sortValue: (r) => r.completionRate,
    cell: (r) => (r.completionRate == null ? "—" : percent.format(r.completionRate)),
  },
  { key: "watched", label: "Avg watched", numeric: true, sortValue: (r) => r.avgWatchedMs, cell: (r) => fmtDuration(r.avgWatchedMs) },
];

/** A picked day as `YYYY-MM-DD`, read in the viewer's calendar (the picker's own). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The map's dots for its own range, read when the Map view first opens and on every range change. */
function useMapPoints(enabled: boolean, range: GtmRange | null) {
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = range ? JSON.stringify(range) : null;
  useEffect(() => {
    if (!enabled || !key) return;
    let active = true;
    getLandingMap(JSON.parse(key) as GtmRange)
      .then((p) => {
        if (!active) return;
        setPoints(p);
        setError(null);
      })
      .catch(() => {
        if (active) setError("Could not load the map's visitors.");
      });
    return () => {
      active = false;
    };
  }, [enabled, key]);
  return { points, error };
}

/**
 * The GTM page: tabs across the top (Landing, the first), the page's range,
 * the summary row, then one view at a time under a View dropdown, the way
 * Recon's View selector swaps the area under its bar. The map keeps its own
 * range, defaulting to the last 7 days.
 */
export function GtmWorkspace({ initial }: { initial: LandingData }) {
  const [tab, setTab] = useState<Tab>("landing");
  const [days, setDays] = useState<Preset>(30);
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [view, setView] = useState<View>("visitors");
  const [visitorId, setVisitorId] = useState<string | null>(null);

  const [mapPreset, setMapPreset] = useState<Preset | "custom">(7);
  const [mapFrom, setMapFrom] = useState<Date | null>(null);
  const [mapTo, setMapTo] = useState<Date | null>(null);
  const mapRange: GtmRange | null =
    mapPreset === "custom"
      ? mapFrom && mapTo
        ? { from: isoDay(mapFrom), to: isoDay(mapTo) }
        : null
      : { days: mapPreset };
  const map = useMapPoints(view === "map", mapRange);

  const changeDays = useCallback((d: Preset) => {
    setDays(d);
    startTransition(async () => {
      try {
        setData(await getLandingData({ days: d }));
        setError(null);
      } catch {
        setError("Could not load the landing data.");
      }
    });
  }, []);

  const { stats } = data;
  const hint = `Against the ${days} days before.`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-8">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-1">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "cursor-pointer font-heading text-2xl font-semibold tracking-tight transition-colors",
              tab === id ? "text-foreground" : "text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-1 pb-2">
        <div className="flex flex-wrap items-center gap-3">
          <PresetToggle value={days} onChange={(d) => d !== "custom" && changeDays(d)} label="Range" />
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>

        <div className={cn("grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5", pending && "opacity-60")}>
          <GtmStat label="Visits" value={count.format(stats.visits)} move={stats.change.visits} hint={hint} />
          <GtmStat label="Unique visitors" value={count.format(stats.uniqueVisitors)} move={stats.change.uniqueVisitors} hint={hint} />
          <GtmStat
            label="Identified companies"
            value={count.format(stats.identifiedCompanies)}
            move={stats.change.identifiedCompanies}
            hint={hint}
          />
          <GtmStat label="Texas share" value={stats.texasShare == null ? "—" : percent.format(stats.texasShare)} />
          <GtmStat
            label="Top city"
            value={stats.topCity ? `${stats.topCity.city}${stats.topCity.state ? `, ${stats.topCity.state}` : ""}` : "—"}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Select value={view} onValueChange={(v) => setView((v as View) ?? "visitors")}>
            <SelectTrigger className="h-9 w-40">
              <span className="truncate">{VIEWS.find((v) => v.value === view)?.label}</span>
            </SelectTrigger>
            <SelectContent>
              {VIEWS.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {view === "map" && (
            <>
              <PresetToggle value={mapPreset} onChange={setMapPreset} label="Map range" custom />
              {mapPreset === "custom" && (
                <>
                  <DatePicker value={mapFrom} onChange={setMapFrom} placeholder="From" className="h-9" />
                  <DatePicker value={mapTo} onChange={setMapTo} placeholder="To" className="h-9" />
                </>
              )}
              {map.error && <span className="text-sm text-destructive">{map.error}</span>}
            </>
          )}
        </div>

        <div className={cn("min-h-0 flex-1", pending && view !== "map" && "opacity-60")}>
          {view === "visitors" && (
            <SortableTable
              rows={data.visitors}
              columns={VISITOR_COLUMNS}
              rowKey={(r) => r.visitorId}
              defaultSort="lastSeen"
              empty="No visitors in this range."
              onRowClick={(r) => setVisitorId(r.visitorId)}
            />
          )}
          {view === "map" && (
            <div className="h-[36rem] overflow-hidden rounded-[0.15rem] border">
              <VisitorsMap points={map.points} onSelect={setVisitorId} />
            </div>
          )}
          {view === "demos" && (
            <SortableTable rows={data.demos} columns={DEMO_COLUMNS} rowKey={(r) => r.key} defaultSort="plays" empty="No demos played in this range." />
          )}
        </div>
      </div>

      <VisitorPanel visitorId={visitorId} onClose={() => setVisitorId(null)} />
    </div>
  );
}
