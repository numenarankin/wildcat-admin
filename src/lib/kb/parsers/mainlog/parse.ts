/**
 * Decode a gathered MainLog well into one `ParsedMainLog`. See
 * docs/plans/mlw-mud-logs.md and `types.ts`.
 *
 * Each member goes to the decoder registered for its extension. How their
 * contributions merge:
 *
 * - **Nothing is dropped.** A member with no decoder (an extension we do not
 *   know, or know but cannot decode yet) is listed in `unknown`. A decoder that
 *   throws `MainLogFormatError` puts the member in `undecoded` with its reason
 *   and the rest of the well still loads. Any other error is a bug and throws.
 * - **Arrays concatenate** in member order (lithology, tops, shows, eLogs, ...).
 * - **The depth axis is the primary log's.** `depth`, `step` and `depthUnit`
 *   come only from the primary `.mlw`'s contribution, and so do its `curves`.
 *   With no native axis (a bare `.las`, a bundle without an `.mlw`, or a
 *   primary that did not decode) the first eLog with data supplies the axis
 *   instead, and all of its curves arrive by the append rule below.
 * - **Companion curves** (a non-primary native member that returns `depth` and
 *   `curves`, e.g. `.mlx` at 1 ft) are laid onto that axis by exact depth
 *   (native depths matched to 0.001, after converting the depth unit), NaN
 *   where the companion has no sample. A companion curve whose mnemonic and
 *   unit are already carried is skipped (first wins). They count as native for
 *   the LAS cross-check.
 * - **Only the primary `.mlw` is merged.** Every other `.mlw` (the TVD twin,
 *   a MainLog backup `<log>@<depth>-<time>.mlw`, any further log) and the
 *   members sharing its base name (e.g. `~tar_1H.mem`) are not decoded or
 *   merged: the twin is indexed by TVD and a backup is an older copy, so their
 *   tops or lithology would land at the wrong depths or twice. Each is listed
 *   in `undecoded` with why ("TVD log of Star_1H.mlw, not merged",
 *   "additional MainLog log (backup copy), not merged", "companion of
 *   ~tar_1H.mlw (TVD log of Star_1H.mlw), not merged"). One that is not whole
 *   416-byte records is listed with that reason instead. They stay on
 *   `MainLogWell` for a TVD view, and do not count as carried for `absent`.
 * - **`well` fields: the first non-blank value wins**, in this order: `.hdr`
 *   (MainLog's export prints the `.hdr` start date as DATE, over record 0's),
 *   the primary log, other native members, then an eLog's own `~Well` section
 *   (COMP, WELL, FLD, LOC, CNTY, STAT, CTRY, SRVC, DATE, API, EKB only).
 * - **`source` versions** are read here from the primary's record 0 (format
 *   string at 0x8a, program version at 0x11c), not from a decoder.
 * - **`absent`** is every `CORE_EXTS` kind no merged member carries.
 *
 * LAS cross-check, native first (plan, Intent): for every eLog curve
 * - whose mnemonic matches a native curve (case-insensitive) with the same unit:
 *   at every depth both carry (native depths matched to 0.001 after converting
 *   the LAS depth unit), a pair differing by more than 0.5% of the native value
 *   or 0.01, whichever is larger, is pushed to `conflicts`. The native value
 *   stays in `curves`. A same-mnemonic curve in another unit is neither
 *   compared nor appended.
 * - that no native curve carries: appended to `curves`, description suffixed
 *   " (from <member>)". The first eLog carrying a mnemonic wins; later ones are
 *   not compared against it. MainLog's own export is placed by exact depth
 *   (the `.mlw` decoder puts values on the export's own rows), NaN where no row
 *   matches; any other LAS is resampled by nearest sample within step/2 (the
 *   shallower sample on a tie), NaN where there is none.
 *
 * MainLog's own export is recognised by header evidence (its `~Curve` carries
 * the template's "One foot rate min/ft" and "Total Gas or H.W." descriptions).
 * Curves it derives rather than prints raw (`isExportDerived`: TOT, the gas
 * ratios, SG, the 10 and 5 ft ROP averages, DXC, ROP in ft/hr, and C1 to NC5 in
 * percent or PPM) are never compared; one the native log does not carry is
 * appended like any other export curve.
 */

import type {
  MainLogContribution,
  MainLogCurve,
  MainLogDecoder,
  MainLogMember,
  MainLogWell,
  ParsedMainLog,
} from "./types";
import { MainLogFormatError } from "./types";
import type { ParsedLas } from "@/lib/kb/parsers/las";
import { CORE_EXTS, DECODERS } from "./registry";
import { isMainLogBackupName, mlwRecordProblem, mlwVersions } from "./read";

