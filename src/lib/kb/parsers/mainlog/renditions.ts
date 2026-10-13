/**
 * The two renditions of a decoded MainLog well (docs/plans/mlw-mud-logs.md,
 * Architecture and Phase 3):
 *
 * - `mainLogToParsedLas` feeds the viewer the same `ParsedLas` shape a `.las`
 *   upload produces.
 * - `mainLogToLasText` writes LAS 2.0 text for Orion and retrieval
 *   (`files.derived_content`, read back through `parseLas` + `renderLasText`).
 *
 * Both come from the same `ParsedMainLog`, so `parseLas(mainLogToLasText(x))`
 * carries the same depth axis and curve values as `mainLogToParsedLas(x)`, up to
 * the 4-decimal number format below.
 *
 * Numbers are written with at most 4 decimals and no trailing zeros
 * (`12.34567` -> `12.3457`, `5000.0` -> `5000`). A missing reading is `-999.25`
 * in `~ASCII`. Depths are in the well's depth unit (`ft` or `m`).
 *
 * `~Other` holds everything that is not a numeric curve, one item per line.
 * Kinds appear in this order, each sorted by depth (items without a depth keep
 * their decoded order). The always-short lines that say what the well does not
 * carry come first and CONFLICT comes last, so a reader that cuts the text off
 * loses conflicts before anything else. The prefix ends at the first ": ", so
 * text after it may contain colons. Multi-line text is collapsed to one line
 * (newlines -> " / ").
 *
 *   ABSENT: topx, mem
 *   UNDECODED <member>: <reason>
 *   UNKNOWN <member> (<size> bytes)
 *   TOP[ <depth>][ TVD <tvd>]: <name>
 *   LITH[ <top>-<base>]: SH 60%, LS 40%
 *   DESC[ <depth>]: <text>
 *   MEMO[ <depth>]: <text>
 *   SHOW[ <top>-<base>]: <text>
 *   SURVEY[ <md>]:[ INC <inc>][ AZI <azi>][ TVD <tvd>][ VS <vs>]
 *   TARGET[ <md>]:[ TVD <tvd>][ INC <inc>][ AZI <azi>][ VS <vs>]
 *   REPORT <daily|short|dst>[ <date>]: <text>
 *   SERIES <member> <source>: <rows> rows, channels <a, b>[, <start> to <end>]
 *   PICTURE <member>[ <depth>]
 *   CONFLICTS: <n> total, first 50 listed
 *   CONFLICT <depth> <mnemonic>: native <n> las <l>
 *
 * A number that is missing or not finite is never written (no -999.25, no
 * NaN): its optional part is left out, a range is left out unless both ends
 * are known, and a lithology part without a percentage is written as its code
 * alone. In practice the depths are always there; `.trg` stations are what
 * carry no INC or AZI.
 *
 * TARGET lines are the horizontal target curve: every `settings` entry whose
 * `data.targetCurve` is an array of `{ md, tvd, inc?, azi?, vs? }` stations.
 *
 * SERIES writes `channels none` when a stream has no named channels, and the
 * time range only when both ends are known. ABSENT is omitted when nothing is
 * absent. CONFLICT lines are capped at the 50 shallowest; CONFLICTS is written
 * only when more than 50 were found.
 *
 * `~Well` values: `parseLas` ends a value at its first colon, and LAS has no
 * escape, so a ":" inside a value is written as U+2236 RATIO ("∶"). It reads
 * the same, and the whole value comes back from `parseLas` instead of the part
 * before the colon (`10:30` is written and read back as `10∶30`). The viewer
 * rendition keeps the real colon.
 */

import type { LasCurve, LasCurveStats, ParsedLas } from "@/lib/kb/parsers/las";
import type { ParsedMainLog } from "./types";

const NULL_VALUE = -999.25;
/** `~Well` mnemonics this module writes itself from the depth axis. */
const DEPTH_WELL_KEYS = new Set(["STRT", "STOP", "STEP", "NULL"]);

/** At most 4 decimals, no trailing zeros, no float noise. */
export function formatLasNumber(v: number): string {
  if (!Number.isFinite(v)) return String(NULL_VALUE);
  const n = Number(v.toFixed(4));
  return String(Object.is(n, -0) ? 0 : n);
}

/** Stands in for ":" in a `~Well` value; see the module comment. */
export const WELL_COLON_SUBSTITUTE = "\u2236";

/** One line of text: newlines become " / ", ends trimmed. */
function oneLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(" / ")
    .trim();
}

