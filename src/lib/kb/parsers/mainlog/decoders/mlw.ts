/**
 * `.mlw` members: MainLog's depth-indexed log. Layout, offsets and every rule
 * below are from docs/plans/mainlog-format-mlw.md (traced from mainlog.exe);
 * "doc" in comments means that file.
 *
 * Only CONFIRMED fields are decoded. PARTIAL and UNCONFIRMED ones (the TG
 * factor at 0x44, cuttings size, the trailing export columns, record 0's digit
 * strings, the lithology modifier digit, the 0xa8 and 0x11c text slots, ...)
 * are not emitted. Values the LAS export derives rather than stores (ROP
 * ft/hr, gas percent and PPM, WRAT, BRAT, CRAT, COIN, SG, 10FTROP, 5FTROP, DXC)
 * are not computed here either, so every curve mnemonic is emitted once
 * (`MLW_DECODED_MNEMONICS` in curves.ts).
 *
 * The clamps MainLog's "Sync" applies to every record on open (doc, 0x626c02)
 * are applied, because MainLog's display and export only ever see synced
 * records: ROP outside 0.01..200 becomes 0.1, a NaN gas becomes 0, fluorescence
 * above 100 becomes 0, an event code outside 1..5 becomes 0, an empty or
 * non-printable lithology string becomes blank.
 *
 * Pure: no DOM, no fs, no Buffer.
 */

import {
  MainLogFormatError,
  type DepthText,
  type LithologyInterval,
  type LithologyPart,
  type MainLogContribution,
  type MainLogCurve,
  type MainLogDecoder,
  type MainLogMember,
  type MainLogSurvey,
  type MainLogWell,
} from "../types";
import { MAINLOG_CURVES } from "../curves";
import { bytesToText } from "../text";
import { MLW_RECORD_BYTES } from "../read";

/** Record size marker a 468-byte legacy file carries (doc, "Record size marker"). */
const LEGACY_RECORD_BYTES = 468;
/** Depth step between records; hard-coded to 2 in every MainLog setter. */
export const MLW_STEP_FT = 2;

/** Where one 1-ft row of the decoded axis takes its values from. */
export interface MlwRowSource {
  /** Row A sits on a record depth, row B one foot below it. */
  row: "A" | "B";
  /** Depth of the record ROP and CON come from (the row's own record depth, E). */
  footRecord: number;
  /** ROP offset in `footRecord`: +0x08 on row A, +0x04 on row B. */
  ropOffset: 0x08 | 0x04;
  /** Depth of the record every other field comes from (E + 2). */
  fieldRecord: number;
}

/**
 * The depth placement rule, in one place: MainLog's own LAS export row pairing
 * (doc, "LAS row pairing"), reproduced exactly. For consecutive records at
 * depths E and E + 2 the export writes
 * - row A at E: ROP from record E +0x08, CON from record E +0x16c (A mapping);
 * - row B at E + 1: ROP from record E +0x04, CON from record E +0x16c
 *   (B mapping); not written when E is the stop (last) record;
 * - both rows: every other field (gas, shows, mud, survey, ...) from record
 *   E + 2.
 * Fields the export does not print follow record E + 2's other fields: its
 * lithology interval runs from row A (E) to row B + 1 (E + 2), its description
 * sits on row A.
 *
 * The decoded axis is exactly the export's rows over the whole file, from
 * record 0's depth (the header: no ROP or CON, NaN there) to the last record's
 * row A (no next record: only ROP and CON). `headerDepth` is record 0's depth;
 * the result is null for a depth that is not a whole foot at or below it. The
 * caller bounds it to the file.
 *
 * OPEN ITEM (doc, "Open items" 1): this is the export's assignment, not a
 * confirmed display one. Whether MainLog's display gives a record's gas and
 * lithology its own depth instead is still owed by the Phase 0 display oracle.
 */
export function mlwRowSource(depth: number, headerDepth: number): MlwRowSource | null {
  const offset = depth - headerDepth;
  if (!Number.isInteger(offset) || offset < 0) return null;
  const rowA = offset % MLW_STEP_FT === 0;
  const footRecord = rowA ? depth : depth - 1;
  return {
    row: rowA ? "A" : "B",
    footRecord,
    ropOffset: rowA ? 0x08 : 0x04,
    fieldRecord: footRecord + MLW_STEP_FT,
  };
}

