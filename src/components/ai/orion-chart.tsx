"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import type { ChartSpec } from "@/lib/ai/chart-spec";
// Re-exported so existing chart-rendering surfaces can import both from here.
export { chartSpecsFromMessage } from "@/lib/ai/chart-spec";

/**
 * The single, preset renderer for every Orion chart. The agent supplies only the
 * ChartSpec (data + structure, already normalized/bounded by normalizeChartSpec);
 * EVERYTHING visual — colors, grid, axes, tooltip, legend, margins, and the
 * per-surface size — is decided here so charts look identical no matter what the
 * agent does. To change how Orion's charts look, change this file, not the prompt.
 */

type Surface = "page" | "drawer" | "voice";

/** Per-surface sizing. Width is responsive up to a cap; height is fixed so the
 * chat layout never jumps. These are the only size knobs, and the agent has none. */
const SURFACE: Record<Surface, { maxW: string; height: number }> = {
  page: { maxW: "max-w-[640px]", height: 300 },
  drawer: { maxW: "max-w-full", height: 240 },
  voice: { maxW: "max-w-[360px]", height: 200 },
};

const PIE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function OrionChart({
  spec,
  surface = "page",
}: {
  spec: ChartSpec;
  surface?: Surface;
}) {
  const { maxW, height } = SURFACE[surface];

  const config = useMemo<ChartConfig>(() => {
    const c: ChartConfig = {};
    for (const s of spec.series) c[s.key] = { label: s.label, color: s.color };
    return c;
  }, [spec.series]);

  if (!spec.data.length || !spec.series.length) return null;

  return (
    <figure className={cn("my-2 w-full", maxW)}>
      {spec.title && (
        <figcaption className="mb-1 text-sm font-medium text-primary-text">
          {spec.title}
        </figcaption>
      )}
      <ChartContainer
        config={config}
        className="w-full"
        style={{ height }}
      >
        {renderChart(spec, height)}
      </ChartContainer>
    </figure>
  );
}

/** Build the recharts element for the chart type. Kept as a plain function (not a
 * component) because ChartContainer's child must be a single recharts node. */
function renderChart(spec: ChartSpec, height: number) {
  const margin = { top: 8, right: 12, bottom: 4, left: 4 };
  const xAxis = (
    <XAxis
      dataKey={spec.xKey}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={16}
      fontSize={11}
    />
  );
  const yAxis = (
    <YAxis
      tickLine={false}
      axisLine={false}
      width={40}
      fontSize={11}
      label={
        spec.yLabel
          ? { value: spec.yLabel, angle: -90, position: "insideLeft", fontSize: 11 }
          : undefined
      }
    />
  );
  const grid = <CartesianGrid vertical={false} strokeDasharray="3 3" />;
  const tooltip = <ChartTooltip content={<ChartTooltipContent />} />;
  const legend =
    spec.series.length > 1 ? (
      <ChartLegend content={<ChartLegendContent />} />
    ) : null;

  switch (spec.chartType) {
    case "line":
      return (
        <LineChart data={spec.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {spec.series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      );
    case "area":
      return (
        <AreaChart data={spec.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {spec.series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              fill={s.color}
              fillOpacity={0.2}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      );
    case "pie": {
      // Pie shows a single value series split by the xKey label.
      const valueKey = spec.series[0].key;
      const outer = Math.max(60, Math.min(height / 2 - 10, 110));
      return (
        <PieChart margin={margin}>
          {tooltip}
          <Pie
            data={spec.data}
            dataKey={valueKey}
            nameKey={spec.xKey}
            outerRadius={outer}
            strokeWidth={1}
          >
            {spec.data.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey={spec.xKey} />} />
        </PieChart>
      );
    }
    case "bar":
    default:
      return (
        <BarChart data={spec.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {spec.series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[3, 3, 0, 0]} />
          ))}
        </BarChart>
      );
  }
}
