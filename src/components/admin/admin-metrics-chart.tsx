"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

/**
 * The admin dashboard's line chart: the same four figures as the headline
 * row, over time. Same card, title menu and range control as the customer
 * dashboard's `CompanyCharts`; no lease picker, because there is no lease.
 *
 * `series` carries, per view, one point per DAY (`YYYY-MM-DD`, measured at
 * that day's end), per WEEK (`YYYY-MM-DD` of its Monday, a week's total, on a
 * view marked `per: "week"`) or per MONTH (`YYYY-MM`, a month's total), by the same
 * definitions as the cards (`lib/admin/metrics.ts`), so the chart's last point
 * is the card above it. The range buttons keep the points inside the window.
 */

const VIEWS = [
  { value: "paying", label: "Paying users", kind: "count" },
  { value: "arr", label: "ARR", kind: "money" },
  { value: "acv", label: "ACV", kind: "money" },
  { value: "arrGrowth", label: "ARR growth (30d)", kind: "percent" },
  { value: "referral", label: "Referral coefficient", kind: "ratio" },
  { value: "customersAcquired", label: "Customers acquired", kind: "count", per: "week" },
  { value: "referrals", label: "Referrals", kind: "count" },
] as const;

type Kind = "count" | "money" | "percent" | "ratio";

export type MetricView = (typeof VIEWS)[number]["value"];

/** One entry in the title menu: which series, what it is called, how it formats. */
export interface ChartView {
  value: string;
  label: string;
  kind: Kind;
  /** Set when each `YYYY-MM-DD` point is a week's total, keyed by its Monday. */
  per?: "week";
}

const TIME_RANGES = ["1M", "3M", "6M", "12M", "5Y", "All"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
const DEFAULT_RANGE: TimeRange = "12M";

export interface MetricPoint {
  /** `YYYY-MM-DD` for a daily view, `YYYY-MM` for a monthly one. UTC. */
  date: string;
  value: number;
}

/** How far back each range reaches, in days; null = everything. */
const RANGE_DAYS: Record<TimeRange, number | null> = {
  "1M": 30,
  "3M": 91,
  "6M": 182,
  "12M": 365,
  "5Y": 1826,
  All: null,
};

const DAY_MS = 86_400_000;
const isDay = (date: string) => date.length === 10;
const pointDate = (date: string) => new Date(isDay(date) ? `${date}T00:00:00Z` : `${date}-01T00:00:00Z`);

/** The points inside the range. A weekly or monthly point is kept when its span overlaps the window. */
function inRange(points: MetricPoint[], range: TimeRange, nowMs: number, weekly: boolean): MetricPoint[] {
  const days = RANGE_DAYS[range];
  if (days === null) return points;
  const floor = nowMs - days * DAY_MS;
  return points.filter((p) => {
    const start = pointDate(p.date);
    if (isDay(p.date)) return start.getTime() + (weekly ? 7 : 1) * DAY_MS > floor;
    const nextMonth = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    return nextMonth > floor;
  });
}

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const ratio = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatFor(kind: Kind): (v: number) => string {
  if (kind === "money") return (v) => compactUsd.format(v);
  if (kind === "percent") return (v) => percent.format(v);
  if (kind === "ratio") return (v) => ratio.format(v);
  return (v) => compact.format(v);
}
const tickMonthFormatter = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
const tooltipMonthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const tickDayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const tooltipDayFormatter = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const tickLabel = (date: string) =>
  (isDay(date) ? tickDayFormatter : tickMonthFormatter).format(pointDate(date));
const tooltipLabel = (date: string, weekly: boolean) =>
  weekly
    ? `Week of ${tooltipDayFormatter.format(pointDate(date))}`
    : (isDay(date) ? tooltipDayFormatter : tooltipMonthFormatter).format(pointDate(date));

export function AdminMetricsChart({
  series = {},
  nowMs,
  className,
  views = VIEWS,
  ranges = TIME_RANGES,
  defaultRange = DEFAULT_RANGE,
}: {
  /** The instant the series were measured at; the range window ends here. */
  nowMs: number;
  /** Per view, its daily or monthly points. A missing view is an empty plot. */
  series?: Partial<Record<string, MetricPoint[]>>;
  className?: string;
  /** The title menu. Defaults to the dashboard's business figures. */
  views?: readonly ChartView[];
  /** The range buttons, for series shorter than the dashboard's. */
  ranges?: readonly TimeRange[];
  defaultRange?: TimeRange;
}) {
  const [view, setView] = useState<string>(views[0].value);
  const [range, setRange] = useState<TimeRange>(defaultRange);
  const current = views.find((v) => v.value === view) ?? views[0];
  const weekly = current.per === "week";
  const data = inRange(series[view] ?? [], range, nowMs, weekly);
  const config: ChartConfig = { value: { label: current.label, color: "#059669" } };
  const format = formatFor(current.kind);

  return (
    <Card className={cn("flex flex-col rounded-[0.15rem]", className)}>
      <div className="flex flex-row flex-wrap items-start gap-x-4 gap-y-2 px-4">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>
            <DropdownMenu>
              <DropdownMenuTrigger className="-mx-1 -my-0.5 inline-flex items-center gap-1 rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                {current.label}
                <ChevronDownIcon className="size-4 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {views.map((o) => (
                  <DropdownMenuItem
                    key={o.value}
                    className="cursor-pointer"
                    onClick={() => setView(o.value)}
                  >
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </CardTitle>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <div
            role="group"
            aria-label="Select time range"
            className="inline-flex items-center gap-0.5 rounded-sm bg-muted p-0.5"
          >
            {ranges.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                  range === r && "bg-background text-foreground shadow-sm hover:text-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[320px] w-full">
          <LineChart data={data} margin={{ left: 12, right: 12, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(value: string) => tickLabel(value)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              allowDecimals={current.kind === "count" || current.kind === "money" ? false : undefined}
              tickFormatter={(v: number) => format(v)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => tooltipLabel(String(value), weekly)}
                  formatter={(value) => [format(Number(value)), current.label]}
                />
              }
            />
            <Line dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} dot={false} />
          </LineChart>
        </ChartContainer>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: "#059669" }} />
            <span className="text-muted-foreground">{current.label}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
