"use client";

import { Fragment, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { DeltaPct } from "@/components/delta-pct";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AdminMetricsChart, type ChartView } from "@/components/admin/admin-metrics-chart";
import { SortableTable, type SortColumn } from "@/components/admin/analytics/sortable-table";
import {
  ONBOARDING_STEPS,
  type AnalyticsDemo,
  type FeatureRow,
  type HealthRisk,
  type HealthRow,
  type OnboardingOrg,
  type PageRow,
} from "@/lib/admin/analytics-demo";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { tabSlice } from "@/lib/ai/admin/page-slices";

type Section = "health" | "activity" | "onboarding" | "features" | "pages";

const NAV: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "health", label: "Health" },
  { id: "activity", label: "Activity" },
  { id: "onboarding", label: "Onboarding" },
  { id: "features", label: "Features" },
  { id: "pages", label: "Pages" },
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");
const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
  timeZone: ADMIN_TIME_ZONE,
});

const TERM_LABEL = { month: "Monthly", year: "Annual" } as const;

/** Tinted like the customers table's status pills; the rank is the sort order. */
const RISK: Record<HealthRisk, { label: string; badge: string; rank: number }> = {
  high: { label: "High", badge: "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400", rank: 2 },
  medium: { label: "Medium", badge: "border-amber-400/30 bg-amber-400/15 text-amber-600 dark:text-amber-300", rank: 1 },
  low: { label: "Low", badge: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", rank: 0 },
};

const ago = (days: number | null) =>
  days === null ? "Never" : days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;

const duration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
};

const trendCell = (value: number | null) =>
  value === null ? <span className="text-muted-foreground">—</span> : <DeltaPct value={value} />;

/**
 * /admin/analytics: how customers use the app. The Settings page's shape
 * (header-styled tabs, a panel per tab). Dummy data for now
 * (`analytics-demo.ts`); nothing is tracked yet.
 */
