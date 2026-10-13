/**
 * `.trg` members: MainLog's survey target curve (doc:
 * docs/plans/mainlog-format-companions.md, section 13). Text. Each station is
 * written as labelled values, one per line, and ends with a blank line:
 *
 *   MD= %5.2f / TVD= %5.2f                        (0x710726)
 *   four of MD TVD AZM INCL VS DLS, `%s= %5.2f`   (0x7106c4)
 *
 * The write format is CONFIRMED; which four labels the second form carries is
 * not, so values are read by the label the file itself prints, never by line
 * position. A station without MD is refused. DLS has no station field and is
 * not emitted.
 *
 * A target curve is the planned path the well is steered to, not a measured
 * survey, so nothing lands in `surveys`. The stations go to
 * `settings: [{ member, data: { targetCurve } }]`, each `{ md, tvd?, inc?,
 * azi?, vs? }` with a value the station does not carry left out (the MD/TVD
 * form has no angles).
 */

import {
  MainLogFormatError,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";
import { bytesToText } from "../text";

const LABELS = ["MD", "TVD", "AZM", "INCL", "VS", "DLS"] as const;
type Label = (typeof LABELS)[number];

/** One station of the target curve. */
export interface TargetStation {
  md: number;
  tvd?: number;
  inc?: number;
  azi?: number;
  vs?: number;
}

const LINE = /^\s*([A-Za-z]+)=\s*(-?\d+(?:\.\d+)?)\s*$/;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeTrg(member: MainLogMember): MainLogContribution {
  const lines = bytesToText(member.bytes).split(/\r*\n/);
  const targetCurve: TargetStation[] = [];
  let station: Partial<Record<Label, number>> = {};
  let stationLine = 0;

  const close = () => {
    if (Object.keys(station).length === 0) return;
    if (station.MD === undefined) fail(member, `the station at line ${stationLine} has no MD`);
    const s: TargetStation = { md: station.MD };
    if (station.TVD !== undefined) s.tvd = station.TVD;
    if (station.INCL !== undefined) s.inc = station.INCL;
    if (station.AZM !== undefined) s.azi = station.AZM;
    if (station.VS !== undefined) s.vs = station.VS;
    targetCurve.push(s);
    station = {};
  };

  lines.forEach((line, i) => {
    if (line.trim() === "") return close();
    const m = LINE.exec(line);
    if (!m) fail(member, `line ${i + 1} is not a "LABEL= value" survey line`);
    const label = m[1].toUpperCase() as Label;
    if (!LABELS.includes(label)) fail(member, `line ${i + 1} has an unknown label ${m[1]}`);
    if (Object.keys(station).length === 0) stationLine = i + 1;
    if (station[label] !== undefined) fail(member, `the station at line ${stationLine} repeats ${label}`);
    station[label] = Number(m[2]);
  });
  close();

  if (targetCurve.length === 0) fail(member, "holds no target curve stations");
  return { settings: [{ member: member.name, data: { targetCurve } }] };
}

export const trgDecoder: MainLogDecoder = {
  exts: ["trg"],
  decode: (member) => decodeTrg(member),
};
