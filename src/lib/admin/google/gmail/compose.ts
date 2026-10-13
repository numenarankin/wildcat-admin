import { contentDisposition, decodeHtmlEntities, parseAddress, splitAddresses } from "@/lib/admin/google/gmail/mime";
import { styleEmailHtml, type EmailSettings } from "@/lib/admin/google/gmail/email-style";

/**
 * A new email, built as RFC 2822 for Gmail's `messages.send` (plan section
 * 7.1). Pure, so the exact bytes Gmail receives are tested.
 *
 * No From header: Gmail stamps the connected account's own address. The
 * body is the composer's HTML, sent as multipart/alternative with a plain
 * text copy for clients that don't render HTML.
 */

export interface ComposeInput {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** The composer's HTML. */
  html: string;
}

export interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

/** Most recipients one message may carry, across To, Cc and Bcc. */
export const MAX_RECIPIENTS = 100;
/** Largest body the composer may send (Gmail's own cap is far above this). */
export const MAX_HTML_CHARS = 1_000_000;

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

/**
 * One address field, split and checked. Commas, semicolons and line breaks
 * all separate; each entry is `name <a@b.c>` or a bare `a@b.c`. Returns the
 * entries as typed, or the first one that is not an address.
 */
export function parseRecipients(field: string): { ok: true; list: string[] } | { ok: false; bad: string } {
  const list: string[] = [];
  for (const raw of splitAddresses(field.replace(/[;\r\n]+/g, ","))) {
    const { email } = parseAddress(raw);
    if (!EMAIL.test(email)) return { ok: false, bad: raw };
    list.push(raw);
  }
  return { ok: true, list };
}

