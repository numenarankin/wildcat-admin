/**
 * `.qpt` members: short reports. Layout from docs/plans/mainlog-format-companions.md
 * ("doc"), section 7: headerless 512-byte records. Labels are the ones MainLog
 * draws on the log (0x5a26e5); the report depth is drawn as `@ <depth>`.
 *
 * Only CONFIRMED fields are decoded: the report number at 0x000, the custom
 * fields at 0x08e/0x0a2/0x0de/0x0f2 (labels unconfirmed), colours and draw
 * options are not. The two custom mech lines carry their own label in the text
 * (`SPM #1  70`). Short reports carry no date.
 */

import type { MainLogDecoder, MainLogMember, MainLogReport } from "../types";
import { recordCount, RecordReader, sortReports, type Field } from "./records";

export const QPT_RECORD_BYTES = 0x200;

const DEPTH = 0x004;

const FIELDS: readonly Field[] = [
  { label: "DEPTH", type: "i32", offset: DEPTH },
  { label: "WOB", type: "text", offset: 0x00c, max: 10 },
  { label: "RPM", type: "text", offset: 0x016, max: 10 },
  { label: "PP", type: "text", offset: 0x020, max: 10 },
  { label: "SPM", type: "text", offset: 0x02a, max: 10 },
  { label: "WT OUT", type: "text", offset: 0x034, max: 10 },
  { label: "VIS", type: "text", offset: 0x03e, max: 10 },
  { label: "PH", type: "text", offset: 0x048, max: 10 },
  { label: "FIL", type: "text", offset: 0x052, max: 10 },
  { label: "CHL", type: "text", offset: 0x05c, max: 10 },
  { label: "SOL", type: "text", offset: 0x066, max: 10 },
  { label: "FIL/CK", type: "text", offset: 0x070, max: 10 },
  { label: "YP", type: "text", offset: 0x07a, max: 10 },
  { label: "PV", type: "text", offset: 0x084, max: 10 },
  { label: "MRPM", type: "text", offset: 0x0d2, max: 10 },
  { label: "WT IN", type: "text", offset: 0x108, max: 10 },
  { label: "Custom mech line 1", type: "text", offset: 0x11a, max: 20 },
  { label: "Custom mech line 2", type: "text", offset: 0x12e, max: 20 },
];

export function decodeQpt(member: MainLogMember): { reports: MainLogReport[] } {
  const n = recordCount(member, QPT_RECORD_BYTES);
  const items: { report: MainLogReport; depth: number | null }[] = [];
  for (let r = 0; r < n; r++) {
    const rec = new RecordReader(member, r * QPT_RECORD_BYTES, `short report ${r + 1}`);
    const text = rec.pairs(FIELDS);
    if (!text) continue; // a blank record
    const depth = rec.i32(DEPTH);
    items.push({ report: { kind: "short", date: null, text }, depth: depth !== 0 ? depth : null });
  }
  return { reports: sortReports(items) };
}

export const qptDecoder: MainLogDecoder = {
  exts: ["qpt"],
  decode: (member) => decodeQpt(member),
};
