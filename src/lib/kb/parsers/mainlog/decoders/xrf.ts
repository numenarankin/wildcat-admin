/**
 * `.xrf` members: MainLog's XRF data (doc:
 * docs/plans/mainlog-format-companions.md, section 10). 622-byte records, a
 * float32 depth at +0 in 1-ft steps (CONFIRMED).
 *
 * The element and mineral slots are UNCONFIRMED (open item 3: the record mixes
 * widths and no slot is tied to a curve name), so no values are emitted. A
 * well-formed member is still refused, with its record count and depth range,
 * so the user sees what the file holds in `undecoded`.
 */

import { MainLogFormatError, type MainLogContribution, type MainLogDecoder, type MainLogMember } from "../types";

export const XRF_RECORD_BYTES = 0x26e;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeXrf(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size === 0 || size % XRF_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${XRF_RECORD_BYTES}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const n = size / XRF_RECORD_BYTES;
  const first = view.getFloat32(0, true);
  if (!Number.isFinite(first)) fail(member, `record 0 depth is not a number`);
  for (let r = 1; r < n; r++) {
    const d = view.getFloat32(r * XRF_RECORD_BYTES, true);
    if (d !== first + r) fail(member, `record ${r} is at ${d} ft; records must be 1 ft apart from ${first} ft`);
  }
  // TODO(open item 3, docs/plans/mainlog-format-companions.md): decode element
  // and mineral curves once their slots are confirmed.
  fail(
    member,
    `element and mineral slots in .xrf are not yet mapped; only depth is confirmed (${n.toLocaleString("en-US")} records, ${first} to ${first + n - 1} ft)`
  );
}

export const xrfDecoder: MainLogDecoder = {
  exts: ["xrf"],
  decode: (member) => decodeXrf(member),
};
