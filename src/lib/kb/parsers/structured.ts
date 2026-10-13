/**
 * Detection + summarisation for structured data files (LAS well logs, CSV/TSV
 * tables). Produces two things from raw file text:
 *   - `summaryText`: a compact natural-language description of the dataset's
 *     header + per-curve/column stats, which gets embedded for RAG so Orion can
 *     find and reason about the dataset without ingesting raw numbers.
 *   - `payload`: a JSON structure cached on `files.structured_summary` so tools
 *     can answer "what curves does this log have?" without re-parsing.
 *
 * Raw curve/row arrays are NOT embedded and NOT cached here — analytic tools
 * re-parse the stored file on demand (see lib/kb/structured.ts).
 */

import { isLas, parseLas, type ParsedLas } from "@/lib/kb/parsers/las";
import { isCsv, parseCsv, type ParsedCsv } from "@/lib/kb/parsers/csv";

export type StructuredKind = "las" | "csv";

export interface StructuredResult {
  kind: StructuredKind;
  summaryText: string;
  payload: Record<string, unknown>;
}

/** Decide whether a file is structured data we should parse instead of chunk. */
export function detectStructuredKind(
  name: string,
  text: string
): StructuredKind | null {
  if (isLas(name, text)) return "las";
  if (isCsv(name)) return "csv";
  return null;
}

/** Compact numeric formatting for summary text: trims noise, caps decimals. */
function fmt(n: number | null): string {
  if (n === null) return "n/a";
  if (Number.isInteger(n)) return String(n);
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

function summariseLas(name: string, las: ParsedLas): StructuredResult {
  const wellName = las.well.WELL || las.well.UWI || las.well.API || "(unnamed)";
  const field = las.well.FLD ? ` Field: ${las.well.FLD}.` : "";
  const loc = las.well.LOC ? ` Location: ${las.well.LOC}.` : "";
  const api = las.well.API ? ` API: ${las.well.API}.` : "";
  const company = las.well.COMP ? ` Operator: ${las.well.COMP}.` : "";

  const depthLine =
    las.depth.start !== null && las.depth.stop !== null
      ? `Logged interval ${fmt(las.depth.start)}–${fmt(las.depth.stop)} ${las.depth.unit} (step ${fmt(las.depth.step)}), ${las.rowCount} samples.`
      : `${las.rowCount} data rows.`;

  const curveLines = las.stats
    .map((s) => {
      const desc = las.curves.find((c) => c.mnemonic === s.mnemonic)?.description;
      const label = desc ? `${s.mnemonic} (${desc})` : s.mnemonic;
      const unit = s.unit ? ` [${s.unit}]` : "";
      const range =
        s.min !== null
          ? `min ${fmt(s.min)}, max ${fmt(s.max)}, mean ${fmt(s.mean)}`
          : "no valid samples";
      const nulls = s.nullCount > 0 ? `, ${s.nullCount} null` : "";
      return `- ${label}${unit}: ${range}${nulls}`;
    })
    .join("\n");

  const otherLine = las.other.length
    ? `\nThe file carries ${las.other.length} ~Other lines (free text such as lithology, descriptions, shows or tops).`
    : "";

  const summaryText = `Well-log LAS file "${name}". Well: ${wellName}.${field}${loc}${api}${company}
${depthLine}${otherLine}
Curves and per-curve statistics:
${curveLines}`;

  const payload: Record<string, unknown> = {
    kind: "las",
    well: las.well,
    params: las.params,
    nullValue: las.nullValue,
    depth: las.depth,
    rowCount: las.rowCount,
    curves: las.curves,
    stats: las.stats,
  };
  if (las.other.length) payload.other = las.other.length;

  return { kind: "las", summaryText, payload };
}

function summariseCsv(name: string, csv: ParsedCsv): StructuredResult {
  const colLines = csv.columns
    .map((c) => {
      if (c.numeric) {
        return `- ${c.name} (numeric): min ${fmt(c.min)}, max ${fmt(c.max)}, mean ${fmt(c.mean)}, ${c.count} values${c.emptyCount ? `, ${c.emptyCount} empty` : ""}`;
      }
      const ex = c.sample.length ? ` e.g. ${c.sample.slice(0, 3).join(", ")}` : "";
      return `- ${c.name} (text):${ex}${c.emptyCount ? ` (${c.emptyCount} empty)` : ""}`;
    })
    .join("\n");

  const summaryText = `Tabular data file "${name}". ${csv.rowCount} rows, ${csv.headers.length} columns.
Columns and per-column statistics:
${colLines}`;

  const payload: Record<string, unknown> = {
    kind: "csv",
    rowCount: csv.rowCount,
    delimiter: csv.delimiter,
    headers: csv.headers,
    columns: csv.columns,
  };

  return { kind: "csv", summaryText, payload };
}

/**
 * Parse + summarise a structured file's text. Returns null if it isn't a
 * recognised structured format (caller falls back to prose chunking).
 */
export function summariseStructured(
  name: string,
  text: string
): StructuredResult | null {
  const kind = detectStructuredKind(name, text);
  if (kind === "las") return summariseLas(name, parseLas(text));
  if (kind === "csv") return summariseCsv(name, parseCsv(text));
  return null;
}