/** RFC 2047: a header value with non-ASCII as UTF-8 encoded-words, else as is. */
export function encodeHeader(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  // Each encoded-word at most 75 chars: 12 of wrapper leaves 63 base64 chars,
  // so 45 bytes of UTF-8, cut only between whole characters.
  const words: string[] = [];
  let chunk = "";
  for (const ch of flat) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** An address list header: display names encoded, addresses left bare. */
function addressHeader(list: string[]): string {
  return list
    .map((raw) => {
      const { name, email } = parseAddress(raw);
      return name && name !== email ? `${encodeHeader(name.replace(/"/g, ""))} <${email}>` : email;
    })
    .join(", ");
}

/** The composer's HTML as plain text: blocks become lines, links keep their URL. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const inner = label.replace(/<[^>]+>/g, "");
      return inner && inner !== href ? `${inner} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<(ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(text)
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Base64 in 76-character lines (RFC 2045). */
function base64Lines(text: string): string {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Gmail's own limit on an outgoing message. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A header value that must be a bare `<id>` list, never a header injection. */
function idHeader(value: string | null | undefined): string | null {
  const flat = (value ?? "").replace(/[\r\n]+/g, " ").trim();
  return flat && /^<[^<>\s]+>(\s+<[^<>\s]+>)*$/.test(flat) ? flat : null;
}

/**
 * The full RFC 2822 message. `boundary` is passed in so tests are exact.
 * A reply carries In-Reply-To and References so every client threads it;
 * a forward carries the original's attachments as multipart/mixed.
 */
export function buildMessage(
  input: {
    recipients: Recipients;
    subject: string;
    html: string;
    style?: Pick<EmailSettings, "fontFamily" | "fontSize">;
    inReplyTo?: string | null;
    references?: string | null;
    attachments?: OutgoingAttachment[];
  },
  boundary: string
): string {
  const { recipients } = input;
  const inReplyTo = idHeader(input.inReplyTo);
  const references = idHeader(input.references);
  const attachments = input.attachments ?? [];
  const mixed = `${boundary}m`;
  const headers = [
    `To: ${addressHeader(recipients.to)}`,
    ...(recipients.cc.length ? [`Cc: ${addressHeader(recipients.cc)}`] : []),
    ...(recipients.bcc.length ? [`Bcc: ${addressHeader(recipients.bcc)}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0",
    attachments.length
      ? `Content-Type: multipart/mixed; boundary="${mixed}"`
      : `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", base64Lines(body)].join("\r\n");
  const alternative = [
    part("text/plain", htmlToText(input.html)),
    part("text/html", input.style ? styleEmailHtml(input.html, input.style) : `<div dir="ltr">${input.html}</div>`),
    `--${boundary}--`,
  ];
  if (!attachments.length) return [...headers, "", ...alternative, ""].join("\r\n");
  const file = (a: OutgoingAttachment) => {
    const ascii = a.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
    return [
      `--${mixed}`,
      `Content-Type: ${a.mimeType}; name="${ascii}"`,
      `Content-Disposition: ${contentDisposition(a.filename)}`,
      "Content-Transfer-Encoding: base64",
      "",
      (Buffer.from(a.bytes).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
    ].join("\r\n");
  };
  return [
    ...headers,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    ...alternative,
    ...attachments.map(file),
    `--${mixed}--`,
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------- quoting

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `Oct 8, 2026 at 10:34 AM`, the date in a quote header. */
export function quoteDate(epochMs: number, timeZone = "America/Chicago"): string {
  const d = new Date(epochMs);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return `${day} at ${time}`;
}

/**
 * An email's HTML as something that can sit inside another email: the
 * document wrapper, scripts and styles sheets gone; plain text escaped.
 */
export function quotable(html: string | null, text: string | null): string {
  if (html !== null) {
    return html
      .replace(/<!doctype[^>]*>/gi, "")
      .replace(/<\/?(html|body)\b[^>]*>/gi, "")
      .replace(/<head\b[\s\S]*?<\/head\s*>/gi, "")
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
      // Inline images were rewritten to this app's attachment route for the
      // reading pane; a recipient cannot load those, so they go.
      .replace(/<img\b[^>]*\bsrc="\/api\/[^"]*"[^>]*>/gi, "")
      .trim();
  }
  return `<div>${escapeHtml(text ?? "").split(/\r?\n/).join("<br>")}</div>`;
}

export interface QuotedMessage {
  fromName: string;
  fromEmail: string;
  date: number;
  subject: string;
  to: string;
  html: string | null;
  text: string | null;
}

/** Gmail's reply quote: "On … wrote:" then the message in a bar-left blockquote. */
export function replyQuote(m: QuotedMessage): string {
  const who = m.fromName && m.fromName !== m.fromEmail ? `${escapeHtml(m.fromName)} &lt;${escapeHtml(m.fromEmail)}&gt;` : escapeHtml(m.fromEmail);
  return (
    `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On ${quoteDate(m.date)} ${who} wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quotable(m.html, m.text)}</blockquote></div>`
  );
}

/** Gmail's forward block: the header lines, then the message as it was. */
export function forwardQuote(m: QuotedMessage): string {
  const who = m.fromName && m.fromName !== m.fromEmail ? `<b>${escapeHtml(m.fromName)}</b> &lt;${escapeHtml(m.fromEmail)}&gt;` : escapeHtml(m.fromEmail);
  return (
    `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>` +
    `From: ${who}<br>Date: ${quoteDate(m.date)}<br>Subject: ${escapeHtml(m.subject)}<br>To: ${escapeHtml(m.to)}<br></div><br><br>` +
    `${quotable(m.html, m.text)}</div>`
  );
}

/** `Re: x` / `Fwd: x`, without stacking prefixes. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}
export function forwardSubject(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`;
}

/**
 * Reply all: everyone on the message except the account itself. The sender
 * (Reply-To if set) goes in To; the other recipients in Cc.
 */
export function replyAllRecipients(
  m: { replyTo: string; fromEmail: string; toAddresses: string[]; ccAddresses: string[] },
  self: string
): { to: string; cc: string } {
  const me = self.toLowerCase();
  const email = (raw: string) => parseAddress(raw).email.toLowerCase();
  const seen = new Set<string>([me, email(m.replyTo)]);
  const others = [...m.toAddresses, ...m.ccAddresses].filter((a) => {
    const e = email(a);
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  return { to: m.replyTo, cc: others.join(", ") };
}

/** Gmail's `raw`: the message in base64url. */
export function toRaw(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}

/**
 * Check a compose form. Returns the recipients, or the one thing to fix,
 * worded for the person who typed it.
 */
export function validateCompose(input: ComposeInput): { ok: true; recipients: Recipients } | { ok: false; error: string } {
  const fields = { to: input.to, cc: input.cc, bcc: input.bcc } as const;
  const recipients: Recipients = { to: [], cc: [], bcc: [] };
  for (const key of ["to", "cc", "bcc"] as const) {
    const parsed = parseRecipients(String(fields[key] ?? ""));
    if (!parsed.ok) return { ok: false, error: `"${parsed.bad}" isn't an email address.` };
    recipients[key] = parsed.list;
  }
  const total = recipients.to.length + recipients.cc.length + recipients.bcc.length;
  if (total === 0) return { ok: false, error: "Add at least one recipient." };
  if (total > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` };
  if (typeof input.html !== "string" || input.html.length > MAX_HTML_CHARS) return { ok: false, error: "The message is too long." };
  return { ok: true, recipients };
}
