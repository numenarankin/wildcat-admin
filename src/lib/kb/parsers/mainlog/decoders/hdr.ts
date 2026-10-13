/**
 * `.hdr` members: MainLog's well header, one fixed struct of 0x7ae (1966)
 * bytes. Layout from docs/plans/mainlog-format-companions.md section 1 ("doc"
 * below). Only CONFIRMED fields are decoded; the casing and bore-hole grids and
 * the dialog flags are not traced and are not emitted.
 *
 * Keys are LAS `~Well` mnemonics where MainLog's own LAS export prints the
 * field (COMP, WELL, FLD, LOC, LOC2, CNTY, STAT, DATE, API, EKB), `UWI` for the
 * unique well ID, and short keys for the rest:
 *
 *   SPUD        spud date              ENDDATE     end date
 *   STARTDEPTH  start depth            ENDDEPTH    end depth
 *   GL          ground level           LOGGERS     loggers line 1
 *   LOGGERS2    loggers line 2         UNIT        unit number
 *   RIG         rig / contractor       GEOLOGIST   company geologist
 *   FILE        `.mlw` file name       FILENO      file number
 *   PHONE       phone numbers          ENGINEER    engineer / company man
 *   ELOGKB      offset e-log KB
 *
 * Dates and depths are free text (`2400'`, `8/6/2007`) and stay text. A blank
 * field is left out.
 *
 * A file longer than 0x7ae is read by its first 0x7ae bytes, as MainLog reads
 * it (doc, loader 0x4246c3). The demo is 2052 bytes: its 86-byte tail comes
 * from a newer build (it repeats the KB at 0x7da) and is ignored.
 *
 * The demo's anonymised values (`\0ABORS #30`, `\0/3/07`, ...) have a NUL as
 * their first byte. The bytes place every one of them exactly at its doc
 * offset: the NUL sits on the field's first byte, the text runs from the next
 * byte, and the fields whose first letter was kept (county 0xbe `A county In`,
 * state 0xdc `TEXAS`, location 0xfa `The great US of A`) start on the offset
 * itself. So the field does not start one byte later, and nothing in the code
 * reads that byte as a flag: MainLog `strcpy`s these fields and would show them
 * empty too. They decode as blank, and the missing letter is not guessed.
 */

import { MainLogFormatError, type MainLogContribution, type MainLogDecoder, type MainLogMember } from "../types";
import { fixedText } from "../text";

export const HDR_BYTES = 0x7ae;
/** Older header sizes MainLog converts on load; their layouts are not traced. */
const LEGACY_HDR_BYTES = [0x55a, 0x5aa];

/** [key, offset, size], in struct order (doc, section 1). All CONFIRMED. */
const FIELDS: readonly [key: string, offset: number, size: number][] = [
  ["COMP", 0x000, 80],
  ["WELL", 0x050, 80],
  ["FLD", 0x0a0, 30],
  ["CNTY", 0x0be, 30],
  ["STAT", 0x0dc, 30],
  ["LOC", 0x0fa, 80],
  ["LOC2", 0x14a, 80],
  ["SPUD", 0x19a, 20],
  ["DATE", 0x1ae, 20],
  ["ENDDATE", 0x1c2, 20],
  ["STARTDEPTH", 0x1d6, 20],
  ["ENDDEPTH", 0x1ea, 20],
  ["GL", 0x1fe, 30],
  ["EKB", 0x21c, 30],
  ["API", 0x23a, 30],
  ["LOGGERS", 0x258, 80],
  ["LOGGERS2", 0x2a8, 80],
  ["UNIT", 0x2f8, 30],
  ["RIG", 0x316, 80],
  ["GEOLOGIST", 0x366, 20],
  ["FILE", 0x37a, 50],
  ["FILENO", 0x3ac, 16],
  ["PHONE", 0x73e, 36],
  ["ENGINEER", 0x762, 30],
  ["ELOGKB", 0x780, 12],
  ["UWI", 0x790, 15],
];

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeHdr(member: MainLogMember): MainLogContribution {
  const size = member.bytes.byteLength;
  if (LEGACY_HDR_BYTES.includes(size)) {
    fail(member, `older ${size}-byte header layout is not supported`);
  }
  if (size < HDR_BYTES) {
    fail(member, `${size.toLocaleString("en-US")} bytes is shorter than the ${HDR_BYTES}-byte header`);
  }
  const bytes = member.bytes.subarray(0, HDR_BYTES);

  const well: Record<string, string> = {};
  for (const [key, offset, max] of FIELDS) {
    const raw = fixedText(bytes, offset, max);
    // Header fields are single-line edits; a control byte means this is not a header.
    if (/[\x01-\x1f]/.test(raw)) fail(member, `${key} at 0x${offset.toString(16)} holds control bytes`);
    const value = raw.trim();
    if (value) well[key] = value;
  }
  return { well };
}

export const hdrDecoder: MainLogDecoder = {
  exts: ["hdr"],
  decode: (member) => decodeHdr(member),
};