const WELL_KEYS = [
  "COMP", "WELL", "FLD", "LOC", "CNTY", "STAT", "CTRY", "SRVC", "DATE", "API", "EKB",
];

/** Relative and absolute floors for calling a native/LAS pair a disagreement. */
const CONFLICT_REL = 0.005;
const CONFLICT_ABS = 0.01;
const FT_PER_M = 1 / 0.3048;

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

function normDepthUnit(unit: string): "ft" | "m" | null {
  const u = unit.trim().toLowerCase();
  if (["m", "meter", "meters", "metre", "metres"].includes(u)) return "m";
  if (["f", "ft", "feet", "foot"].includes(u)) return "ft";
  return null;
}

/** An eLog's depth column in `unit`, or null when it carries no data. */
function lasDepths(las: ParsedLas, unit: "ft" | "m"): number[] | null {
  const col = las.data?.[0];
  if (!col || col.length === 0) return null;
  const from = normDepthUnit(las.depth.unit) ?? unit;
  if (from === unit) return col;
  const k = unit === "ft" ? FT_PER_M : 1 / FT_PER_M;
  return col.map((d) => d * k);
}

const depthKey = (d: number) => Math.round(d * 1000);

/** Nearest-sample lookup over one eLog's depth column. */
function nearestIndex(depths: number[]): (d: number, within: number) => number {
  const order = depths
    .map((d, i) => ({ d, i }))
    .filter((s) => Number.isFinite(s.d))
    .sort((a, b) => a.d - b.d || a.i - b.i);
  return (d, within) => {
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (order[mid].d < d) lo = mid + 1;
      else hi = mid;
    }
    // order[lo] is the first sample at or deeper than d; order[lo - 1] is the one above it.
    let best = -1;
    let bestDist = Infinity;
    for (const j of [lo - 1, lo]) {
      const s = order[j];
      if (!s) continue;
      const dist = Math.abs(s.d - d);
      if (dist < bestDist) {
        best = s.i;
        bestDist = dist;
      }
    }
    return bestDist <= within + 1e-9 ? best : -1;
  };
}

function emptyLog(well: MainLogWell): ParsedMainLog {
  const versions = well.primary
    ? mlwVersions(well.primary.bytes)
    : { formatVersion: null, programVersion: null };
  return {
    source: { name: well.sourceName, kind: well.kind, ...versions },
    depthUnit: "ft",
    step: 0,
    depth: new Float64Array(0),
    well: {},
    curves: [],
    lithology: [],
    descriptions: [],
    memos: [],
    tops: [],
    shows: [],
    reports: [],
    surveys: [],
    timeSeries: [],
    eLogs: [],
    pictures: [],
    settings: [],
    conflicts: [],
    unknown: [],
    undecoded: [],
    absent: [],
  };
}

type ArrayKey = {
  [K in keyof ParsedMainLog]: ParsedMainLog[K] extends unknown[] ? K : never;
}[keyof ParsedMainLog];

const ARRAY_KEYS: ArrayKey[] = [
  "lithology", "descriptions", "memos", "tops", "shows", "reports", "surveys",
  "timeSeries", "eLogs", "pictures", "settings", "conflicts", "unknown",
  "undecoded", "absent",
];

function wellRank(member: MainLogMember, well: MainLogWell): number {
  if (member.ext === "hdr") return 0;
  if (member === well.primary) return 1;
  return 2;
}

/**
 * Members `parseMainLog` lists instead of merging: every `.mlw` but the
 * primary, and the members sharing one's base name. Member -> reason.
 */
function unmerged(well: MainLogWell): Map<MainLogMember, string> {
  const out = new Map<MainLogMember, string>();
  const primaryStem = well.primary ? stem(well.primary.name) : null;
  const roles = new Map<string, { log: MainLogMember; role: string }>();

  for (const m of well.members) {
    if (m.ext !== "mlw" || m === well.primary) continue;
    const role =
      m === well.tvdTwin
        ? well.primary
          ? `TVD log of ${well.primary.name}`
          : "TVD log"
        : isMainLogBackupName(m.name)
          ? "additional MainLog log (backup copy)"
          : "additional MainLog log";
    out.set(m, mlwRecordProblem(m.name, m.bytes) ?? `${role}, not merged`);
    const s = stem(m.name);
    // A same-named duplicate of the primary must not take the primary's companions with it.
    if (s !== primaryStem && !roles.has(s)) roles.set(s, { log: m, role });
  }
  for (const m of well.members) {
    if (m.ext === "mlw" || m === well.primary) continue;
    const owner = roles.get(stem(m.name));
    if (owner) out.set(m, `companion of ${owner.log.name} (${owner.role}), not merged`);
  }
  return out;
}