export function AnalyticsWorkspace({ data, initialSection }: { data: AnalyticsDemo; initialSection?: string }) {
  const [section, setSection] = useState<Section>(
    NAV.some((n) => n.id === initialSection) ? (initialSection as Section) : "health"
  );
  usePageContextSlice(
    "admin-analytics",
    tabSlice("Analytics", NAV.find((n) => n.id === section)?.label ?? section, [
      "Every number on this page is placeholder demo data; nothing is tracked yet. Never quote it as real.",
    ])
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-10">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-1">
        {NAV.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={section === id}
            onClick={() => setSection(id)}
            className={cn(
              "cursor-pointer font-heading text-2xl font-semibold tracking-tight transition-colors",
              section === id ? "text-foreground" : "text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-1 pb-2">
        {section === "health" && <HealthTab rows={data.health} />}
        {section === "activity" && <ActivityTab data={data} />}
        {section === "onboarding" && <OnboardingTab orgs={data.onboarding} />}
        {section === "features" && <FeaturesTab rows={data.features} />}
        {section === "pages" && <PagesTab rows={data.pages} />}
      </div>
    </div>
  );
}

const HEALTH_COLUMNS: SortColumn<HealthRow>[] = [
  { key: "name", label: "Company", numeric: false, sortValue: (r) => r.name, cell: (r) => r.name, className: "font-medium" },
  { key: "term", label: "Term", numeric: false, sortValue: (r) => r.term, cell: (r) => TERM_LABEL[r.term] },
  { key: "mrr", label: "MRR", numeric: true, sortValue: (r) => r.mrrUsd, cell: (r) => usd.format(r.mrrUsd) },
  {
    key: "lastActive",
    label: "Last active",
    numeric: true,
    sortValue: (r) => r.daysSinceActive,
    cell: (r) => ago(r.daysSinceActive),
  },
  {
    key: "seats",
    label: "Active seats (7d)",
    numeric: true,
    sortValue: (r) => r.activeSeats / r.seats,
    cell: (r) => `${r.activeSeats} of ${r.seats}`,
  },
  { key: "wow", label: "Activity (WoW)", numeric: true, sortValue: (r) => r.weekOverWeek, cell: (r) => trendCell(r.weekOverWeek) },
  {
    key: "risk",
    label: "Risk",
    numeric: false,
    sortValue: (r) => RISK[r.risk].rank * 1000 + (r.daysSinceActive ?? 999),
    cell: (r) => (
      <Badge variant="outline" className={RISK[r.risk].badge}>
        {RISK[r.risk].label}
      </Badge>
    ),
  },
];

function HealthTab({ rows }: { rows: HealthRow[] }) {
  return (
    <SortableTable rows={rows} columns={HEALTH_COLUMNS} rowKey={(r) => r.orgId} defaultSort="risk" empty="No customers to display." />
  );
}

const ACTIVITY_VIEWS: readonly ChartView[] = [
  { value: "active", label: "Active users", kind: "count" },
  { value: "sessions", label: "Sessions", kind: "count" },
  { value: "events", label: "Events", kind: "count" },
];

const ALL = "all";

function ActivityTab({ data }: { data: AnalyticsDemo }) {
  const [orgId, setOrgId] = useState(ALL);
  const series = data.activity[orgId] ?? data.activity[ALL];
  const selected = data.orgs.find((o) => o.orgId === orgId);

  return (
    <div className="flex flex-col gap-4">
      <Select value={orgId} onValueChange={(v) => setOrgId(String(v ?? ALL))}>
        <SelectTrigger className="h-9 w-64">
          <span className="truncate">{selected ? selected.name : "All customers"}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All customers</SelectItem>
          {data.orgs.map((o) => (
            <SelectItem key={o.orgId} value={o.orgId}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <AdminMetricsChart
        nowMs={data.nowMs}
        views={ACTIVITY_VIEWS}
        series={{ active: series.active, sessions: series.sessions, events: series.events }}
        ranges={["1M", "3M", "6M", "12M"]}
        defaultRange="3M"
      />
    </div>
  );
}

const SIGNUP_WINDOWS = [30, 90, 180] as const;

function OnboardingTab({ orgs }: { orgs: OnboardingOrg[] }) {
  const [windowDays, setWindowDays] = useState<(typeof SIGNUP_WINDOWS)[number]>(90);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const signups = orgs.filter((o) => o.daysAgo <= windowDays);
  const last = ONBOARDING_STEPS.length - 1;

  function toggle(step: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Signed up within"
        className="inline-flex items-center gap-0.5 self-start rounded-sm bg-muted p-0.5"
      >
        {SIGNUP_WINDOWS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={windowDays === d}
            onClick={() => setWindowDays(d)}
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
              windowDays === d && "bg-background text-foreground shadow-sm hover:text-foreground"
            )}
          >
            {d}D
          </button>
        ))}
      </div>

      <div className="rounded-[0.15rem] border">
        <Table className="text-[0.95rem]">
          <TableHeader className="bg-muted [&_th]:h-12 [&_th]:font-mono [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-muted">
              <TableHead className="w-8" />
              <TableHead>Step</TableHead>
              <TableHead className="text-right">Orgs</TableHead>
              <TableHead className="text-right">% of signups</TableHead>
              <TableHead className="text-right">Stalled here</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ONBOARDING_STEPS.map((step, i) => {
              const reached = signups.filter((o) => o.reached >= i).length;
              // The last step is the finish line: nobody stalls on it.
              const stalled = i === last ? [] : signups.filter((o) => o.reached === i).sort((a, b) => b.daysAgo - a.daysAgo);
              const isOpen = expanded.has(i);
              return (
                <Fragment key={step}>
                  <TableRow className="[&>td]:py-3.5">
                    <TableCell className="pr-0">
                      {stalled.length > 0 ? (
                        <button
                          type="button"
                          aria-label={isOpen ? "Hide stalled orgs" : "Show stalled orgs"}
                          aria-expanded={isOpen}
                          onClick={() => toggle(i)}
                          className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <ChevronRightIcon className={cn("size-4 transition-transform", isOpen && "rotate-90")} />
                        </button>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-medium">{step}</TableCell>
                    <TableCell className="text-right tabular-nums">{count.format(reached)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {signups.length > 0 ? pct.format(reached / signups.length) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {i === last ? "—" : count.format(stalled.length)}
                    </TableCell>
                  </TableRow>
                  {isOpen &&
                    stalled.map((o) => (
                      <TableRow key={o.orgId} className="[&>td]:py-2 [&>td]:text-[0.875rem]">
                        <TableCell className="pr-0" />
                        <TableCell className="pl-6 text-muted-foreground">{o.name}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {dateFormatter.format(new Date(o.signedUpAt))}
                        </TableCell>
                        <TableCell />
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {o.daysAgo} days
                        </TableCell>
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const FEATURE_COLUMNS: SortColumn<FeatureRow>[] = [
  { key: "name", label: "Feature", numeric: false, sortValue: (r) => r.name, cell: (r) => r.name, className: "font-medium" },
  { key: "orgs", label: "Orgs using", numeric: true, sortValue: (r) => r.orgs, cell: (r) => `${r.orgs} of ${r.activeOrgs}` },
  {
    key: "share",
    label: "Share of active orgs",
    numeric: true,
    sortValue: (r) => (r.activeOrgs > 0 ? r.orgs / r.activeOrgs : 0),
    cell: (r) => (r.activeOrgs > 0 ? pct.format(r.orgs / r.activeOrgs) : "—"),
  },
  { key: "users", label: "Users (30d)", numeric: true, sortValue: (r) => r.users, cell: (r) => count.format(r.users) },
  { key: "events", label: "Events (30d)", numeric: true, sortValue: (r) => r.events, cell: (r) => count.format(r.events) },
  { key: "trend", label: "Trend (30d)", numeric: true, sortValue: (r) => r.trend, cell: (r) => trendCell(r.trend) },
];

function FeaturesTab({ rows }: { rows: FeatureRow[] }) {
  return <SortableTable rows={rows} columns={FEATURE_COLUMNS} rowKey={(r) => r.name} defaultSort="events" empty="No features to display." />;
}

const PAGE_COLUMNS: SortColumn<PageRow>[] = [
  { key: "route", label: "Page", numeric: false, sortValue: (r) => r.route, cell: (r) => r.route, className: "font-mono text-[0.85rem]" },
  { key: "views", label: "Views (30d)", numeric: true, sortValue: (r) => r.views, cell: (r) => count.format(r.views) },
  { key: "users", label: "Users", numeric: true, sortValue: (r) => r.users, cell: (r) => count.format(r.users) },
  { key: "orgs", label: "Orgs", numeric: true, sortValue: (r) => r.orgs, cell: (r) => count.format(r.orgs) },
  { key: "avg", label: "Avg time", numeric: true, sortValue: (r) => r.avgSeconds, cell: (r) => duration(r.avgSeconds) },
  {
    key: "load",
    label: "Load (p75)",
    numeric: true,
    sortValue: (r) => r.p75LoadMs,
    cell: (r) => (
      <span className={cn(r.p75LoadMs >= 2500 && "text-destructive")}>{(r.p75LoadMs / 1000).toFixed(1)} s</span>
    ),
  },
  { key: "trend", label: "Trend (30d)", numeric: true, sortValue: (r) => r.trend, cell: (r) => trendCell(r.trend) },
];

function PagesTab({ rows }: { rows: PageRow[] }) {
  return <SortableTable rows={rows} columns={PAGE_COLUMNS} rowKey={(r) => r.route} defaultSort="views" empty="No pages to display." />;
}
