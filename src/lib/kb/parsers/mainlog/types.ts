/**
 * The contract every MainLog module builds against. See
 * docs/plans/mlw-mud-logs.md.
 *
 * MainLog (Main Logging Inc.) spreads one well across many files and packs them
 * into `.ml_` (sendfile) and `.td_` (archive at TD) zips. The pipeline is:
 *
 *   bytes ─readMainLog()─▶ MainLogWell ─parseMainLog()─▶ ParsedMainLog
 *                                                          ├─▶ mainLogToParsedLas() (viewer curves)
 *                                                          └─▶ mainLogToLasText()   (Orion, retrieval)
 *
 * Native files are the source of truth. A `.las` in the bundle is read too: it
 * fills curves the native files lack and cross-checks the ones both carry.
 *
 * Nothing here renders a guess. A member whose layout has not been confirmed
 * (against MainLog's own code or display) is reported in `undecoded`, never
 * decoded on a hypothesis.
 */

import type { ParsedLas } from "@/lib/kb/parsers/las";

/** How the well arrived. */
export type MainLogSourceKind = "mlw" | "ml_" | "td_" | "las";

/** One file of a well, as uploaded or as a zip member. */
export interface MainLogMember {
  /** File name as stored (zip path stripped to the base name). */
  name: string;
  /** Lower-case extension without the dot: "mlw", "topx", "jpg". */
  ext: string;
  bytes: Uint8Array;
}

/** A well's files, gathered but not decoded. Output of `readMainLog`. */
export interface MainLogWell {
  /** The uploaded file's name. */
  sourceName: string;
  kind: MainLogSourceKind;
  /** Every member, including the primary log and any `.las`. */
  members: MainLogMember[];
  /** The well's own measured-depth `.mlw`, or null (a bare `.las`, or a bundle without one). */
  primary: MainLogMember | null;
  /**
   * The TVD twin MainLog writes beside a horizontal well: the primary's name
   * with its first character replaced by `~` (manual, "TVD Log").
   */
  tvdTwin: MainLogMember | null;
}

/** Raised when a well cannot be read at all. The message is shown to the user. */
export class MainLogFormatError extends Error {
  constructor(
    message: string,
    /** The member at fault, when there is one. */
    readonly member?: string
  ) {
    super(message);
    this.name = "MainLogFormatError";
  }
}

/** One depth-indexed curve. `values` aligns with `ParsedMainLog.depth`; NaN = no reading. */
export interface MainLogCurve {
  /** MainLog's own LAS export mnemonic where one exists (see `MAINLOG_CURVES`). */
  mnemonic: string;
  unit: string;
  description: string;
  values: Float64Array;
}

export interface LithologyPart {
  /** MainLog lithology code: "SH", "LS", "SS", ... or a custom code. */
  code: string;
  /** Percent of the interval, 0 to 100. */
  pct: number;
}

export interface LithologyInterval {
  top: number;
  base: number;
  parts: LithologyPart[];
}

export interface DepthText {
  depth: number;
  text: string;
}

export interface MainLogTop {
  name: string;
  depth: number;
  tvd?: number;
}

export interface MainLogShow {
  top: number;
  base: number;
  text: string;
}

export interface MainLogReport {
  kind: "daily" | "short" | "dst";
  /** ISO date when the report carries one. */
  date: string | null;
  text: string;
}

export interface MainLogSurvey {
  md: number;
  inc: number;
  azi: number;
  tvd?: number;
  vs?: number;
}

/** A time-indexed stream (`.gas`, `.cht`, `.wit`, `.fit`), summarised, not inlined. */
export interface MainLogTimeSeries {
  member: string;
  source: "gas" | "cht" | "wit" | "fit";
  channels: string[];
  rows: number;
  /** ISO timestamps of the first and last row, when decoded. */
  start: string | null;
  end: string | null;
}

export interface MainLogPicture {
  member: string;
  mime: string;
  /** Depth the picture belongs to, when MainLog records one. */
  depth: number | null;
}

/** A native curve and the `.las` disagreeing at one depth. */
export interface MainLogConflict {
  depth: number;
  mnemonic: string;
  native: number;
  las: number;
}

/** Output of `parseMainLog`. Every array may be empty. */
export interface ParsedMainLog {
  source: {
    name: string;
    kind: MainLogSourceKind;
    /** e.g. "MainLog Ver 22.5.3", from the primary log, when present. */
    programVersion: string | null;
    /** e.g. "MAINLOG Ver. 1.0", the file-format string. */
    formatVersion: string | null;
  };
  depthUnit: "ft" | "m";
  /** Sample step of `depth`, in `depthUnit`. */
  step: number;
  /** Measured depth index shared by every curve. */
  depth: Float64Array;
  /** LAS `~Well` mnemonics: COMP, WELL, FLD, LOC, CNTY, STAT, CTRY, SRVC, DATE, API, EKB. */
  well: Record<string, string>;
  curves: MainLogCurve[];
  lithology: LithologyInterval[];
  descriptions: DepthText[];
  memos: DepthText[];
  tops: MainLogTop[];
  shows: MainLogShow[];
  reports: MainLogReport[];
  surveys: MainLogSurvey[];
  timeSeries: MainLogTimeSeries[];
  /** Imported wireline curves (`.mlc`) and any `.las` in the bundle. */
  eLogs: { member: string; las: ParsedLas }[];
  pictures: MainLogPicture[];
  /** Display and config members (`.cfg`, `.clr`, `.lfg`, ...), as metadata. */
  settings: { member: string; data: Record<string, unknown> }[];
  conflicts: MainLogConflict[];
  /** Members with no decoder. Listed, never dropped. */
  unknown: { member: string; size: number }[];
  /** Members with a decoder that could not decode them, and why. */
  undecoded: { member: string; reason: string }[];
  /** Known member kinds this well did not carry (e.g. "topx"). */
  absent: string[];
}

/** What one member decoder contributes. `parseMainLog` merges these. */
export type MainLogContribution = Partial<Omit<ParsedMainLog, "source">>;

export interface MainLogDecoder {
  /** Extensions this decoder reads. */
  exts: readonly string[];
  /**
   * Decode one member. Throw `MainLogFormatError` when the bytes do not match
   * the confirmed layout; `parseMainLog` records that in `undecoded` and
   * carries on with the other members.
   */
  decode(member: MainLogMember, well: MainLogWell): MainLogContribution;
}