// Data record offsets (doc, "Data records"). All CONFIRMED except `description`
// (0x8a: location confirmed, meaning from the data).
const O = {
  depth: 0x000,
  fluQual: 0x014,
  por: 0x016,
  flu: 0x018,
  cut: 0x01a,
  tot: 0x01c,
  c1: 0x020, // C1 C2 C3 IC4 NC4 IC5 at 4-byte steps
  co2: 0x038,
  mudWtOut: 0x03c,
  temp: 0x040,
  slide: 0x060,
  lithology: 0x06c,
  description: 0x08a,
  surveyMd: 0x0e2,
  qc: 0x0e6,
  azm: 0x10c,
  incl: 0x110,
  tvd: 0x114,
  mudWtIn: 0x158,
  hardness: 0x164,
  flare: 0x166,
  event: 0x16c,
  lag: 0x181,
  vs: 0x185,
  nc5: 0x191,
} as const;

// Record 0 (doc, "Record 0").
const H_SIZE_MARKER = 0x00c;
const H_MONTH = 0x016;
const H_DAY = 0x018;
const H_YEAR = 0x01a;

const DESCRIPTION_MAX = 29; // NUL forced at 0xa7
const LITHOLOGY_MAX = 29; // NUL forced at 0x89

const GAS = ["C1", "C2", "C3", "IC4", "NC4", "IC5"] as const;

/** Emitted mnemonics are listed in `MLW_DECODED_MNEMONICS` (curves.ts). Every value starts as no reading. */
function curve(mnemonic: string, unit: string, length: number): MainLogCurve {
  const spec = MAINLOG_CURVES.find((c) => c.mnemonic === mnemonic && c.unit === unit);
  return {
    mnemonic,
    unit,
    description: spec?.description ?? mnemonic,
    values: new Float64Array(length).fill(NaN), // NaN = no row value
  };
}

/**
 * Show letters as the LAS export grades them (doc, 0x5785f7 / 0x578681 /
 * 0x5786f5). Loggers 0x1f and 0x08 print the raw word instead; we do not know
 * the logger's settings, so the plain grading is used.
 */
const CH_T = 0x74, CH_P = 0x70, CH_F = 0x66, CH_G = 0x67;
function tpfg(word: number): number {
  return word === CH_T ? 1 : word === CH_P ? 2 : word === CH_F ? 3 : word === CH_G ? 4 : 0;
}

/** Record code lookup (doc, 0x544645): case-insensitive prefix, first match wins. */
const CODE_TABLE: readonly [prefix: string, index: number][] = [
  ["bl", 0], ["do", 1], ["ss", 2], ["sd", 2], ["sa", 10], ["a", 3], ["l", 4],
  ["ch", 5], ["sl", 6], ["si", 6], ["sh", 8], ["co", 9], ["gr", 11], ["cg", 12],
  ["ol", 13], ["gl", 14], ["fl", 15], ["be", 16], ["gss", 17], ["fd", 18],
  ["gd", 19], ["od", 20], ["xs", 21], ["cs", 22], ["gw", 23], ["qw", 24],
  ["cm", 25], ["cmt", 25], ["ce", 25], ["cw", 26], ["rsh", 27], ["osh", 28],
  ["gsh", 29], ["c1", 30], ["c2", 31], ["c3", 32], ["c4", 33], ["c5", 34],
  ["c6", 35], ["ck", 36], ["vo", 37], ["bas", 38], ["gns", 39], ["gb", 40],
  ["sch", 41], ["qz", 42],
];

/**
 * Slot index to the MainLog code emitted, after the unconditional folds
 * (13,14,15 into LS; 17,21 into SS; 18,19,20 into DOL). The BEN/CS/RSH/OSH/GSH
 * into SH fold depends on settings we cannot see, so it is not applied. Slots
 * 38..42 use the custom LAS names. Slot 0 is blank and emits nothing.
 */