/** Depth order; an item with no finite depth sorts after the rest, in decoded order. */
const byDepth = <T>(key: (t: T) => number | null | undefined) => (a: T, b: T) => {
  const x = key(a);
  const y = key(b);
  const fx = typeof x === "number" && Number.isFinite(x);
  const fy = typeof y === "number" && Number.isFinite(y);
  if (fx && fy) return x - y;
  return fx === fy ? 0 : fx ? -1 : 1;
};

/** CONFLICT lines written at most; the rest are counted. */
export const MAX_CONFLICT_LINES = 50;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** " <label> <n>" when the number is finite, else "". `label` may be "". */
function part(label: string, v: unknown): string {
  if (!finite(v)) return "";
  return ` ${label ? `${label} ` : ""}${formatLasNumber(v)}`;
}

/** " <top>-<base>" when both ends are finite, else "". */
function range(top: unknown, base: unknown): string {
  return finite(top) && finite(base) ? ` ${formatLasNumber(top)}-${formatLasNumber(base)}` : "";
}

interface TargetStation {
  md?: unknown;
  tvd?: unknown;
  inc?: unknown;
  azi?: unknown;
  vs?: unknown;
}

/** Target curve stations from `settings` entries carrying `data.targetCurve`. */
function targetStations(log: ParsedMainLog): TargetStation[] {
  const out: TargetStation[] = [];
  for (const s of log.settings) {
    const curve = s.data?.targetCurve;
    if (!Array.isArray(curve)) continue;
    for (const st of curve) if (st && typeof st === "object") out.push(st as TargetStation);
  }
  return out;
}

function curveHeaders(log: ParsedMainLog): LasCurve[] {
  return [
    { mnemonic: "DEPT", unit: log.depthUnit, description: "Measured depth" },
    ...log.curves.map((c) => ({
      mnemonic: c.mnemonic,
      unit: c.unit,
      description: c.description,
    })),
  ];
}

/**
 * Per-curve stats, the same accumulation `parseLas` does over its `~ASCII`
 * block. `parseLas` streams them inline over text rows and exports no helper,
 * so this replicates it over the already-numeric columns.
 */
function curveStats(curves: LasCurve[], data: number[][]): LasCurveStats[] {
  return curves.map((c, i) => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    let nullCount = 0;
    for (const v of data[i]) {
      if (!Number.isFinite(v) || v === NULL_VALUE) {
        nullCount++;
        continue;
      }
      count++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return {
      mnemonic: c.mnemonic,
      unit: c.unit,
      min: count > 0 ? min : null,
      max: count > 0 ? max : null,
      mean: count > 0 ? sum / count : null,
      count,
      nullCount,
    };
  });
}

