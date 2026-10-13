/**
 * The admin's email look: the default font for mail they send, and their
 * signature. Keys, not CSS, are stored (`admin_email_settings`), so nothing a
 * request carries ever becomes a style string unchecked.
 *
 * Gmail's own font menu and sizes, so a message reads the same as one sent
 * from Gmail.
 */

export const EMAIL_FONTS = [
  { id: "sans", label: "Sans Serif", css: "Arial, Helvetica, sans-serif" },
  { id: "serif", label: "Serif", css: '"Times New Roman", Times, serif' },
  { id: "fixed", label: "Fixed Width", css: '"Courier New", Courier, monospace' },
  { id: "wide", label: "Wide", css: '"Arial Black", Arial, sans-serif' },
  { id: "narrow", label: "Narrow", css: '"Arial Narrow", Arial, sans-serif' },
  { id: "comic", label: "Comic Sans MS", css: '"Comic Sans MS", "Comic Sans", cursive' },
  { id: "garamond", label: "Garamond", css: 'Garamond, "Times New Roman", serif' },
  { id: "georgia", label: "Georgia", css: "Georgia, serif" },
  { id: "tahoma", label: "Tahoma", css: "Tahoma, Verdana, sans-serif" },
  { id: "trebuchet", label: "Trebuchet MS", css: '"Trebuchet MS", Arial, sans-serif' },
  { id: "verdana", label: "Verdana", css: "Verdana, Geneva, sans-serif" },
] as const;

export const EMAIL_SIZES = [
  { id: "small", label: "Small", px: 10 },
  { id: "normal", label: "Normal", px: 13 },
  { id: "large", label: "Large", px: 18 },
  { id: "huge", label: "Huge", px: 32 },
] as const;

export type EmailFontId = (typeof EMAIL_FONTS)[number]["id"];
export type EmailSizeId = (typeof EMAIL_SIZES)[number]["id"];

export interface EmailSettings {
  fontFamily: EmailFontId;
  fontSize: EmailSizeId;
  /** The signature editor's HTML; "" for none. */
  signatureHtml: string;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = { fontFamily: "sans", fontSize: "normal", signatureHtml: "" };

export const SIGNATURE_MAX = 20_000;

export const isEmailFont = (v: unknown): v is EmailFontId => EMAIL_FONTS.some((f) => f.id === v);
export const isEmailSize = (v: unknown): v is EmailSizeId => EMAIL_SIZES.some((s) => s.id === v);

export const fontCss = (id: EmailFontId) => EMAIL_FONTS.find((f) => f.id === id)!.css;
export const sizePx = (id: EmailSizeId) => EMAIL_SIZES.find((s) => s.id === id)!.px;

/**
 * The body as sent: wrapped in the admin's default font and size, with
 * paragraphs tight and empty lines kept, as the composer shows them (mail
 * clients give a bare <p> a blank line of margin and an empty one no height).
 */
export function styleEmailHtml(html: string, settings: Pick<EmailSettings, "fontFamily" | "fontSize">): string {
  const font = fontCss(settings.fontFamily).replace(/"/g, "&quot;");
  const body = html
    .replace(/<p><\/p>/g, "<p><br></p>")
    .replace(/<p>/g, '<p style="margin:0">');
  // Links carry no colour of their own: every client styles a link in its
  // default blue, and styles the phone numbers and addresses it auto-links
  // the same way, so leaving them alone is what makes the two match.
  return `<div dir="ltr" style="font-family:${font};font-size:${sizePx(settings.fontSize)}px">${body}</div>`;
}

/**
 * A stored signature, defanged. The editor only ever produces clean HTML;
 * this is for a request that skipped the editor. Scripts, styles sheets,
 * frames, event handlers and javascript: URLs go.
 */
export function cleanSignature(html: string): string {
  return html
    .slice(0, SIGNATURE_MAX)
    .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|form|meta|link|base)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*(javascript|data|vbscript):[^"'\s>]*\2/gi, '$1="#"');
}

/** Whether the editor's HTML has any text or link in it. */
export function hasContent(html: string): boolean {
  return /<a\b|[^\s]/.test(html.replace(/<(?!a\b)[^>]+>/g, "").replace(/&nbsp;/g, " "));
}

/**
 * A message's starting body. New: two empty lines to type on, then the
 * signature. A draft: its body, a blank line, then the signature.
 */
export function composeSeed(signatureHtml: string, body = ""): string {
  const sig = hasContent(signatureHtml) ? signatureHtml : "";
  if (!body) return `<p></p><p></p>${sig}`;
  return `${body}${sig ? `<p></p>${sig}` : ""}`;
}
