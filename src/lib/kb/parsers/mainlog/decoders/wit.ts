/**
 * `.wit` members: MainLog's WITS day file (doc:
 * docs/plans/mainlog-format-companions.md, section 16). MainLog preallocates
 * every file at 14,400 records of 208 bytes (24 h x 60 min x 10 slots, seconds
 * 6, 12, ... 60) and deletes a file of any other size, so only that size is
 * accepted.
 *
 * Each slot's timestamp and index are filled at creation, so a timestamp does
 * not mean a reading. A row counts as populated when a CONFIRMED channel
 * (total SPM at 0x0c or total gas at 0x10) is non-zero. The other WITS channels
 * (0x14..0xcf) are UNCONFIRMED and neither emitted nor used to detect rows, so
 * a slot holding only those channels is not counted.
 *
 * Times are the logger's wall clock with no zone, so the ISO strings carry no
 * offset. A second of 60 rolls into the next minute.
 */

import {
  MainLogFormatError,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";

export const WIT_RECORD_BYTES = 0xd0;
export const WIT_RECORDS = 14400;

const O = {
  day: 0x00,
  month: 0x02,
  year: 0x04, // year - 2000
  hour: 0x06,
  minute: 0x08,
  second: 0x0a,
  totalSpm: 0x0c,
  totalGas: 0x10,
  index: 0x2c,
} as const;

export const WIT_CHANNELS = ["Total SPM", "Total gas"] as const;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeWit(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  const expected = WIT_RECORDS * WIT_RECORD_BYTES;
  if (size !== expected) {
    fail(
      member,
      `${size.toLocaleString("en-US")} bytes is not a WITS day file (${WIT_RECORDS.toLocaleString("en-US")} x ${WIT_RECORD_BYTES}-byte records = ${expected.toLocaleString("en-US")} bytes)`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);

  let rows = 0;
  let start: string | null = null;
  let end: string | null = null;
  for (let r = 0; r < WIT_RECORDS; r++) {
    const at = r * WIT_RECORD_BYTES;
    const index = view.getUint16(at + O.index, true);
    if (index !== r) fail(member, `record ${r} carries index ${index}`);
    const t = {
      day: view.getUint16(at + O.day, true),
      month: view.getUint16(at + O.month, true),
      year: view.getUint16(at + O.year, true),
      hour: view.getUint16(at + O.hour, true),
      minute: view.getUint16(at + O.minute, true),
      second: view.getUint16(at + O.second, true),
    };
    if (t.month < 1 || t.month > 12 || t.day < 1 || t.day > 31 || t.hour > 23 || t.minute > 59 || t.second < 6 || t.second > 60) {
      fail(member, `record ${r} has an impossible time (${t.month}/${t.day}/${t.year} ${t.hour}:${t.minute}:${t.second})`);
    }
    if (view.getFloat32(at + O.totalSpm, true) === 0 && view.getFloat32(at + O.totalGas, true) === 0) continue;
    const iso = new Date(Date.UTC(2000 + t.year, t.month - 1, t.day, t.hour, t.minute, t.second))
      .toISOString()
      .slice(0, 19);
    if (rows === 0) start = iso;
    end = iso;
    rows++;
  }

  return {
    timeSeries: [{ member: member.name, source: "wit", channels: [...WIT_CHANNELS], rows, start, end }],
  };
}

export const witDecoder: MainLogDecoder = {
  exts: ["wit"],
  decode: (member) => decodeWit(member),
};
