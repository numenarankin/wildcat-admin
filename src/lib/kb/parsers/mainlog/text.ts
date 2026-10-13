/**
 * Byte helpers shared by the MainLog reader and decoders. Browser and Node
 * both: no Buffer, no fs.
 */

/**
 * Decode member bytes as text. MainLog is a Windows program, so its text files
 * (and its LAS export) are Windows-1252, not UTF-8; a degree sign or a curly
 * quote would otherwise come out as a replacement character.
 */
export function bytesToText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    // A runtime without the legacy encodings still reads plain ASCII correctly.
    return new TextDecoder().decode(bytes);
  }
}

/**
 * A NUL-terminated ASCII string at `offset`, at most `max` bytes. Null when the
 * field is empty, runs off the end, or holds anything but printable ASCII (so
 * a data byte is never passed off as text).
 */
export function asciiz(bytes: Uint8Array, offset: number, max: number): string | null {
  if (offset >= bytes.length) return null;
  const end = Math.min(bytes.length, offset + max);
  let s = "";
  for (let i = offset; i < end; i++) {
    const b = bytes[i];
    if (b === 0) break;
    if (b < 0x20 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  s = s.trim();
  return s ? s : null;
}

/**
 * A fixed `char[size]` field: the bytes up to the first NUL (anything after it
 * is a stale leftover of an earlier, longer value), decoded as Windows-1252.
 * Not trimmed, and control bytes are kept; callers decide what they allow.
 */
export function fixedText(bytes: Uint8Array, offset: number, size: number): string {
  const stop = Math.min(bytes.length, offset + size);
  let end = offset;
  while (end < stop && bytes[end] !== 0) end++;
  return end > offset ? bytesToText(bytes.subarray(offset, end)) : "";
}

/**
 * Edit-control text as plain text: MainLog stores line breaks as `\r\r\n`
 * (soft break) or `\r\n`, and some memos carry `\n\r`; all become "\n", a
 * stray `\r` is dropped, and the result is trimmed.
 */
export function editText(raw: string): string {
  return raw.replace(/\r*\n/g, "\n").replace(/\r/g, "").trim();
}
