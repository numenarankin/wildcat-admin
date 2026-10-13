/**
 * `.hxt` members: notes drawn on the horizontal log. Layout from
 * docs/plans/mainlog-format-companions.md section 4 ("doc" below): 0x2f6
 * (758)-byte records, no header.
 *
 * Decoded (CONFIRMED): depth (int32 +0x000) and text (char[500] +0x024), all to
 * `memos`. The doc traces the depth to the `NOTE DEPTH` edit and names no
 * vertical-section variant, so it is kept as the well's measured depth in ft.
 * Not emitted: the IS DESCRIPTION flag (+0x22b; these are horizontal-view
 * notes, and the lithology descriptions come from `.mem`), number, colours,
 * font and drawing flags, and the UNCONFIRMED screen rect.
 *
 * Text line breaks (`\r\r\n`, `\r\n`, `\n\r`) become "\n" and the text is
 * trimmed. A note with blank text carries nothing and is skipped.
 */

import {
  MainLogFormatError,
  type DepthText,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";
import { editText, fixedText } from "../text";

export const HXT_RECORD_BYTES = 0x2f6;
const MAX_PLAUSIBLE_DEPTH = 60000;

const O = { depth: 0x000, text: 0x024 } as const;
const TEXT_BYTES = 500;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeHxt(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size % HXT_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${HXT_RECORD_BYTES}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const memos: DepthText[] = [];
  for (let r = 0; r < size / HXT_RECORD_BYTES; r++) {
    const at = r * HXT_RECORD_BYTES;
    const depth = view.getInt32(at + O.depth, true);
    const text = editText(fixedText(bytes, at + O.text, TEXT_BYTES));
    if (!text && depth === 0) continue;
    if (depth < 0 || depth > MAX_PLAUSIBLE_DEPTH) {
      fail(member, `record ${r} has depth ${depth}, not a plausible depth`);
    }
    if (text) memos.push({ depth, text });
  }
  return { memos };
}

export const hxtDecoder: MainLogDecoder = {
  exts: ["hxt"],
  decode: (member) => decodeHxt(member),
};
