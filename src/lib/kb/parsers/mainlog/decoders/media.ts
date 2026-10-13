/**
 * Media members: pictures and documents (`.jpg`, `.jpeg`, `.bmp`, `.png`,
 * `.pdf`) and alarm sounds (`.wav`).
 *
 * The magic bytes must match the extension; a mismatch throws. Logos shipped
 * with MainLog are pictures too and are not filtered.
 *
 * Depth: the manual ("Insert Photos\Pictures & Iso-Tube Reports") says MainLog
 * renames a dropped `7020.jpg` to `<filename>@depth.jpg`. That is the only
 * confirmed pattern, so depth is read from a `.jpg` name ending `@<digits>` and
 * is null otherwise (an un-renamed `7020.jpg`, `iso7100.jpg`, a logo, a bmp).
 *
 * Pure: no DOM, no fs, no Buffer.
 */

import { MainLogFormatError, type MainLogDecoder, type MainLogMember } from "../types";

const JPEG = [0xff, 0xd8];
const BMP = [0x42, 0x4d]; // "BM"
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

const PICTURE_KINDS: Record<string, { mime: string; magic: number[] }> = {
  jpg: { mime: "image/jpeg", magic: JPEG },
  jpeg: { mime: "image/jpeg", magic: JPEG },
  bmp: { mime: "image/bmp", magic: BMP },
  png: { mime: "image/png", magic: PNG },
  pdf: { mime: "application/pdf", magic: PDF },
};

function startsWith(bytes: Uint8Array, magic: number[], at = 0): boolean {
  if (bytes.length < at + magic.length) return false;
  return magic.every((b, i) => bytes[at + i] === b);
}

/** `<filename>@depth.jpg` (manual). Null for any other name. */
export function pictureDepthFromName(name: string): number | null {
  const m = /@(\d+)\.jpg$/i.exec(name);
  return m ? Number(m[1]) : null;
}

export const pictureDecoder: MainLogDecoder = {
  exts: Object.keys(PICTURE_KINDS),
  decode(member: MainLogMember) {
    const kind = PICTURE_KINDS[member.ext];
    if (!kind || !startsWith(member.bytes, kind.magic)) {
      throw new MainLogFormatError(`${member.name} is not a .${member.ext} file`, member.name);
    }
    return { pictures: [{ member: member.name, mime: kind.mime, depth: pictureDepthFromName(member.name) }] };
  },
};

export interface AudioSettings {
  bytes: number;
  kind: "audio";
}

/** RIFF container, `WAVE` form type at 8. */
export const wavDecoder: MainLogDecoder = {
  exts: ["wav"],
  decode(member) {
    const b = member.bytes;
    if (!startsWith(b, [0x52, 0x49, 0x46, 0x46]) || !startsWith(b, [0x57, 0x41, 0x56, 0x45], 8)) {
      throw new MainLogFormatError(`${member.name} is not a .wav file`, member.name);
    }
    const data: AudioSettings = { bytes: b.length, kind: "audio" };
    return { settings: [{ member: member.name, data: { ...data } }] };
  },
};

export const MEDIA_DECODERS: MainLogDecoder[] = [pictureDecoder, wavDecoder];
