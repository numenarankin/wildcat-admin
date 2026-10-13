/**
 * `.lag` members: MainLog's lag calculator settings (doc:
 * docs/plans/mainlog-format-companions.md, section 17). One 256-byte struct,
 * loaded straight into the lag dialog. Only the float32 fields traced through
 * dialog 45 are read, under the doc's names; casing, pump output, SPM and
 * measured lag are UNCONFIRMED and not emitted.
 */

import { MainLogFormatError, type MainLogContribution, type MainLogDecoder, type MainLogMember } from "../types";

export const LAG_BYTES = 0x100;

export const LAG_FIELDS: readonly { offset: number; name: string }[] = [
  { offset: 0x10, name: "Liner 1 length" },
  { offset: 0x14, name: "Liner 2 length" },
  { offset: 0x1c, name: "Open hole length" },
  { offset: 0x24, name: "DP-1 OD" },
  { offset: 0x28, name: "DP-2 OD" },
  { offset: 0x2c, name: "DP-1 ID" },
  { offset: 0x30, name: "DP-2 ID" },
  { offset: 0x34, name: "DP-1 length" },
  { offset: 0x38, name: "DP-2 length" },
  { offset: 0x3c, name: "DC-1 OD" },
  { offset: 0x40, name: "DC-2 OD" },
  { offset: 0x44, name: "DC-3 OD" },
  { offset: 0x48, name: "DC-1 ID" },
  { offset: 0x4c, name: "DC-2 ID" },
  { offset: 0x50, name: "DC-3 ID" },
  { offset: 0x74, name: "Washout/lag factor" },
  { offset: 0xa4, name: "Pump 1 efficiency" },
  { offset: 0xa8, name: "Pump 2 efficiency" },
];

export function decodeLag(member: MainLogMember): MainLogContribution {
  const size = member.bytes.byteLength;
  if (size !== LAG_BYTES) {
    throw new MainLogFormatError(
      `${size.toLocaleString("en-US")} bytes is not a lag calculator file (${LAG_BYTES} bytes)`,
      member.name
    );
  }
  const view = new DataView(member.bytes.buffer, member.bytes.byteOffset, size);
  const data: Record<string, number> = {};
  for (const f of LAG_FIELDS) {
    const x = view.getFloat32(f.offset, true);
    if (!Number.isFinite(x)) {
      throw new MainLogFormatError(`${f.name} at 0x${f.offset.toString(16)} is not a number`, member.name);
    }
    data[f.name] = x;
  }
  return { settings: [{ member: member.name, data }] };
}

export const lagDecoder: MainLogDecoder = {
  exts: ["lag"],
  decode: (member) => decodeLag(member),
};
