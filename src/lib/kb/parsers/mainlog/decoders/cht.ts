/**
 * `.cht` members: MainLog's real-time gas chart (doc:
 * docs/plans/mainlog-format-companions.md, section 15). Headerless 56-byte
 * records, read as `filelength / 0x38`.
 *
 * Summarised, not inlined: channel names, row count, first and last time.
 * Only CONFIRMED fields are read (depth, lag depth, month, day, hour, minute,
 * second, hotwire, chromatograph total). The alarm and notes bytes at
 * 0x18..0x37 are not.
 *
 * The record has no year. MainLog names the file `<base>@M-DD-YY.cht`
 * (`@%d-%02d-%02d` from month, day, year-2000, 0x43c80e), so the year comes
 * from the member name; a renamed member gets null start and end. Times are
 * the logger's wall clock with no zone, so the ISO strings carry no offset.
 */

import {
  MainLogFormatError,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";

export const CHT_RECORD_BYTES = 0x38;

const O = {
  depth: 0x00,
  lagDepth: 0x02,
  month: 0x04,
  day: 0x06,
  hour: 0x08,
  minute: 0x0a,
  second: 0x0c,
  hotwire: 0x0e,
  chrom: 0x12,
} as const;

export const CHT_CHANNELS = ["Depth", "Lag depth", "Hotwire", "Chromatograph total"] as const;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

/** The year from MainLog's `@M-DD-YY.cht` suffix, or null when the name does not carry one. */
export function chtYear(name: string): number | null {
  const m = /@(\d{1,2})-(\d{2})-(\d{2,})\.cht$/i.exec(name);
  return m ? 2000 + Number(m[3]) : null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function decodeCht(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size === 0 || size % CHT_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${CHT_RECORD_BYTES}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const n = size / CHT_RECORD_BYTES;
  const year = chtYear(member.name);

  const stamp = (r: number): string | null => {
    const at = r * CHT_RECORD_BYTES;
    const t = {
      month: view.getUint16(at + O.month, true),
      day: view.getUint16(at + O.day, true),
      hour: view.getUint16(at + O.hour, true),
      minute: view.getUint16(at + O.minute, true),
      second: view.getUint16(at + O.second, true),
    };
    if (t.month < 1 || t.month > 12 || t.day < 1 || t.day > 31 || t.hour > 23 || t.minute > 59 || t.second > 59) {
      fail(member, `record ${r} has an impossible time (${t.month}/${t.day} ${t.hour}:${pad(t.minute)}:${pad(t.second)})`);
    }
    if (year === null) return null;
    return `${pad(year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
  };

  let start: string | null = null;
  let end: string | null = null;
  for (let r = 0; r < n; r++) {
    const s = stamp(r);
    if (r === 0) start = s;
    if (r === n - 1) end = s;
  }

  return {
    timeSeries: [{ member: member.name, source: "cht", channels: [...CHT_CHANNELS], rows: n, start, end }],
  };
}

export const chtDecoder: MainLogDecoder = {
  exts: ["cht"],
  decode: (member) => decodeCht(member),
};
