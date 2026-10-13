import type { GmailHeader, GmailMessagePart } from "@/lib/admin/google/gmail/types";

/**
 * Reading a Gmail `format=full` payload: the MessagePart tree Google returns,
 * with every leaf's bytes already transfer-decoded and then base64url encoded.
 * Plan: docs/plans/google-integration.md section 7.1 (Open). The build side
 * (send and reply) comes with phase 7.
 */

/** base64url (Gmail's `body.data`) to bytes. Padding is optional. */
export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64url"));
}

/** Bytes to text in the part's charset; an unknown label falls back to UTF-8. */
export function decodeText(bytes: Uint8Array, charset: string | null): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // RangeError: not a WHATWG encoding label.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

/** A header parameter such as `charset` in `text/plain; charset="iso-8859-1"`. */
export function headerParam(value: string | null, param: string): string | null {
  if (!value) return null;
  const re = new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i");
  const m = value.match(re);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`). Gmail
 * usually hands headers back decoded; this covers the ones it doesn't.
 * Whitespace between two adjacent encoded words is dropped, per 6.2.
 */
export function decodeEncodedWords(value: string): string {
  const word = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  const joined = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1");
  return joined.replace(word, (whole, charset: string, enc: string, text: string) => {
    let bytes: Uint8Array;
    if (enc.toUpperCase() === "B") {
      bytes = new Uint8Array(Buffer.from(text, "base64"));
    } else {
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "_") out.push(0x20);
        else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          out.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else out.push(c.charCodeAt(0));
      }
      bytes = new Uint8Array(out);
    }
    try {
      return new TextDecoder(charset.split("*")[0]).decode(bytes);
    } catch {
      return whole;
    }
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** Gmail's `snippet` is HTML-escaped text. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

export interface ParsedAddress {
  name: string;
  email: string;
}

/** Split an address list on the commas that sit outside quotes and angle brackets. */
export function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const c of value) {
    if (c === '"') quoted = !quoted;
    else if (c === "<" && !quoted) angle = true;
    else if (c === ">" && !quoted) angle = false;
    if (c === "," && !quoted && !angle) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** `"Doe, Jane" <jane@x.com>` to { name: "Doe, Jane", email }. A bare address names itself. */
export function parseAddress(value: string): ParsedAddress {
  const decoded = decodeEncodedWords(value).trim();
  const m = decoded.match(/^(.*?)\s*<([^>]*)>\s*$/);
  if (!m) return { name: decoded, email: decoded };
  const email = m[2].trim();
  const name = m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
  return { name: name || email, email };
}

export interface ParsedAttachmentPart {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface InlinePart {
  partId: string;
  contentId: string;
  mimeType: string;
  /** Present when Google sent the bytes inline; otherwise fetch by attachmentId. */
  data: string | null;
  attachmentId: string | null;
}

export interface ParsedMessage {
  html: string | null;
  text: string | null;
  attachments: ParsedAttachmentPart[];
  /** cid: images the HTML references. */
  inline: InlinePart[];
}

function leafText(part: GmailMessagePart): string | null {
  const data = part.body?.data;
  if (!data) return null;
  const charset = headerParam(headerValue(part.headers, "Content-Type"), "charset");
  return decodeText(decodeBase64Url(data), charset);
}

/**
 * Walk the tree. The body is the first text/html leaf, else the first
 * text/plain one, that isn't itself an attachment. An image with a Content-ID
 * is inline when the HTML points at it, else it is listed as an attachment.
 */
export function parseMessagePayload(payload: GmailMessagePart | undefined): ParsedMessage {
  let html: string | null = null;
  let text: string | null = null;
  const attachments: ParsedAttachmentPart[] = [];
  const cidImages: InlinePart[] = [];
  const cidAsAttachment = new Map<string, ParsedAttachmentPart>();

  const visit = (part: GmailMessagePart) => {
    if (part.mimeType.toLowerCase().startsWith("multipart/")) {
      for (const child of part.parts ?? []) visit(child);
      return;
    }
    const mimeType = part.mimeType.toLowerCase();
    const disposition = headerValue(part.headers, "Content-Disposition")?.split(";")[0].trim().toLowerCase() ?? null;
    const filename = part.filename ? decodeEncodedWords(part.filename) : "";
    const contentId = headerValue(part.headers, "Content-ID")?.trim().replace(/^<(.*)>$/, "$1") ?? null;
    const partId = part.partId ?? "";
    const asAttachment: ParsedAttachmentPart = {
      partId,
      filename: filename || "attachment",
      mimeType,
      size: part.body?.size ?? 0,
    };

    if (contentId && disposition !== "attachment" && mimeType.startsWith("image/")) {
      cidImages.push({
        partId,
        contentId,
        mimeType,
        data: part.body?.data ?? null,
        attachmentId: part.body?.attachmentId ?? null,
      });
      cidAsAttachment.set(contentId, asAttachment);
      return;
    }
    if (filename || disposition === "attachment") {
      attachments.push(asAttachment);
      return;
    }
    if (mimeType === "text/html" && html === null) {
      html = leafText(part);
      return;
    }
    if (mimeType === "text/plain" && text === null) {
      text = leafText(part);
      return;
    }
    if (part.body?.attachmentId) attachments.push(asAttachment);
  };
  if (payload) visit(payload);

  // Assigned inside `visit`, which TypeScript does not follow; widen it back.
  const body = html as string | null;
  const inline: InlinePart[] = [];
  for (const img of cidImages) {
    if (body !== null && body.includes(`cid:${img.contentId}`)) inline.push(img);
    else attachments.push(cidAsAttachment.get(img.contentId)!);
  }
  return { html, text, attachments, inline };
}

/** Swap each `cid:<id>` the map knows for its data URL; unknown ones stay (and load nothing). */
export function inlineCidImages(html: string, dataUrls: Map<string, string>): string {
  return html.replace(/cid:([^"'\s)>]+)/gi, (whole, id: string) => dataUrls.get(id) ?? whole);
}

export function findPart(payload: GmailMessagePart | undefined, partId: string): GmailMessagePart | null {
  if (!payload) return null;
  if ((payload.partId ?? "") === partId) return payload;
  for (const child of payload.parts ?? []) {
    const hit = findPart(child, partId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Types the browser may show on our own origin (`?view=1`): ones that cannot
 * run script in this page. HTML and SVG are deliberately absent; they
 * always download.
 */
export const VIEWABLE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv"] as const;

export function isViewable(mimeType: string): boolean {
  return (VIEWABLE_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

/** RFC 6266: an ASCII fallback plus the exact UTF-8 name (RFC 5987). */
export function contentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
