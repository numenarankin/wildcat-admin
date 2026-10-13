/**
 * `.gas` members: MainLog's gas monitor readings (doc:
 * docs/plans/mainlog-format-companions.md, section 14). Append-only 520-byte
 * records, no header.
 *
 * Summarised, not inlined. Channels are the CONFIRMED fields: the depth key
 * (int32 at 0x00, matched to `.mlw` depths; its name "lagged depth" is
 * UNCONFIRMED, so it is called the depth key), bit depth, hotwire and C1..C5.
 * No timestamp has been located in the record, so start and end are null.
 */

import {
  MainLogFormatError,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";

export const GAS_RECORD_BYTES = 0x208;

const O = { depthKey: 0x00, bitDepth: 0x04 } as const;

export const GAS_CHANNELS = ["Depth key", "Bit depth", "Hotwire", "C1", "C2", "C3", "IC4", "NC4", "C5"] as const;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeGas(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size === 0 || size % GAS_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${GAS_RECORD_BYTES}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const n = size / GAS_RECORD_BYTES;
  for (let r = 0; r < n; r++) {
    const at = r * GAS_RECORD_BYTES;
    const key = view.getInt32(at + O.depthKey, true);
    const bit = view.getInt32(at + O.bitDepth, true);
    if (key < 0 || bit < 0) fail(member, `record ${r} has a negative depth (key ${key}, bit ${bit})`);
  }
  return {
    timeSeries: [{ member: member.name, source: "gas", channels: [...GAS_CHANNELS], rows: n, start: null, end: null }],
  };
}

export const gasDecoder: MainLogDecoder = {
  exts: ["gas"],
  decode: (member) => decodeGas(member),
};