const SLOT_CODE: Record<number, string> = {
  1: "DOL", 2: "SS", 3: "ANH", 4: "LS", 5: "CHT", 6: "SLT", 8: "SH", 9: "CO",
  10: "SALT", 11: "GR", 12: "CG", 13: "LS", 14: "LS", 15: "LS", 16: "BEN",
  17: "SS", 18: "DOL", 19: "DOL", 20: "DOL", 21: "SS", 22: "CS", 23: "GW",
  24: "QW", 25: "CMT", 26: "CW", 27: "RSH", 28: "OSH", 29: "GSH", 30: "CL1",
  31: "CL2", 32: "CL3", 33: "CL4", 34: "CL5", 35: "CL6", 36: "CHK", 37: "VOL",
  38: "BAS", 39: "GNS", 40: "GB", 41: "SCH", 42: "QTZ",
};

/** Export column order (doc: slots 3, 5, 4, 1, 2, ...), used to order equal percents. */
const CODE_ORDER = [
  "ANH", "CHT", "LS", "DOL", "SS", "SLT", "CG", "SH", "CO", "SALT", "GR", "GW",
  "QW", "CW", "BEN", "RSH", "OSH", "GSH", "CS", "CHK", "VOL", "CL1", "CL2", "CL3",
  "CL4", "CL5", "CL6", "CMT", "BAS", "GNS", "GB", "SCH", "QTZ",
];

function codeIndex(raw: string): number {
  let code = raw.toLowerCase();
  if (code.startsWith("~")) code = code.slice(1); // a flag MainLog skips (0x54466c)
  if (code === "" || code.startsWith(" ")) return 0;
  if (code === "d" || code.startsWith("d,")) return 1;
  for (const [prefix, index] of CODE_TABLE) if (code.startsWith(prefix)) return index;
  return 0;
}

/** C `atoi`: leading spaces, optional sign, digits; 0 when there are none. */
function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : 0;
}

const isDelimiter = (ch: string) => ch === "," || ch === "." || ch === " ";

/**
 * Lithology string decoder (doc, 0x57a6ba). Returns parts ordered by percent,
 * largest first. The units digit of each percent is a separate attribute whose
 * meaning is unconfirmed, so it is dropped.
 *
 * Parts can sum past 100 (e.g. `60SH,60LS`: the loop stops only once the sum
 * reaches 100). MainLog keeps such a record as is, and so do we: nothing is
 * clamped.
 */
export function decodeLithology(s: string): LithologyPart[] {
  const pct = new Map<number, number>();
  const add = (index: number, p: number) => pct.set(index, (pct.get(index) ?? 0) + p);

  if (![...s].some(isDelimiter)) {
    // Single rock: 3 percent chars, up to 4 code chars; it gets 100.
    if (s.length > 0) add(codeIndex(s.slice(3, 7)), 100);
  } else {
    let i = 0;
    let sum = 0;
    while (i < s.length && sum < 100) {
      const v = atoi(s.slice(i, i + 2));
      const p = v - (v % 10);
      add(codeIndex(s.slice(i + 2, i + 6)), p);
      sum += p;
      let j = i + 2;
      while (j < s.length && !isDelimiter(s[j])) j++;
      i = j + 1;
    }
  }

  const byCode = new Map<string, number>();
  for (const [index, p] of pct) {
    const code = SLOT_CODE[index];
    if (!code || p <= 0) continue;
    byCode.set(code, (byCode.get(code) ?? 0) + p);
  }
  return [...byCode]
    .map(([code, p]) => ({ code, pct: p }))
    .sort((a, b) => b.pct - a.pct || CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code));
}

/** Bytes up to the first NUL, at most `max`. */
function cString(bytes: Uint8Array, offset: number, max: number): Uint8Array {
  let end = offset;
  const stop = Math.min(bytes.length, offset + max);
  while (end < stop && bytes[end] !== 0) end++;
  return bytes.subarray(offset, end);
}

function printable(raw: Uint8Array): boolean {
  for (let i = 0; i < raw.length; i++) if (raw[i] < 0x20 || raw[i] === 0x7f) return false;
  return true;
}

