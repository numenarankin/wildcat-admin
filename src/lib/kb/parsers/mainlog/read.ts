/**
 * MainLog bundle reader: gathers a well's files without decoding any of them.
 * See docs/plans/mlw-mud-logs.md (Phase 1a) and `types.ts`.
 *
 * What arrives:
 * - `.mlw`: a bare log, a whole number of 416-byte records.
 * - `.ml_` (sendfile) and `.td_` (archive at TD): zips. MainLog shells out to
 *   `zip -jq`, so members are flat, but we flatten any path to its base name
 *   anyway and never use a path for anything else (zip-slip safe).
 * - `.las`: a bare LAS, read as a well with no native log.
 *
 * The extension is checked against the bytes: an `.ml_` that is not a zip, or
 * a bare `.mlw` that is not whole records, refuses with a reason the UI can
 * show. Inside a bundle a damaged `.mlw` (legacy, truncated, a half-written
 * backup) is kept as a member like any other: `parseMainLog` lists it in
 * `undecoded` with its reason and the rest of the well still loads.
 * `readMainLog` called with some other name still goes by content, but
 * `isMainLog` (the upload gate) claims MainLog names only.
 *
 * Pure: no DOM, no fs, no Buffer. Runs in the browser and in Node.
 */

import JSZip from "jszip";
import { isLas } from "@/lib/kb/parsers/las";
import {
  MainLogFormatError,
  type MainLogMember,
  type MainLogSourceKind,
  type MainLogWell,
} from "./types";
import { asciiz, bytesToText } from "./text";

/** Fixed record size of `.mlw` (and its TVD twin). */
export const MLW_RECORD_BYTES = 416;
/** Record 0: file-format string, e.g. "MAINLOG Ver. 1.0" or "MLC Ver. 1.0". */
export const MLW_FORMAT_VERSION_OFFSET = 0x8a;
/** Record 0: program version, e.g. "MainLog Ver 22.5.3". */
export const MLW_PROGRAM_VERSION_OFFSET = 0x11c;
/** Longest version string we read; both fields are followed by other data well before this. */
const VERSION_MAX = 64;

export interface ReadMainLogOptions {
  /** Refuse an archive whose members inflate past this many bytes in total. */
  maxTotalBytes?: number;
  /** Refuse an archive with more members than this. */
  maxMembers?: number;
}

/** Zip bomb guard. A real well is a few MB; 256 MB is far past any of them. */
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_MEMBERS = 5000;

const ZIP_KINDS = new Set(["ml_", "td_"]);

/** Base name of a path, with either separator. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Lower-case extension without the dot; "" when there is none. */
export function extOf(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** File name without its extension. */
function stemOf(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/**
 * Bytes shaped like an `.mlw`: whole 416-byte records with a version string in
 * record 0 (both known samples carry "... Ver. 1.0" at 0x8a).
 */
function looksLikeMlw(bytes: Uint8Array): boolean {
  if (bytes.length < MLW_RECORD_BYTES || bytes.length % MLW_RECORD_BYTES !== 0) return false;
  const version = asciiz(bytes, MLW_FORMAT_VERSION_OFFSET, VERSION_MAX);
  return version !== null && version.includes("Ver");
}

function looksLikeLas(name: string, bytes: Uint8Array): boolean {
  return isLas(name, bytesToText(bytes.subarray(0, 2000)));
}

/** The format and program version strings from an `.mlw`'s record 0. */
export function mlwVersions(bytes: Uint8Array): {
  formatVersion: string | null;
  programVersion: string | null;
} {
  if (bytes.length < MLW_RECORD_BYTES) return { formatVersion: null, programVersion: null };
  return {
    formatVersion: asciiz(bytes, MLW_FORMAT_VERSION_OFFSET, VERSION_MAX),
    programVersion: asciiz(bytes, MLW_PROGRAM_VERSION_OFFSET, VERSION_MAX),
  };
}

/**
 * Is this upload a MainLog well? Only a MainLog name (`.mlw`, `.ml_`, `.td_`)
 * is claimed, whatever the bytes: any other name is false, so a PDF whose size
 * happens to be a multiple of 416 is never taken for a log. The bytes of a
 * MainLog name are validated by `readMainLog`, so a damaged file still gets a
 * reason instead of passing as a plain blob. A bare `.las` is not claimed: it
 * is an ordinary LAS upload, even though `readMainLog` accepts one.
 */
// The bytes stay in the signature so callers need not change if a check returns.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function isMainLog(name: string, _bytes: Uint8Array): boolean {
  const ext = extOf(name);
  return ext === "mlw" || ZIP_KINDS.has(ext);
}

/** `ext` overrides the name's extension when the kind was found by content. */
function member(name: string, bytes: Uint8Array, ext?: string): MainLogMember {
  const base = baseName(name);
  return { name: base, ext: ext ?? extOf(base), bytes };
}

/** Why these bytes are not whole `.mlw` records, or null when they are. */
export function mlwRecordProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length > 0 && bytes.length % MLW_RECORD_BYTES === 0) return null;
  return `${baseName(name)} is ${bytes.length.toLocaleString("en-US")} bytes, not a whole number of ${MLW_RECORD_BYTES}-byte MainLog records`;
}

