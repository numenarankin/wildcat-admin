import { orionFileOf, type OrionFile } from "@/lib/ai/file-spec";

/**
 * The chart contract between Orion and the UI. The agent supplies only the DATA
 * and a few structural choices (chart type, which keys to plot); EVERYTHING that
 * affects styling, sizing, colors, and layout is preset in the renderer
 * (OrionChart) so agent output variability is minimized.
 *
 * `normalizeChartSpec` is the enforcement layer: it runs inside the render_chart
 * tool (server) so the client always receives a clean, bounded spec — the type is
 * clamped to the whitelist, series are capped and auto-colored from the theme's
 * chart tokens (the agent never picks colors), data points are capped, and every
 * plotted value is coerced to a finite number. Pure + framework-free so it unit-
 * tests without a DB or a browser.
 */

export const CHART_TYPES = ["line", "bar", "area", "pie"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Hard caps that bound what the agent can put on screen. */
export const MAX_SERIES = 5; // matches the theme's --chart-1..5 tokens
export const MAX_POINTS = 60;

/** Raw shape the agent produces (loosely typed — normalize tightens it). */
export interface RawChartSpec {
  chartType?: string;
  title?: string;
  /** The field in each data row used for the x-axis (or the slice label for pie). */
  xKey?: string;
  /** Optional unit/axis label, e.g. "bbl/d". */
  yLabel?: string;
  /** The value fields to plot; the agent supplies key + human label only. */
  series?: { key?: string; label?: string }[];
  /** One object per x-position (or per pie slice). */
  data?: Record<string, unknown>[];
}

export interface NormalizedSeries {
  key: string;
  label: string;
  /** Assigned from the theme, never from the agent. */
  color: string;
}

/** The clean, bounded spec the renderer consumes. Safe to render as-is. */
export interface ChartSpec {
  chartType: ChartType;
  title: string;
  xKey: string;
  yLabel: string;
  series: NormalizedSeries[];
  data: Record<string, string | number>[];
}

/** Theme color tokens, assigned to series in order. */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function toChartType(v: unknown): ChartType {
  return (CHART_TYPES as readonly string[]).includes(v as string)
    ? (v as ChartType)
    : "bar"; // safe default: a bar chart reads fine for almost any data
}

/** Coerce a cell to a finite number for plotting; non-numeric → 0. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,%\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toLabel(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

/**
 * Turn a loose agent-produced spec into a bounded, render-safe ChartSpec. Never
 * throws: bad input degrades to a sensible chart rather than failing the turn.
 */
export function normalizeChartSpec(raw: RawChartSpec): ChartSpec {
  const chartType = toChartType(raw.chartType);
  const xKey = (raw.xKey || "").trim() || "label";

  // Series: keep those with a real key, dedupe, cap, and colour from the theme.
  const seen = new Set<string>();
  const series: NormalizedSeries[] = [];
  for (const s of raw.series ?? []) {
    const key = (s?.key || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    series.push({
      key,
      label: (s?.label || "").trim() || key,
      color: SERIES_COLORS[series.length % SERIES_COLORS.length],
    });
    if (series.length >= MAX_SERIES) break;
  }
  // A chart with no valid series can't render; fall back to a single "value"
  // series so a mislabeled call still shows something rather than a blank box.
  if (series.length === 0) {
    series.push({ key: "value", label: "Value", color: SERIES_COLORS[0] });
  }

  // Data: cap the point count, keep the x label as text, coerce series to number.
  const rows = (raw.data ?? []).slice(0, MAX_POINTS).map((row) => {
    const out: Record<string, string | number> = {
      [xKey]: toLabel(row?.[xKey]),
    };
    for (const s of series) out[s.key] = toNumber(row?.[s.key]);
    return out;
  });

  return {
    chartType,
    title: (raw.title || "").trim(),
    xKey,
    yLabel: (raw.yLabel || "").trim(),
    series,
    data: rows,
  };
}

/**
 * Pull every render_chart result out of a chat message's parts. The AI SDK
 * exposes a completed tool call as a `tool-render_chart` part whose `output`
 * (older builds: `result`) is the normalized ChartSpec the tool returned. Pure +
 * framework-free (lives here, not in the renderer) so the voice hook can use it
 * without importing the whole chart/recharts bundle. Defensive: only specs that
 * actually carry series + data arrays are returned.
 */
export function chartSpecsFromMessage(message: {
  parts?: readonly unknown[];
}): ChartSpec[] {
  const specs: ChartSpec[] = [];
  for (const part of message.parts ?? []) {
    const p = part as { type?: string; output?: unknown; result?: unknown };
    if (p?.type !== "tool-render_chart") continue;
    const out = (p.output ?? p.result) as ChartSpec | undefined;
    if (out && Array.isArray(out.series) && Array.isArray(out.data)) {
      specs.push(out);
    }
  }
  return specs;
}

/** One rendered chunk of an assistant turn, in the order it was produced. */
export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "chart"; spec: ChartSpec }
  | { kind: "file"; file: OrionFile };

/**
 * Split a message into text and chart blocks IN PART ORDER.
 *
 * The renderer used to draw every text part first and then every chart, which
 * meant a chart always sat at the bottom: as commentary streamed in after it,
 * the growing text block shoved the chart further down the page. Walking the
 * parts instead pins each chart between the text that preceded it and the text
 * that follows, so a chart lands once and stays put while the rest streams.
 *
 * Consecutive text parts merge into one block so markdown that spans them (a
 * list, a table) still parses as a unit.
 */
export function messageBlocks(message: {
  parts?: readonly unknown[];
}): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim().length > 0) blocks.push({ kind: "text", text: buffer });
    buffer = "";
  };

  for (const part of message.parts ?? []) {
    const p = part as {
      type?: string;
      text?: string;
      output?: unknown;
      result?: unknown;
    };
    if (p?.type === "text") {
      buffer += p.text ?? "";
      continue;
    }
    const file = orionFileOf(p);
    if (file) {
      flush();
      blocks.push({ kind: "file", file });
      continue;
    }
    if (p?.type === "tool-render_chart") {
      const out = (p.output ?? p.result) as ChartSpec | undefined;
      if (out && Array.isArray(out.series) && Array.isArray(out.data)) {
        flush();
        blocks.push({ kind: "chart", spec: out });
      }
    }
  }
  flush();

  return blocks;
}
