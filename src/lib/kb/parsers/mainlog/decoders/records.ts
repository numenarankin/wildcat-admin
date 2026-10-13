/**
 * Shared reading for MainLog's fixed-record companion files (`.sho`, `.rpt`,
 * `.qpt`, `.dst`, `.bit`). Layouts are in docs/plans/mainlog-format-companions.md
 * ("doc" below); each decoder holds its own field table.
 *
 * Conventions (doc, section 0): little-endian; strings are fixed `char[n]`
 * buffers cut at the first NUL (bytes after it are stale leftovers), decoded as
 * Windows-1252. A string holding a control byte other than tab, CR or LF means
 * the record is not laid out the way the doc says, and the member is refused.
 *
 * Pure: no DOM, no fs, no Buffer.
 */

import { MainLogFormatError, type MainLogMember, type MainLogReport } from "../types";
import { bytesToText } from "../text";

export function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

/**
 * Record count of a headerless fixed-record file. Refuses an empty file, a
 * legacy layout MainLog converts on load (not yet supported here), and any size
 * that is not whole records.
 */
export function recordCount(
  member: MainLogMember,
  recordBytes: number,
  legacy?: { recordBytes: number; noun: string }
): number {
  const size = member.bytes.byteLength;
  if (size === 0) fail(member, "is empty");
  if (size % recordBytes !== 0) {
    if (legacy && size % legacy.recordBytes === 0) {
      fail(member, `legacy ${legacy.noun} file (${legacy.recordBytes}-byte records) not yet supported`);
    }
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${recordBytes}-byte records`);
  }
  return size / recordBytes;
}

/** One field of a record, as the doc lays it out. */
export type Field =
  | { label: string; type: "text"; offset: number; max: number }
  /** Several `char[n]` lines shown as one value, joined with " / ". */
  | { label: string; type: "lines"; slots: readonly (readonly [offset: number, max: number])[] }
  | { label: string; type: "i32" | "u16" | "f32"; offset: number };

/** A record of `bytes`, starting at `base`. `name` says which one in a refusal ("report 3"). */
export class RecordReader {
  private readonly view: DataView;
  constructor(
    private readonly member: MainLogMember,
    readonly base: number,
    private readonly name: string
  ) {
    const b = member.bytes;
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  i32(offset: number): number {
    return this.view.getInt32(this.base + offset, true);
  }
  u16(offset: number): number {
    return this.view.getUint16(this.base + offset, true);
  }
  f32(offset: number): number {
    return this.view.getFloat32(this.base + offset, true);
  }

  /** The string at `offset`, cut at the first NUL, trimmed; "" when empty. */
  text(offset: number, max: number, label: string): string {
    const bytes = this.member.bytes;
    const start = this.base + offset;
    let end = start;
    while (end < start + max && bytes[end] !== 0) {
      const b = bytes[end];
      if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
        fail(this.member, `${this.name} ${label} holds non-text bytes`);
      }
      end++;
    }
    return bytesToText(bytes.subarray(start, end)).trim();
  }

  /**
   * A field as display text, or null when it is empty. A numeric 0 counts as
   * empty: MainLog's blank records and untouched fields are zero-filled, so a
   * stored 0 cannot be told from a value nobody entered.
   */
  value(field: Field): string | null {
    let s: string;
    switch (field.type) {
      case "text":
        s = this.text(field.offset, field.max, field.label);
        break;
      case "lines":
        s = field.slots
          .map(([offset, max]) => this.text(offset, max, field.label))
          .filter((line) => line.length > 0)
          .join(" / ");
        break;
      case "i32":
        return numberText(this.i32(field.offset));
      case "u16":
        return numberText(this.u16(field.offset));
      case "f32":
        return numberText(this.f32(field.offset));
    }
    return s ? s : null;
  }

  /** Non-empty fields as "Label: value" pairs joined with "; ", in table order. */
  pairs(fields: readonly Field[]): string {
    const out: string[] = [];
    for (const field of fields) {
      const v = this.value(field);
      if (v !== null) out.push(`${field.label}: ${v}`);
    }
    return out.join("; ");
  }
}

/**
 * A float32 read into a double carries noise (219.2 reads as 219.1999969...).
 * This is the shortest decimal that is the same float32.
 */
export function float32Value(x: number): number {
  if (!Number.isFinite(x)) return x;
  for (let p = 1; p <= 9; p++) {
    const n = Number(x.toPrecision(p));
    if (Math.fround(n) === Math.fround(x)) return n;
  }
  return x;
}

function numberText(x: number): string | null {
  if (!Number.isFinite(x) || x === 0) return null;
  return String(float32Value(x));
}

/** A leading depth in free text ("4030", "4030'", " 4030 ft"), or null. */
export function leadingDepth(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Reports ordered by date then depth; a missing date or depth sorts last. Stable. */
export function sortReports(items: { report: MainLogReport; depth: number | null }[]): MainLogReport[] {
  const last = (a: string | null, b: string | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
  return [...items]
    .sort((a, b) => {
      const byDate = last(a.report.date, b.report.date);
      if (byDate !== 0) return byDate;
      if (a.depth === b.depth) return 0;
      if (a.depth === null) return 1;
      if (b.depth === null) return -1;
      return a.depth - b.depth;
    })
    .map((x) => x.report);
}