function checkRecords(name: string, bytes: Uint8Array): void {
  const problem = mlwRecordProblem(name, bytes);
  if (problem) throw new MainLogFormatError(problem, baseName(name));
}

const EOCD_SIG = 0x06054b50;
const EOCD_BYTES = 22;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EOCD_BYTES = 56;

function unreadable(reason: string): MainLogFormatError {
  return new MainLogFormatError(`not a readable MainLog archive: ${reason}`);
}

/**
 * The entry count a zip's End Of Central Directory record declares (the ZIP64
 * record's when the classic fields are saturated), read without parsing the
 * directory. Throws when neither record can be found.
 */
export function zipEntryCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => u32(at) + u32(at + 4) * 0x100000000;

  // The EOCD is the last 22 bytes plus a comment of at most 0xffff bytes.
  let eocd = -1;
  for (let i = bytes.length - EOCD_BYTES; i >= Math.max(0, bytes.length - EOCD_BYTES - 0xffff); i--) {
    if (u32(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable("the zip's end of central directory is missing (a truncated file?)");

  const saturated =
    u16(eocd + 4) === 0xffff ||
    u16(eocd + 6) === 0xffff ||
    u16(eocd + 8) === 0xffff ||
    u16(eocd + 10) === 0xffff ||
    u32(eocd + 12) === 0xffffffff ||
    u32(eocd + 16) === 0xffffffff;
  if (!saturated) return u16(eocd + 10);

  const locator = eocd - ZIP64_LOCATOR_BYTES;
  if (locator < 0 || u32(locator) !== ZIP64_LOCATOR_SIG) {
    throw unreadable("the zip's ZIP64 end of central directory locator is missing");
  }
  let record = u64(locator + 8);
  const fits = (at: number) => Number.isSafeInteger(at) && at >= 0 && at + ZIP64_EOCD_BYTES <= locator;
  if (!fits(record) || u32(record) !== ZIP64_EOCD_SIG) {
    // Data prepended to the archive shifts every offset; look for the record itself.
    record = -1;
    for (let i = locator - ZIP64_EOCD_BYTES; i >= 0; i--) {
      if (u32(i) === ZIP64_EOCD_SIG) {
        record = i;
        break;
      }
    }
    if (record < 0) throw unreadable("the zip's ZIP64 end of central directory is missing");
  }
  return u64(record + 32);
}

/** Minimal view of JSZip's (untyped) streaming API, used to count bytes as they inflate. */
interface InflateStream {
  on(event: "data", fn: (chunk: Uint8Array) => void): InflateStream;
  on(event: "error", fn: (err: unknown) => void): InflateStream;
  on(event: "end", fn: () => void): InflateStream;
  resume(): InflateStream;
  pause(): InflateStream;
}

/** First buffer for an entry that declares no usable size. */
const INFLATE_INITIAL_BYTES = 64 * 1024;

/**
 * Inflate one entry, stopping as soon as the running total passes the cap.
 * Declared sizes in a zip can lie, so the count is of bytes actually produced.
 *
 * Chunks go straight into one buffer: sized by the entry's declared size
 * (clamped to what the budget has left), grown geometrically when the entry
 * turns out larger, and never beyond what the budget allows it. So an honest
 * entry is held once, not as chunks plus a joined copy.
 */
function inflate(
  entry: JSZip.JSZipObject,
  budget: { used: number; max: number }
): Promise<Uint8Array> {
  const stream = (
    entry as unknown as { internalStream(type: "uint8array"): InflateStream }
  ).internalStream("uint8array");
  const declared = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  const allowance = budget.max - budget.used;
  const hint =
    typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0
      ? declared
      : INFLATE_INITIAL_BYTES;
  return new Promise((resolve, reject) => {
    let buf = new Uint8Array(Math.max(0, Math.min(hint, allowance)));
    let size = 0;
    let done = false;
    stream
      .on("data", (chunk) => {
        if (done) return;
        budget.used += chunk.length;
        if (budget.used > budget.max) {
          done = true;
          stream.pause();
          reject(
            new MainLogFormatError(
              `this archive unpacks to more than ${Math.floor(budget.max / (1024 * 1024))} MB, which is larger than any MainLog well`
            )
          );
          return;
        }
        const need = size + chunk.length;
        if (need > buf.length) {
          // need <= allowance here, because the budget check above passed.
          const grown = new Uint8Array(Math.min(Math.max(buf.length * 2, need), allowance));
          grown.set(buf.subarray(0, size));
          buf = grown;
        }
        buf.set(chunk, size);
        size = need;
      })
      .on("error", (err) => {
        if (done) return;
        done = true;
        reject(
          new MainLogFormatError(
            `${baseName(entry.name)} in this archive is damaged: ${err instanceof Error ? err.message : String(err)}`,
            baseName(entry.name)
          )
        );
      })
      .on("end", () => {
        if (done) return;
        done = true;
        resolve(size === buf.length ? buf : buf.subarray(0, size));
      })
      .resume();
  });
}

function tooMany(count: number, max: number): MainLogFormatError {
  return new MainLogFormatError(
    `this archive holds ${count.toLocaleString("en-US")} files, more than any MainLog well (limit ${max.toLocaleString("en-US")})`
  );
}

async function unzip(
  bytes: Uint8Array,
  opts: Required<ReadMainLogOptions>
): Promise<MainLogMember[]> {
  // The declared count is checked before JSZip builds an object per entry.
  const declared = zipEntryCount(bytes);
  if (declared > opts.maxMembers) throw tooMany(declared, opts.maxMembers);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new MainLogFormatError(
      `not a readable MainLog archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const entries = Object.values(zip.files).filter((e) => !e.dir && baseName(e.name) !== "");
  // JSZip reads the directory until the signatures stop, so a count that lied is caught here.
  if (entries.length > opts.maxMembers) throw tooMany(entries.length, opts.maxMembers);
  const budget = { used: 0, max: opts.maxTotalBytes };
  const members: MainLogMember[] = [];
  // Serial on purpose: the budget must stop inflation before the next entry starts.
  for (const entry of entries) {
    members.push(member(entry.name, await inflate(entry, budget)));
  }
  return members;
}

/** MainLog's backup copies are named `<log>@<depth>-<time>.mlw`. */
export function isMainLogBackupName(name: string): boolean {
  return stemOf(name).includes("@");
}

/**
 * The well's own measured-depth log among a bundle's `.mlw` members. `~` names
 * are TVD twins, never the primary. Several candidates: the one whose name the
 * archive name carries (sendfiles look like `<n>_<well>_ML.ml_`; the longest
 * such match wins), else the largest whole-record log that is not a backup
 * copy (a damaged or backup log stands only when nothing better is there).
 */
function pickPrimary(sourceName: string, mlws: MainLogMember[]): MainLogMember | null {
  const candidates = mlws.filter((m) => !m.name.startsWith("~"));
  if (candidates.length <= 1) return candidates[0] ?? null;

  const archive = stemOf(sourceName).toLowerCase();
  const exact = candidates.find((m) => stemOf(m.name).toLowerCase() === archive);
  if (exact) return exact;

  const carried = candidates
    .filter((m) => archive.includes(stemOf(m.name).toLowerCase()))
    .sort((a, b) => stemOf(b.name).length - stemOf(a.name).length);
  if (carried.length > 0) return carried[0];

  const rank = (m: MainLogMember): [number, number, number] => [
    mlwRecordProblem(m.name, m.bytes) === null ? 1 : 0,
    isMainLogBackupName(m.name) ? 0 : 1,
    m.bytes.length,
  ];
  const better = (a: MainLogMember, b: MainLogMember) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  return candidates.reduce((best, m) => (better(m, best) ? m : best));
}

/**
 * MainLog names the TVD log after the MD log with its first character replaced
 * by `~` (manual, "TVD Log": Star_1H.mlw -> ~tar_1H.mlw). Windows names are
 * case-insensitive, so the match is too. With no primary, the largest `~` log
 * stands as the twin so a TVD-only sendfile still shows what it carries.
 */
function pickTvdTwin(
  primary: MainLogMember | null,
  mlws: MainLogMember[]
): MainLogMember | null {
  if (primary) {
    const want = ("~" + primary.name.slice(1)).toLowerCase();
    return mlws.find((m) => m !== primary && m.name.toLowerCase() === want) ?? null;
  }
  const tilde = mlws.filter((m) => m.name.startsWith("~"));
  if (tilde.length === 0) return null;
  return tilde.reduce((best, m) => (m.bytes.length > best.bytes.length ? m : best));
}

async function readArchive(
  sourceName: string,
  kind: MainLogSourceKind,
  bytes: Uint8Array,
  opts: Required<ReadMainLogOptions>
): Promise<MainLogWell> {
  const members = await unzip(bytes, opts);
  const mlws = members.filter((m) => m.ext === "mlw");
  if (mlws.length === 0 && !members.some((m) => m.ext === "las")) {
    throw new MainLogFormatError("no MainLog log in this archive");
  }
  // A damaged `.mlw` member is not a damaged bundle: parseMainLog lists it.
  const primary = pickPrimary(sourceName, mlws);
  return { sourceName, kind, members, primary, tvdTwin: pickTvdTwin(primary, mlws) };
}

/**
 * Gather a MainLog well from an upload. Throws `MainLogFormatError` when the
 * bytes are not a MainLog well; the message is meant for the user.
 */
export async function readMainLog(
  name: string,
  bytes: Uint8Array,
  options: ReadMainLogOptions = {}
): Promise<MainLogWell> {
  const opts: Required<ReadMainLogOptions> = {
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxMembers: options.maxMembers ?? DEFAULT_MAX_MEMBERS,
  };
  const sourceName = baseName(name);
  const ext = extOf(sourceName);

  if (ZIP_KINDS.has(ext)) {
    if (!isZip(bytes)) {
      throw new MainLogFormatError(
        `${sourceName} is not a MainLog archive: .${ext} files are zip archives and this one is not`
      );
    }
    return readArchive(sourceName, ext as MainLogSourceKind, bytes, opts);
  }

  if (ext === "mlw") {
    checkRecords(sourceName, bytes);
    const log = member(sourceName, bytes);
    return { sourceName, kind: "mlw", members: [log], primary: log, tvdTwin: null };
  }

  if (ext === "las") {
    return {
      sourceName,
      kind: "las",
      members: [member(sourceName, bytes)],
      primary: null,
      tvdTwin: null,
    };
  }

  // Some other name: go by content. A renamed bundle reads as a sendfile.
  if (isZip(bytes)) return readArchive(sourceName, "ml_", bytes, opts);
  if (looksLikeMlw(bytes)) {
    const log = member(sourceName, bytes, "mlw");
    return { sourceName, kind: "mlw", members: [log], primary: log, tvdTwin: null };
  }
  if (looksLikeLas(sourceName, bytes)) {
    return {
      sourceName,
      kind: "las",
      members: [member(sourceName, bytes, "las")],
      primary: null,
      tvdTwin: null,
    };
  }
  throw new MainLogFormatError(`${sourceName} is not a MainLog file`);
}