export function parseMainLog(
  well: MainLogWell,
  decoders: MainLogDecoder[] = DECODERS
): ParsedMainLog {
  const out = emptyLog(well);
  const byExt = new Map<string, MainLogDecoder>();
  for (const d of decoders) {
    for (const ext of d.exts) if (!byExt.has(ext)) byExt.set(ext, d);
  }
  const skipped = unmerged(well);

  let primary: MainLogContribution | null = null;
  const companions: { member: MainLogMember; part: MainLogContribution }[] = [];
  const wellSources: { rank: number; fields: Record<string, string> }[] = [];

  for (const member of well.members) {
    const reason = skipped.get(member);
    if (reason !== undefined) {
      out.undecoded.push({ member: member.name, reason });
      continue;
    }
    const decoder = byExt.get(member.ext);
    if (!decoder) {
      out.unknown.push({ member: member.name, size: member.bytes.length });
      continue;
    }
    let part: MainLogContribution;
    try {
      part = decoder.decode(member, well);
    } catch (err) {
      if (!(err instanceof MainLogFormatError)) throw err;
      out.undecoded.push({ member: member.name, reason: err.message });
      continue;
    }
    if (member === well.primary) primary = part;
    else if (part.depth && part.curves?.length) companions.push({ member, part });

    for (const key of ARRAY_KEYS) {
      const items = part[key];
      if (!items) continue;
      // A loop, not push(...items): a long array would overflow the call stack.
      const into = out[key] as unknown[];
      for (const item of items) into.push(item);
    }
    if (part.well) wellSources.push({ rank: wellRank(member, well), fields: part.well });
  }

  // eLog `~Well` sections fill last, and only the LAS well mnemonics we carry.
  for (const e of out.eLogs) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.las.well)) {
      if (WELL_KEYS.includes(k.toUpperCase())) fields[k.toUpperCase()] = v;
    }
    wellSources.push({ rank: 3, fields });
  }
  wellSources.sort((a, b) => a.rank - b.rank); // stable: member order within a rank
  for (const { fields } of wellSources) {
    for (const [k, v] of Object.entries(fields)) {
      if (v.trim() && !out.well[k]?.trim()) out.well[k] = v;
    }
  }

  if (primary?.depth) {
    out.depth = primary.depth;
    out.step = primary.step ?? 0;
    out.depthUnit = primary.depthUnit ?? "ft";
    out.curves = [...(primary.curves ?? [])];
  } else {
    adoptElogAxis(out);
  }

  for (const c of companions) alignCompanion(out, c.part);
  crossCheck(out);

  const carried = new Set(well.members.filter((m) => !skipped.has(m)).map((m) => m.ext));
  const absent = new Set(out.absent);
  for (const ext of CORE_EXTS) if (!carried.has(ext)) absent.add(ext);
  out.absent = [...absent];

  return out;
}

/** No native axis: the first eLog with data becomes it. Curves follow via `crossCheck`. */
function adoptElogAxis(out: ParsedMainLog): void {
  for (const e of out.eLogs) {
    const col = e.las.data?.[0];
    if (!col || col.length === 0) continue;
    const unit = normDepthUnit(e.las.depth.unit) ?? "ft";
    const depths = col.filter((d) => Number.isFinite(d));
    if (depths.length === 0) continue;
    const declared = Math.abs(e.las.depth.step ?? 0);
    out.depth = Float64Array.from(depths);
    out.depthUnit = unit;
    out.step = declared > 0 ? declared : depths.length > 1 ? Math.abs(depths[1] - depths[0]) : 0;
    return;
  }
}

/** Lay a companion's curves onto the axis by exact depth. */
function alignCompanion(out: ParsedMainLog, part: MainLogContribution): void {
  const depths = part.depth;
  if (!depths || !part.curves) return;
  const from = part.depthUnit ?? out.depthUnit;
  const k = from === out.depthUnit ? 1 : out.depthUnit === "ft" ? FT_PER_M : 1 / FT_PER_M;

  const index = new Map<number, number>();
  out.depth.forEach((d, i) => {
    const key = depthKey(d);
    if (!index.has(key)) index.set(key, i);
  });
  const at = Int32Array.from(depths, (d) => index.get(depthKey(d * k)) ?? -1);

  const carried = (c: MainLogCurve) =>
    out.curves.some(
      (o) => o.mnemonic.toLowerCase() === c.mnemonic.toLowerCase() && o.unit.trim().toLowerCase() === c.unit.trim().toLowerCase()
    );
  for (const c of part.curves) {
    if (carried(c)) continue;
    const values = new Float64Array(out.depth.length).fill(NaN);
    for (let j = 0; j < at.length; j++) if (at[j] >= 0) values[at[j]] = c.values[j];
    out.curves.push({ ...c, values });
  }
}

