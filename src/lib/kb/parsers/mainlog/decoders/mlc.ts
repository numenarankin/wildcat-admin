/**
 * `.mlc` members: MainLog's imported e-log curves (doc:
 * docs/plans/mainlog-format-companions.md, section 9). Headerless 96-byte
 * records of float32[24]; slot 0 is depth (CONFIRMED).
 *
 * The structure is checked as MainLog's own loader checks it (0x4da58a): slots
 * 0..15 are never NaN ("MLC FILE CURRUPTED") and depth rises by more than 0
 * and at most 2 per record ("Gamma Data Corrupted").
 *
 * No curve is emitted. Slot 1 is probably gamma ray, but that and every other
 * slot is UNCONFIRMED, so a well-formed member is refused with its record
 * count and depth range and lands in `undecoded`.
 */

import { MainLogFormatError, type MainLogContribution, type MainLogDecoder, type MainLogMember } from "../types";

export const MLC_RECORD_BYTES = 96;
const CHECKED_SLOTS = 16;
const MAX_STEP = 2;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeMlc(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size === 0 || size % MLC_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${MLC_RECORD_BYTES}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const n = size / MLC_RECORD_BYTES;
  let prev = NaN;
  for (let r = 0; r < n; r++) {
    const at = r * MLC_RECORD_BYTES;
    for (let s = 0; s < CHECKED_SLOTS; s++) {
      if (Number.isNaN(view.getFloat32(at + s * 4, true))) fail(member, `record ${r} slot ${s} is NaN`);
    }
    const d = view.getFloat32(at, true);
    if (r > 0 && !(d > prev && d - prev <= MAX_STEP)) {
      fail(member, `record ${r} is at ${d} ft after ${prev} ft; depth must rise by at most ${MAX_STEP} ft per record`);
    }
    prev = d;
  }
  const first = view.getFloat32(0, true);
  // TODO(open item 1, docs/plans/mainlog-format-companions.md): map slots 1..23
  // to curves (slot 1 is probably gamma ray) and emit them as an eLog. Until
  // then nothing but depth is confirmed, so the member is refused.
  fail(
    member,
    `curve slots in .mlc are not yet mapped; only depth is confirmed (${n.toLocaleString("en-US")} records, ${first} to ${prev} ft)`
  );
}

export const mlcDecoder: MainLogDecoder = {
  exts: ["mlc"],
  decode: (member) => decodeMlc(member),
};