/** Latin text in a slot, or null when it is empty or holds control bytes. */
function slotText(bytes: Uint8Array, offset: number, max: number): string | null {
  if (bytes[offset] === 0) return null;
  const raw = cString(bytes, offset, max);
  if (!printable(raw)) return null;
  const text = bytesToText(raw).trim();
  return text ? text : null;
}

function lithologyString(bytes: Uint8Array, offset: number): string {
  const raw = cString(bytes, offset, LITHOLOGY_MAX);
  let s = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < 0x20 || raw[i] > 0x7e) return ""; // Sync makes it 100BL: blank
    s += String.fromCharCode(raw[i]);
  }
  return s;
}

function sameParts(a: LithologyPart[], b: LithologyPart[]): boolean {
  return a.length === b.length && a.every((p, i) => p.code === b[i].code && p.pct === b[i].pct);
}

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

/**
 * Structural checks (doc, "File structure"). Returns the record count.
 */
function validate(member: MainLogMember, view: DataView): number {
  const size = view.byteLength;
  if (size >= H_SIZE_MARKER + 4) {
    const marker = Math.trunc(view.getFloat32(H_SIZE_MARKER, true));
    if (marker === LEGACY_RECORD_BYTES) {
      fail(member, "legacy MainLog file (468-byte records) not yet supported");
    }
    // 0 counts as 416 (the samples hold the 0.1 ROP default there); new files write 416.
    if (marker !== 0 && marker !== MLW_RECORD_BYTES) {
      fail(member, `record size marker is ${marker}, not ${MLW_RECORD_BYTES}`);
    }
  }
  if (size === 0 || size % MLW_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${MLW_RECORD_BYTES}-byte records`);
  }
  const n = size / MLW_RECORD_BYTES;
  if (n < 2) fail(member, "holds a header and no data records");
  let prev = view.getInt32(0, true);
  for (let r = 1; r < n; r++) {
    const d = view.getInt32(r * MLW_RECORD_BYTES, true);
    if (d !== prev + MLW_STEP_FT) {
      fail(member, `record ${r} is at ${d} ft after ${prev} ft; records must be ${MLW_STEP_FT} ft apart`);
    }
    prev = d;
  }
  return n;
}

function creationDate(view: DataView): string | null {
  const month = view.getUint16(H_MONTH, true);
  const day = view.getUint16(H_DAY, true);
  const year = view.getUint16(H_YEAR, true);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null; // e.g. Feb 30
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Decode one `.mlw`. `well` decides who owns descriptions: when the well
 * carries a `.mem` member, that decoder does and none are read here.
 */
export function decodeMlw(member: MainLogMember, well?: MainLogWell): MainLogContribution {
  const bytes = member.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = validate(member, view);

  const headerDepth = view.getInt32(0, true);
  const stop = view.getInt32((n - 1) * MLW_RECORD_BYTES, true);
  const length = stop - headerDepth + 1;
  const depth = new Float64Array(length);
  for (let i = 0; i < length; i++) depth[i] = headerDepth + i;

  const rop = curve("ROP", "min/ft", length);
  const gas = GAS.map((m) => curve(m, "UNITS", length));
  const nc5 = curve("NC5", "UNITS", length);
  const tot = curve("TOT", "UNITS", length);
  const co2 = curve("CO2", "PERC", length);
  const mudOut = curve("MUDWTOUT", "LB/G", length);
  const mudIn = curve("MUDWTIN", "LB/G", length);
  const temp = curve("TEMP", "DEG", length);
  const por = curve("POR", "UNITS", length);
  const flu = curve("FLU", "PERC", length);
  const fluQual = curve("FLUQUAL", "UNITS", length);
  const cut = curve("CUT", "UNITS", length);
  const flare = curve("FLARE", "FT", length);
  const con = curve("CON", "unit", length);
  const slide = curve("SLIDE", "UNITS", length);
  const hard = curve("CACO3", "PERC", length);
  const qc = curve("QC", "UNITS", length);
  const lag = curve("LAGTIME", "MIN", length);
  const tvd = curve("TVD", "FT", length);
  const incl = curve("INCL", "DEG", length);
  const azm = curve("AZM", "DEG", length);
  const vs = curve("VS", "FT", length);

  const lithology: LithologyInterval[] = [];
  const descriptions: DepthText[] = [];
  const surveys: MainLogSurvey[] = [];
  const surveyMds = new Set<number>();
  const ownsDescriptions = !(well?.members.some((m) => m.ext === "mem") ?? false);
  let run: { depth: number; parts: string[] } | null = null;
  const endRun = () => {
    if (run) descriptions.push({ depth: run.depth, text: run.parts.join(" ").replace(/\s+/g, " ").trim() });
    run = null;
  };

  const base = (recordDepth: number) => ((recordDepth - headerDepth) / MLW_STEP_FT) * MLW_RECORD_BYTES;
  const f32 = (b: number, off: number) => view.getFloat32(b + off, true);
  const u16 = (b: number, off: number) => view.getUint16(b + off, true);

  for (let i = 0; i < length; i++) {
    const d = depth[i];
    const src = mlwRowSource(d, headerDepth)!;

    // ROP and CON from the row's own record; record 0 is a header and has neither.
    if (src.footRecord > headerDepth) {
      const b = base(src.footRecord);
      // Sync clamp: outside 0.01..200 becomes 0.1 (NaN compares false, stays NaN).
      let x = f32(b, src.ropOffset);
      if (x < 0.01 || x > 200) x = 0.1;
      rop.values[i] = x;
      // Event code (doc, 0x579009): row A maps 2 -> 1 (connection), 3 -> 3
      // (casing point), 4 or 5 -> 4 (trip); row B maps 1 -> 1. 0 is a real
      // "no event".
      let ev = u16(b, O.event);
      if (ev < 1 || ev > 5) ev = 0; // Sync clamp
      con.values[i] =
        src.row === "A" ? (ev === 2 ? 1 : ev === 3 ? 3 : ev === 4 || ev === 5 ? 4 : 0) : ev === 1 ? 1 : 0;
    }

    // Every other field from the next record; the last record's row A has none.
    if (src.fieldRecord > stop) continue;
    const b = base(src.fieldRecord);
    const D = src.fieldRecord;

    // Gas. Sync turns NaN into 0; 0 is a real reading (no gas). The export
    // prints fabs() of every gas value (doc: the demo holds negative gas whose
    // meaning is unknown), so do we. TOT is the stored total gas / hot wire;
    // the export prints it only when a setting is on and otherwise sums
    // C1..IC5, we print the stored value.
    const gasValue = (off: number) => {
      const x = f32(b, off);
      return Number.isNaN(x) ? 0 : Math.abs(x);
    };
    tot.values[i] = gasValue(O.tot);
    for (let g = 0; g < GAS.length; g++) gas[g].values[i] = gasValue(O.c1 + 4 * g);
    nc5.values[i] = gasValue(O.nc5);
    // CO2 %: Sync zeroes a NaN like the gases, and the export prints it raw; no
    // window marks 0 as unset, so 0 is a reading.
    const co2Raw = f32(b, O.co2);
    co2.values[i] = Number.isNaN(co2Raw) ? 0 : co2Raw;

    // Mud weights: the export accepts out only within 7..20 and in only within
    // 5..25 and otherwise carries the last accepted value forward, so 0 (and
    // anything else outside the window) is no reading. The carry-forward is
    // the export's presentation and is not reproduced.
    const wOut = f32(b, O.mudWtOut);
    mudOut.values[i] = wOut > 7 && wOut < 20 ? wOut : NaN;
    const wIn = f32(b, O.mudWtIn);
    mudIn.values[i] = wIn > 5 && wIn < 25 ? wIn : NaN;
    // Mud temperature out: where the export takes TEMP from `.mlx` (logger
    // 0x11) it accepts only 0 < x < 600, so 0 is not a temperature: no reading.
    const t = f32(b, O.temp);
    temp.values[i] = t === 0 ? NaN : t;

    // Shows, graded as the export grades them. 0 = no show, a real grade.
    let fluPct = u16(b, O.flu);
    if (fluPct > 100) fluPct = 0; // Sync clamp
    const fq = u16(b, O.fluQual);
    let fqGrade: number;
    if (fq === CH_P) fqGrade = 1;
    else if (fq === CH_F) fqGrade = 2;
    else if (fq === CH_G) fqGrade = 3;
    else if (fq === CH_T) {
      fqGrade = 0;
      fluPct = 5;
    } else fqGrade = fluPct > 0 ? 3 : 0;
    flu.values[i] = fluPct;
    fluQual.values[i] = fqGrade;
    por.values[i] = tpfg(u16(b, O.por));
    cut.values[i] = tpfg(u16(b, O.cut));

    // SLIDE: 0 = rotating (the export legend "1=Slide 0=Rotate"), a reading.
    slide.values[i] = u16(b, O.slide);
    // Calcimetry / hardness %: printed as is with no window; 0 % is possible rock.
    hard.values[i] = u16(b, O.hardness);
    // Flare length: printed as is with no window; 0 ft is "no flare", a reading.
    flare.values[i] = u16(b, O.flare);
    // QC: printed raw with no window, meaning of 0 unknown; kept.
    qc.values[i] = f32(b, O.qc);
    // Lag time is a travel time and cannot be 0; the demo fills it in only 91
    // of 3,244 records (doc, "Cross-check"), so 0 is nothing entered.
    const lagMin = f32(b, O.lag);
    lag.values[i] = lagMin === 0 ? NaN : lagMin;

    // Survey: the export prints NULL for every survey column where TVD is 0.
    const tv = f32(b, O.tvd);
    const hasSurvey = tv !== 0 && !Number.isNaN(tv);
    const inc = f32(b, O.incl);
    const azi = f32(b, O.azm);
    const vsec = f32(b, O.vs);
    tvd.values[i] = hasSurvey ? tv : NaN;
    incl.values[i] = hasSurvey ? inc : NaN;
    azm.values[i] = hasSurvey ? azi : NaN;
    vs.values[i] = hasSurvey ? vsec : NaN;

    // Per-record output, once per record, on row A.
    if (src.row !== "A") continue;

    if (tv > 0) {
      // Sync sets the survey MD to D when TVD > 0 and it is 0 (0x62707c).
      const mdRaw = f32(b, O.surveyMd);
      const md = mdRaw === 0 ? D : mdRaw;
      if (!surveyMds.has(md)) {
        surveyMds.add(md);
        surveys.push({ md, inc, azi, tvd: tv, vs: vsec });
      }
    }

    // Lithology, row A to row B + 1; consecutive identical records merge.
    const parts = decodeLithology(lithologyString(bytes, b + O.lithology));
    if (parts.length > 0) {
      const top = d;
      const bottom = D;
      const prev = lithology[lithology.length - 1];
      if (prev && prev.base === top && sameParts(prev.parts, parts)) prev.base = bottom;
      else lithology.push({ top, base: bottom, parts });
    }

    // Description text (0x8a) is split across consecutive records: a run of
    // non-empty slots is one description on the first one's row; an empty
    // slot ends it. The 0xa8 and 0x11c slots are not read (meaning unconfirmed;
    // Sync zeroes 0xa8).
    if (ownsDescriptions) {
      const s = slotText(bytes, b + O.description, DESCRIPTION_MAX);
      if (s === null) endRun();
      else if (run) run.parts.push(s);
      else run = { depth: d, parts: [s] };
    }
  }
  endRun();

  const date = creationDate(view);
  return {
    depthUnit: "ft",
    step: 1,
    depth,
    well: date ? { DATE: date } : {},
    curves: [
      tvd, incl, azm, vs, rop, con, ...gas, nc5, tot, co2, por, flu, fluQual, cut,
      flare, mudOut, mudIn, hard, temp, lag, slide, qc,
    ],
    lithology,
    descriptions,
    surveys,
  };
}

export const mlwDecoder: MainLogDecoder = {
  exts: ["mlw"],
  decode: (member, well) => decodeMlw(member, well),
};