/** `~Curve` descriptions MainLog's LAS export template writes (curves.ts). */
const EXPORT_EVIDENCE = ["one foot rate min/ft", "total gas or h.w."];

/** Is this LAS MainLog's own export? Header evidence only. */
export function isMainLogExport(las: ParsedLas): boolean {
  const descriptions = new Set(
    las.curves.map((c) => c.description.replace(/\s+/g, " ").trim().toLowerCase())
  );
  return EXPORT_EVIDENCE.every((d) => descriptions.has(d));
}

/** Gas components the export prints in UNITS, or derived in percent or PPM mode. */
const EXPORT_GAS = new Set(["C1", "C2", "C3", "IC4", "NC4", "IC5", "NC5"]);
/** Export curves computed at export time from other values, never stored as printed. */
const EXPORT_DERIVED = new Set([
  "TOT", "TOTALGAS", "WRAT", "BRAT", "CRAT", "COIN", "SG", "10FTROP", "5FTROP", "DXC",
]);

/** A curve MainLog's export derives rather than prints raw; never compared. */
export function isExportDerived(curve: { mnemonic: string; unit: string }): boolean {
  const m = curve.mnemonic.trim().toUpperCase();
  const u = curve.unit.trim().toLowerCase();
  if (EXPORT_DERIVED.has(m)) return true;
  if (m === "ROP" && u === "ft/hr") return true;
  return EXPORT_GAS.has(m) && (u === "perc" || u === "%" || u === "ppm");
}

function crossCheck(out: ParsedMainLog): void {
  // Several native curves can share a mnemonic in different units, so the
  // lookup keeps them all and matches on unit below.
  const native = new Map<string, MainLogCurve[]>();
  for (const c of out.curves) {
    const key = c.mnemonic.toLowerCase();
    native.set(key, [...(native.get(key) ?? []), c]);
  }
  const appended = new Set<string>();

  const nativeIndex = new Map<number, number>();
  out.depth.forEach((d, i) => {
    const k = depthKey(d);
    if (!nativeIndex.has(k)) nativeIndex.set(k, i);
  });

  for (const e of out.eLogs) {
    const depths = lasDepths(e.las, out.depthUnit);
    const data = e.las.data;
    if (!depths || !data) continue;
    const nearest = nearestIndex(depths);
    const exported = isMainLogExport(e.las);

    for (let ci = 1; ci < e.las.curves.length; ci++) {
      const lc = e.las.curves[ci];
      const values = data[ci];
      if (!values) continue;
      const key = lc.mnemonic.toLowerCase();
      const same = native.get(key);

      if (same) {
        const own = same.find((c) => c.unit.trim().toLowerCase() === lc.unit.trim().toLowerCase());
        if (!own || (exported && isExportDerived(lc))) continue;
        for (let r = 0; r < depths.length; r++) {
          const i = nativeIndex.get(depthKey(depths[r]));
          if (i === undefined) continue;
          const n = own.values[i];
          const l = values[r];
          if (!Number.isFinite(n) || !Number.isFinite(l)) continue;
          if (Math.abs(n - l) > Math.max(CONFLICT_REL * Math.abs(n), CONFLICT_ABS)) {
            out.conflicts.push({ depth: out.depth[i], mnemonic: own.mnemonic, native: n, las: l });
          }
        }
        continue;
      }

      if (appended.has(key)) continue;
      appended.add(key);
      const resampled = new Float64Array(out.depth.length).fill(NaN);
      if (exported) {
        const placed = new Uint8Array(out.depth.length);
        for (let r = 0; r < depths.length; r++) {
          const i = nativeIndex.get(depthKey(depths[r]));
          if (i === undefined || placed[i]) continue; // first row at a depth wins
          placed[i] = 1;
          resampled[i] = values[r] ?? NaN;
        }
      } else {
        for (let i = 0; i < out.depth.length; i++) {
          const r = nearest(out.depth[i], out.step / 2);
          resampled[i] = r < 0 ? NaN : (values[r] ?? NaN);
        }
      }
      out.curves.push({
        mnemonic: lc.mnemonic,
        unit: lc.unit,
        description: `${lc.description || lc.mnemonic} (from ${e.member})`,
        values: resampled,
      });
    }
  }
}
