/**
 * `.sho` members: show reports. Layout from docs/plans/mainlog-format-companions.md
 * ("doc"), section 5: headerless 1320-byte records.
 *
 * Only CONFIRMED fields are decoded; the picture file in the record tail
 * (0x4e4..) is not. The show's top and base come from its interval text
 * (`4030 to 4042`). Gas values are stored as text and kept as written,
 * negatives included (the demo has them; their meaning is unknown).
 *
 * `text` is the report as "Label: value" pairs in the doc's field order, empty
 * fields left out.
 */

import type { MainLogDecoder, MainLogMember, MainLogShow } from "../types";
import { fail, recordCount, RecordReader, type Field } from "./records";

export const SHO_RECORD_BYTES = 0x528;
/** Converted on load by MainLog (0x426032); not decoded here. */
const SHO_LEGACY_RECORD_BYTES = 0x419;

const INTERVAL = 0x0a2;

const gas = (when: string, base: number): Field[] =>
  ["HW", "C1", "C2", "C3", "IC4", "NC4"].map((g, i) => ({
    label: `Gas ${when} ${g}`,
    type: "text",
    offset: base + 10 * i,
    max: 10,
  }));

const FIELDS: readonly Field[] = [
  { label: "Company", type: "text", offset: 0x000, max: 80 },
  { label: "Well", type: "text", offset: 0x050, max: 80 },
  { label: "Show number", type: "u16", offset: 0x0a0 },
  { label: "Show interval", type: "text", offset: INTERVAL, max: 30 },
  { label: "ROP above", type: "text", offset: 0x0c0, max: 30 },
  { label: "ROP during", type: "text", offset: 0x0de, max: 30 },
  { label: "ROP after", type: "text", offset: 0x0fc, max: 30 },
  ...gas("above", 0x11a),
  ...gas("during", 0x156),
  ...gas("after", 0x192),
  { label: "Porosity", type: "text", offset: 0x1ce, max: 80 },
  { label: "Fluorescence", type: "text", offset: 0x21e, max: 80 },
  { label: "Cut", type: "text", offset: 0x26e, max: 80 },
  { label: "Formation", type: "text", offset: 0x2be, max: 80 },
  { label: "Lithology", type: "text", offset: 0x30e, max: 30 },
  { label: "Description", type: "lines", slots: [[0x32c, 35], [0x34f, 35], [0x372, 35], [0x395, 35]] },
  { label: "Comments", type: "lines", slots: [[0x3b8, 80], [0x408, 80], [0x458, 80]] },
  { label: "Gas above IC5", type: "text", offset: 0x4a8, max: 10 },
  { label: "Gas during IC5", type: "text", offset: 0x4b2, max: 10 },
  { label: "Gas after IC5", type: "text", offset: 0x4bc, max: 10 },
  { label: "Gas above NC5", type: "text", offset: 0x4c6, max: 10 },
  { label: "Gas during NC5", type: "text", offset: 0x4d0, max: 10 },
  { label: "Gas after NC5", type: "text", offset: 0x4da, max: 10 },
];

const DEPTH = String.raw`(\d+(?:\.\d+)?)\s*(?:'|ft\.?)?`;
const INTERVAL_RE = new RegExp(String.raw`^${DEPTH}(?:\s*(?:to|-)\s*${DEPTH})?$`, "i");

/** `4030 to 4042`, `4030-4042`, or a single depth. Null when it is none of those. */
export function parseShowInterval(s: string): { top: number; base: number } | null {
  const m = INTERVAL_RE.exec(s.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return { top: Math.min(a, b), base: Math.max(a, b) };
}

export function decodeSho(member: MainLogMember): { shows: MainLogShow[] } {
  const n = recordCount(member, SHO_RECORD_BYTES, { recordBytes: SHO_LEGACY_RECORD_BYTES, noun: "show" });
  const shows: MainLogShow[] = [];
  for (let r = 0; r < n; r++) {
    const rec = new RecordReader(member, r * SHO_RECORD_BYTES, `show record ${r + 1}`);
    const text = rec.pairs(FIELDS);
    if (!text) continue; // a blank record
    const interval = rec.text(INTERVAL, 30, "Show interval");
    const depths = parseShowInterval(interval);
    if (!depths) {
      fail(
        member,
        interval
          ? `show record ${r + 1} interval "${interval}" is not a depth range`
          : `show record ${r + 1} has no interval`
      );
    }
    shows.push({ ...depths, text });
  }
  return { shows };
}

export const shoDecoder: MainLogDecoder = {
  exts: ["sho"],
  decode: (member) => decodeSho(member),
};
