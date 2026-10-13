/**
 * `.topx` members: formation tops, and the legacy `.top` MainLog converts on
 * load. Layouts from docs/plans/mainlog-format-companions.md section 2 ("doc"
 * below).
 *
 * `.topx`: 0xfd (253)-byte records, no header. `.top`: 0x49 (73)-byte records.
 * Decoded (CONFIRMED): depth (int32 +0x00, ft MD), menu name, the text drawn on
 * the log, TVD. Not emitted: number, text position, colour, drawing flags, the
 * target zone width, and the UNCONFIRMED lithology index / width.
 *
 * Name: the menu name; when that is blank, the log text without the leading
 * `<` MainLog uses to mean "Print unchecked". TVD: only when above 0 (0 and -1
 * mean unset). A record with neither a name nor a depth is an empty slot and is
 * skipped.
 *
 * MainLog reads `.top` only when the well has no `.topx` (doc, loader
 * 0x425821), so a `.top` beside a `.topx` of the same name contributes nothing.
 */

import {
  MainLogFormatError,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
  type MainLogTop,
  type MainLogWell,
} from "../types";
import { fixedText } from "../text";

export const TOPX_RECORD_BYTES = 0xfd;
export const TOP_RECORD_BYTES = 0x49;
/** Deeper than any drilled well; a larger int32 is not a depth. */
export const MAX_PLAUSIBLE_DEPTH = 60000;

interface Layout {
  record: number;
  name: [offset: number, size: number];
  text: [offset: number, size: number];
  tvd: (view: DataView, at: number) => number;
}

const TOPX: Layout = {
  record: TOPX_RECORD_BYTES,
  name: [0x0d, 30],
  text: [0x2f, 45],
  tvd: (view, at) => view.getFloat32(at + 0x69, true),
};

const TOP: Layout = {
  record: TOP_RECORD_BYTES,
  name: [0x0d, 20],
  text: [0x21, 30],
  tvd: (view, at) => view.getUint16(at + 0x47, true),
};

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

export function decodeTops(member: MainLogMember, layout: Layout): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size % layout.record !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${layout.record}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const tops: MainLogTop[] = [];
  for (let r = 0; r < size / layout.record; r++) {
    const at = r * layout.record;
    const depth = view.getInt32(at, true);
    const menu = fixedText(bytes, at + layout.name[0], layout.name[1]).trim();
    const text = fixedText(bytes, at + layout.text[0], layout.text[1]).replace(/^</, "").trim();
    const name = menu || text;
    if (!name && depth === 0) continue;
    if (depth < 0 || depth > MAX_PLAUSIBLE_DEPTH) {
      fail(member, `record ${r} has depth ${depth}, not a plausible depth`);
    }
    if (/[\x01-\x1f]/.test(name)) fail(member, `record ${r} name holds control bytes`);
    const top: MainLogTop = { name, depth };
    const tvd = layout.tvd(view, at);
    // Entered as `%.2f` (doc, edit 114); rounding drops the float32 noise.
    if (Number.isFinite(tvd) && tvd > 0) top.tvd = Math.round(tvd * 100) / 100;
    tops.push(top);
  }
  return { tops };
}

export function decodeTopx(member: MainLogMember): MainLogContribution {
  return decodeTops(member, TOPX);
}

export function decodeLegacyTop(member: MainLogMember, well?: MainLogWell): MainLogContribution {
  const own = stem(member.name);
  if (well?.members.some((m) => m.ext === "topx" && stem(m.name) === own)) return {};
  return decodeTops(member, TOP);
}

export const topxDecoder: MainLogDecoder = {
  exts: ["topx", "top"],
  decode: (member, well) =>
    member.ext === "top" ? decodeLegacyTop(member, well) : decodeTopx(member),
};