/** The `~Other` lines, in the grammar in the module comment. */
export function mainLogOtherLines(log: ParsedMainLog): string[] {
  const f = formatLasNumber;
  const out: string[] = [];

  if (log.absent.length) out.push(`ABSENT: ${log.absent.join(", ")}`);
  for (const u of log.undecoded) {
    out.push(`UNDECODED ${u.member}: ${oneLine(u.reason)}`);
  }
  for (const u of log.unknown) {
    out.push(`UNKNOWN ${u.member} (${u.size} bytes)`);
  }
  for (const t of [...log.tops].sort(byDepth((t) => t.depth))) {
    out.push(`TOP${part("", t.depth)}${part("TVD", t.tvd)}: ${oneLine(t.name)}`);
  }
  for (const l of [...log.lithology].sort(byDepth((l) => l.top))) {
    const parts = l.parts.map((p) => (finite(p.pct) ? `${p.code} ${f(p.pct)}%` : p.code)).join(", ");
    out.push(`LITH${range(l.top, l.base)}: ${parts}`);
  }
  for (const d of [...log.descriptions].sort(byDepth((d) => d.depth))) {
    out.push(`DESC${part("", d.depth)}: ${oneLine(d.text)}`);
  }
  for (const m of [...log.memos].sort(byDepth((m) => m.depth))) {
    out.push(`MEMO${part("", m.depth)}: ${oneLine(m.text)}`);
  }
  for (const s of [...log.shows].sort(byDepth((s) => s.top))) {
    out.push(`SHOW${range(s.top, s.base)}: ${oneLine(s.text)}`);
  }
  for (const s of [...log.surveys].sort(byDepth((s) => s.md))) {
    out.push(
      `SURVEY${part("", s.md)}:${part("INC", s.inc)}${part("AZI", s.azi)}${part("TVD", s.tvd)}${part("VS", s.vs)}`
    );
  }
  for (const t of targetStations(log).sort(byDepth((t) => (finite(t.md) ? t.md : null)))) {
    out.push(
      `TARGET${part("", t.md)}:${part("TVD", t.tvd)}${part("INC", t.inc)}${part("AZI", t.azi)}${part("VS", t.vs)}`
    );
  }
  for (const r of log.reports) {
    const date = r.date ? ` ${r.date}` : "";
    out.push(`REPORT ${r.kind}${date}: ${oneLine(r.text)}`);
  }
  for (const s of log.timeSeries) {
    const channels = s.channels.length ? s.channels.join(", ") : "none";
    const range = s.start && s.end ? `, ${s.start} to ${s.end}` : "";
    out.push(`SERIES ${s.member} ${s.source}: ${s.rows} rows, channels ${channels}${range}`);
  }
  // Pictures without a depth sort after the ones with one, in decoded order.
  for (const p of [...log.pictures].sort(byDepth((p) => p.depth))) {
    out.push(`PICTURE ${p.member}${part("", p.depth)}`);
  }
  const conflicts = log.conflicts
    .filter((c) => finite(c.depth) && finite(c.native) && finite(c.las))
    .sort(byDepth((c) => c.depth));
  if (conflicts.length > MAX_CONFLICT_LINES) {
    out.push(`CONFLICTS: ${conflicts.length} total, first ${MAX_CONFLICT_LINES} listed`);
  }
  for (const c of conflicts.slice(0, MAX_CONFLICT_LINES)) {
    out.push(`CONFLICT ${f(c.depth)} ${c.mnemonic}: native ${f(c.native)} las ${f(c.las)}`);
  }

  return out.map((l) => l.trimEnd());
}

/** The viewer rendition: the `ParsedLas` a `.las` upload of this well would give. */
export function mainLogToParsedLas(log: ParsedMainLog): ParsedLas {
  const curves = curveHeaders(log);
  const data: number[][] = [
    Array.from(log.depth),
    ...log.curves.map((c) =>
      Array.from(c.values, (v) => (Number.isFinite(v) ? v : NaN))
    ),
  ];
  const n = log.depth.length;
  return {
    well: log.well,
    params: {},
    curves,
    nullValue: NULL_VALUE,
    depth: {
      mnemonic: "DEPT",
      unit: log.depthUnit,
      start: n ? log.depth[0] : null,
      stop: n ? log.depth[n - 1] : null,
      step: n ? log.step : null,
    },
    rowCount: n,
    stats: curveStats(curves, data),
    data,
    other: mainLogOtherLines(log),
  };
}

/** The Orion rendition: LAS 2.0 text, `~Other` in the grammar above. */
export function mainLogToLasText(log: ParsedMainLog): string {
  const f = formatLasNumber;
  const u = log.depthUnit;
  const n = log.depth.length;
  const lines: string[] = [];

  lines.push("~Version");
  lines.push("VERS.  2.0 : CWLS LOG ASCII STANDARD - VERSION 2.0");
  lines.push("WRAP.  NO : ONE LINE PER DEPTH STEP");

  lines.push("~Well");
  // An empty STRT would parse as 0, so an empty well writes no depth lines.
  if (n) {
    lines.push(`STRT.${u}  ${f(log.depth[0])} : START DEPTH`);
    lines.push(`STOP.${u}  ${f(log.depth[n - 1])} : STOP DEPTH`);
    lines.push(`STEP.${u}  ${f(log.step)} : STEP`);
  }
  lines.push(`NULL.  ${NULL_VALUE} : NULL VALUE`);
  for (const [k, v] of Object.entries(log.well)) {
    if (DEPTH_WELL_KEYS.has(k.toUpperCase())) continue;
    lines.push(`${k}.  ${oneLine(v).replaceAll(":", WELL_COLON_SUBSTITUTE)} :`);
  }

  lines.push("~Curve");
  for (const c of curveHeaders(log)) {
    lines.push(`${c.mnemonic}.${c.unit}  : ${oneLine(c.description)}`);
  }

  lines.push("~Other");
  lines.push(...mainLogOtherLines(log));

  lines.push("~ASCII");
  for (let i = 0; i < n; i++) {
    const row = [f(log.depth[i]), ...log.curves.map((c) => f(c.values[i]))];
    lines.push(row.join(" "));
  }

  return `${lines.join("\n")}\n`;
}
