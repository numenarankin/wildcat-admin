/**
 * `.rpt` members: daily (morning) reports. Layout from
 * docs/plans/mainlog-format-companions.md ("doc"), section 6: headerless
 * 1600-byte records. Labels are the printed `DAILY DRILLING REPORT`'s own.
 *
 * Only CONFIRMED fields are decoded: the report number at 0x000, flowline and
 * separator values, lag, 24 h average TG and the bit line are not. Time is
 * printed after the date under `DATE:`, so it is one pair here too.
 *
 * `date` is ISO when the date text is month-day-year with a 4-digit year and a
 * real calendar day. Month comes first: the demo writes `11-29-2016`.
 */

import type { MainLogDecoder, MainLogMember, MainLogReport } from "../types";
import { recordCount, RecordReader, sortReports, type Field } from "./records";

export const RPT_RECORD_BYTES = 0x640;
/** Converted on load by MainLog (0x5e608a); not decoded here. */
const RPT_LEGACY_RECORD_BYTES = 0x4f0;

const DATE = 0x004;
const TIME = 0x022;
const DEPTH = 0x036;

const COMPONENTS = ["C1", "C2", "C3", "IC4", "NC4", "IC5", "NC5"];
const gas = (label: string, base: number): Field[] => [
  { label, type: "f32", offset: base },
  ...COMPONENTS.map((c, i): Field => ({ label: `${label} ${c}`, type: "f32", offset: base + 4 + 4 * i })),
];

/** Everything after `DATE:`, in the doc's table order. */
const FIELDS: readonly Field[] = [
  { label: "DEPTH", type: "f32", offset: DEPTH },
  { label: "OPERATIONS", type: "text", offset: 0x03a, max: 80 },
  { label: "FT. MADE", type: "f32", offset: 0x08a },
  { label: "ROP", type: "text", offset: 0x08e, max: 34 },
  { label: "DEV", type: "text", offset: 0x0b0, max: 80 },
  { label: "FORMATION", type: "text", offset: 0x100, max: 80 },
  { label: "NEXT TOP", type: "text", offset: 0x150, max: 80 },
  { label: "DAY NO", type: "i32", offset: 0x1b4 },
  { label: "Days Logging", type: "i32", offset: 0x1b8 },
  { label: "EST TD", type: "i32", offset: 0x1bc },
  { label: "PHONE", type: "text", offset: 0x1c0, max: 20 },
  { label: "HRS", type: "f32", offset: 0x1d4 },
  ...gas("BACKGROUND GAS", 0x1d8),
  ...gas("MAX FORM GAS", 0x1f8),
  ...gas("MAX CONN GAS", 0x218),
  ...gas("MAX TRIP GAS", 0x238),
  { label: "LITHOLOGY", type: "lines", slots: [[0x258, 80], [0x2a8, 80]] },
  { label: "WT", type: "text", offset: 0x2f8, max: 6 },
  { label: "VIS", type: "text", offset: 0x2fe, max: 6 },
  { label: "PH", type: "text", offset: 0x304, max: 6 },
  { label: "FL", type: "text", offset: 0x30a, max: 6 },
  { label: "CL", type: "text", offset: 0x310, max: 10 },
  { label: "SOL", type: "text", offset: 0x31a, max: 6 },
  { label: "FC", type: "text", offset: 0x320, max: 10 },
  { label: "MUD CHECK @", type: "i32", offset: 0x32a },
  { label: "YP", type: "i32", offset: 0x32e },
  { label: "PV", type: "i32", offset: 0x332 },
  { label: "GELS", type: "text", offset: 0x336, max: 20 },
  { label: "HT.HP.FL", type: "text", offset: 0x34a, max: 20 },
  { label: "PM", type: "f32", offset: 0x35e },
  { label: "PF", type: "f32", offset: 0x362 },
  { label: "MF", type: "f32", offset: 0x366 },
  { label: "Ca", type: "text", offset: 0x36a, max: 10 },
  { label: "SD", type: "f32", offset: 0x374 },
  { label: "OIL", type: "f32", offset: 0x378 },
  { label: "H2O", type: "f32", offset: 0x37c },
  { label: "O/W", type: "text", offset: 0x380, max: 10 },
  ...["Elec stab", "CaCl", "Salt", "Excess lime", "LCM", "Daily $", "Total $"].map(
    (label, i): Field => ({ label, type: "f32", offset: 0x38a + 4 * i })
  ),
  { label: "WOB", type: "text", offset: 0x3a6, max: 10 },
  { label: "RPM", type: "u16", offset: 0x3b0 },
  { label: "SPM", type: "u16", offset: 0x3b2 },
  { label: "PUMP PRESS", type: "u16", offset: 0x3b4 },
  {
    label: "REMARKS & SURVEYS",
    type: "lines",
    slots: [[0x3b6, 100], [0x41a, 100], [0x47e, 100], [0x4e2, 100], [0x546, 100]],
  },
  { label: "MAX FORM GAS AT", type: "i32", offset: 0x5aa },
  { label: "MAX CONN GAS AT", type: "i32", offset: 0x61f },
  { label: "MAX TRIP GAS AT", type: "i32", offset: 0x627 },
  { label: "BACKGROUND GAS FLARE", type: "text", offset: 0x5ae, max: 10 },
  { label: "MAX FORM GAS FLARE", type: "text", offset: 0x5b8, max: 10 },
  { label: "MAX CONN GAS FLARE", type: "text", offset: 0x5c2, max: 10 },
  { label: "MAX TRIP GAS FLARE", type: "text", offset: 0x5cc, max: 10 },
  { label: "BACKGROUND GAS CHOKES", type: "text", offset: 0x5e6, max: 10 },
  { label: "MAX FORM GAS CHOKES", type: "text", offset: 0x5f0, max: 10 },
  { label: "MAX CONN GAS CHOKES", type: "text", offset: 0x5fa, max: 10 },
  { label: "MAX TRIP GAS CHOKES", type: "text", offset: 0x604, max: 10 },
  { label: "WT IN", type: "text", offset: 0x613, max: 12 },
];

/** `8-7-2007` or `8/7/2007` as `2007-08-07`; null for anything else. */
export function reportDate(s: string): string | null {
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function decodeRpt(member: MainLogMember): { reports: MainLogReport[] } {
  const n = recordCount(member, RPT_RECORD_BYTES, { recordBytes: RPT_LEGACY_RECORD_BYTES, noun: "daily report" });
  const items: { report: MainLogReport; depth: number | null }[] = [];
  for (let r = 0; r < n; r++) {
    const rec = new RecordReader(member, r * RPT_RECORD_BYTES, `report ${r + 1}`);
    const date = rec.text(DATE, 30, "DATE");
    const time = rec.text(TIME, 20, "DATE");
    const when = [date, time].filter(Boolean).join(" ");
    const rest = rec.pairs(FIELDS);
    const text = [when ? `DATE: ${when}` : "", rest].filter(Boolean).join("; ");
    if (!text) continue; // a blank record
    const depth = rec.f32(DEPTH);
    items.push({
      report: { kind: "daily", date: reportDate(date), text },
      depth: Number.isFinite(depth) && depth !== 0 ? depth : null,
    });
  }
  return { reports: sortReports(items) };
}

export const rptDecoder: MainLogDecoder = {
  exts: ["rpt"],
  decode: (member) => decodeRpt(member),
};
