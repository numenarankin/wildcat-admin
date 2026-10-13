/**
 * `.bit` members: bit records. Layout from docs/plans/mainlog-format-companions.md
 * ("doc"), section 18: headerless 2332-byte records, read by the end-of-well
 * report (0x43a8c3). No sample has been seen; traced from code only.
 *
 * Bits are not reports, so they go to `settings` as `{ bits: [...] }`. Depths
 * and footage are int32 and hours a float32, as the doc confirms; every text
 * field stays text ("" when empty). A text field runs to the next field's
 * offset; the last one (condition) runs to the end of the record.
 */

import type { MainLogContribution, MainLogDecoder, MainLogMember } from "../types";
import { float32Value, recordCount, RecordReader } from "./records";

export const BIT_RECORD_BYTES = 0x91c;

export interface MainLogBit {
  number: number;
  depthIn: number;
  depthOut: number;
  footage: number;
  hoursOnBottom: number;
  diameter: string;
  brand: string;
  type: string;
  jets: string;
  info: string;
  condition: string;
}

export function decodeBits(member: MainLogMember): MainLogBit[] {
  const n = recordCount(member, BIT_RECORD_BYTES);
  const bits: MainLogBit[] = [];
  for (let r = 0; r < n; r++) {
    const rec = new RecordReader(member, r * BIT_RECORD_BYTES, `bit record ${r + 1}`);
    const bit: MainLogBit = {
      number: rec.i32(0x000),
      depthIn: rec.i32(0x004),
      depthOut: rec.i32(0x008),
      footage: rec.i32(0x00c),
      hoursOnBottom: float32Value(rec.f32(0x014)),
      diameter: rec.text(0x018, 0x022 - 0x018, "diameter"),
      brand: rec.text(0x022, 0x040 - 0x022, "brand"),
      type: rec.text(0x040, 0x05e - 0x040, "type"),
      jets: rec.text(0x05e, 0x07c - 0x05e, "jets"),
      info: rec.text(0x07c, 0x0e0 - 0x07c, "info"),
      condition: rec.text(0x0e0, BIT_RECORD_BYTES - 0x0e0, "condition"),
    };
    // A blank record: every field zero or empty.
    if (Object.values(bit).every((v) => v === 0 || v === "")) continue;
    bits.push(bit);
  }
  return bits;
}

export const bitDecoder: MainLogDecoder = {
  exts: ["bit"],
  decode: (member): MainLogContribution => ({
    settings: [{ member: member.name, data: { bits: decodeBits(member) } }],
  }),
};
