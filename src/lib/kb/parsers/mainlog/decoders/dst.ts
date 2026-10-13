/**
 * `.dst` members: drill-stem tests. Layout from docs/plans/mainlog-format-companions.md
 * ("doc"), section 8: headerless 1688-byte records, the transfer buffer of the
 * `MAINLOG DST REPORT` dialog. Every field is text; labels are the dialog's.
 *
 * No sample has been seen, so the layout is traced from code only. A test
 * carries no date; tests are ordered by their `From` depth.
 */

import type { MainLogDecoder, MainLogMember, MainLogReport } from "../types";
import { leadingDepth, recordCount, RecordReader, sortReports, type Field } from "./records";

export const DST_RECORD_BYTES = 0x698;

const FROM = 0x050;

const FIELDS: readonly Field[] = [
  { label: "DST no.", type: "text", offset: 0x000, max: 80 },
  { label: "From", type: "text", offset: FROM, max: 80 },
  { label: "To", type: "text", offset: 0x0a0, max: 80 },
  { label: "Formation", type: "text", offset: 0x0f0, max: 80 },
  { label: "Initial hydrostatic", type: "text", offset: 0x140, max: 80 },
  { label: "Initial flow pressure", type: "text", offset: 0x190, max: 81 },
  { label: "Initial flow time", type: "text", offset: 0x1e1, max: 80 },
  { label: "Initial shut-in pressure", type: "text", offset: 0x231, max: 80 },
  { label: "Initial shut-in time", type: "text", offset: 0x281, max: 80 },
  { label: "Final flow pressure", type: "text", offset: 0x2d1, max: 81 },
  { label: "Final flow time", type: "text", offset: 0x322, max: 80 },
  { label: "Final shut-in pressure", type: "text", offset: 0x372, max: 80 },
  { label: "Final shut-in time", type: "text", offset: 0x3c2, max: 80 },
  { label: "Final hydrostatic", type: "text", offset: 0x412, max: 80 },
  { label: "Drill pipe recovery", type: "lines", slots: [[0x462, 81], [0x4b3, 81]] },
  { label: "Sampler recovery", type: "lines", slots: [[0x504, 81], [0x555, 81]] },
  { label: "Comments", type: "lines", slots: [[0x5a6, 80], [0x5f6, 81], [0x647, 81]] },
];

export function decodeDst(member: MainLogMember): { reports: MainLogReport[] } {
  const n = recordCount(member, DST_RECORD_BYTES);
  const items: { report: MainLogReport; depth: number | null }[] = [];
  for (let r = 0; r < n; r++) {
    const rec = new RecordReader(member, r * DST_RECORD_BYTES, `test ${r + 1}`);
    const text = rec.pairs(FIELDS);
    if (!text) continue; // a blank record
    items.push({
      report: { kind: "dst", date: null, text },
      depth: leadingDepth(rec.text(FROM, 80, "From")),
    });
  }
  return { reports: sortReports(items) };
}

export const dstDecoder: MainLogDecoder = {
  exts: ["dst"],
  decode: (member) => decodeDst(member),
};
