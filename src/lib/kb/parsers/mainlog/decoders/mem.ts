/**
 * `.mem` members: depth-anchored memos. Layout from
 * docs/plans/mainlog-format-companions.md section 3 ("doc" below): 0x32c
 * (812)-byte records, no header.
 *
 * Decoded (CONFIRMED): depth (int32 +0x000, ft), text (char[500] +0x004), and
 * the IS DESCRIPTION flag (uint8 +0x229). A flagged memo is a lithology
 * description and goes to `descriptions`; the rest go to `memos`. Not emitted:
 * number, text position, colours, font and drawing flags.
 *
 * Text line breaks (`\r\r\n`, `\r\n`, `\n\r`) become "\n" and the text is
 * trimmed. A memo with blank text carries nothing and is skipped.
 */

import {
  MainLogFormatError,
  type DepthText,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";
import { editText, fixedText } from "../text";

export const MEM_RECORD_BYTES = 0x32c;
const MAX_PLAUSIBLE_DEPTH = 60000;

const O = { depth: 0x000, text: 0x004, isDescription: 0x229 } as const;
const TEXT_BYTES = 500;

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeMem(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size % MEM_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${MEM_RECORD_BYTES}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const descriptions: DepthText[] = [];
  const memos: DepthText[] = [];
  for (let r = 0; r < size / MEM_RECORD_BYTES; r++) {
    const at = r * MEM_RECORD_BYTES;
    const depth = view.getInt32(at + O.depth, true);
    const text = editText(fixedText(bytes, at + O.text, TEXT_BYTES));
    if (!text && depth === 0) continue;
    if (depth < 0 || depth > MAX_PLAUSIBLE_DEPTH) {
      fail(member, `record ${r} has depth ${depth}, not a plausible depth`);
    }
    if (!text) continue;
    const flag = bytes[at + O.isDescription];
    if (flag > 1) fail(member, `record ${r} has IS DESCRIPTION ${flag}, not 0 or 1`);
    (flag === 1 ? descriptions : memos).push({ depth, text });
  }
  return { descriptions, memos };
}

export const memDecoder: MainLogDecoder = {
  exts: ["mem"],
  decode: (member) => decodeMem(member),
};
