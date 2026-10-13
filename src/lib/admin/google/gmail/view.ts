import type { GmailThreadSummary } from "@/lib/admin/google/gmail/types";

/**
 * Browser-side helpers for /admin/email: folding a refreshed first page into
 * the loaded list, and the document an HTML email renders in.
 */

/**
 * Gmail lists threads newest activity first. A refresh fetches page one again:
 * its rows lead, and an older loaded row is kept only when it is older than
 * the oldest fresh row (anything newer that is missing has left the folder).
 */
export function mergeRefreshedPage(fresh: GmailThreadSummary[], loaded: GmailThreadSummary[]): GmailThreadSummary[] {
  if (fresh.length === 0) return [];
  const ids = new Set(fresh.map((t) => t.id));
  const oldest = Math.min(...fresh.map((t) => t.lastMessageAt));
  return [...fresh, ...loaded.filter((t) => !ids.has(t.id) && t.lastMessageAt < oldest)];
}

/**
 * Where a reply's quoted history starts: Gmail's and Apple Mail's quote
 * containers (removed with everything inside them), and Outlook's reply
 * header (everything from there on is the quoted message).
 */
const QUOTE_BLOCKS = [/<div\b[^>]*\bclass="[^"]*\bgmail_quote\b[^"]*"[^>]*>/i, /<blockquote\b[^>]*\btype="cite"[^>]*>/i];
const QUOTE_TAILS = [/<div\b[^>]*\bid="divRplyFwdMsg"[^>]*>/i, /<div\b[^>]*\bid="appendonsend"[^>]*>/i];

/** The index just past the close tag that balances the open tag at `start`. */
function closeOf(html: string, start: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length;
}

/**
 * The email without the earlier messages it quotes, or null when it quotes
 * nothing. The thread already shows those messages, so a reply reads as what
 * was actually written; "Show quoted text" brings the rest back.
 */
export function stripQuotedHtml(html: string): string | null {
  let out = html;
  let cut = false;
  for (;;) {
    let at = -1;
    let tag = "";
    for (const re of QUOTE_BLOCKS) {
      const m = re.exec(out);
      if (m && (at < 0 || m.index < at)) {
        at = m.index;
        tag = m[0].startsWith("<div") ? "div" : "blockquote";
      }
    }
    if (at < 0) break;
    out = out.slice(0, at) + out.slice(closeOf(out, at, tag));
    cut = true;
  }
  for (const re of QUOTE_TAILS) {
    const m = re.exec(out);
    if (m) {
      out = out.slice(0, m.index);
      cut = true;
    }
  }
  return cut ? out : null;
}

/** Plain text: from the "On ... wrote:" line, or the first "> " line, to the end. */
export function stripQuotedText(text: string): string | null {
  const m = /(^|\n)\s*(On .{0,200}wrote:\s*$|>)/m.exec(text);
  if (!m) return null;
  return text.slice(0, m.index).trimEnd();
}

/** Whether the email loads anything from the network (an http(s) image or stylesheet URL). */
export function hasRemoteContent(html: string): boolean {
  return /(?:src|background|srcset)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html) || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(html);
}

/**
 * The frame's whole document. The email's own `<meta>` (a refresh would
 * navigate the frame), `<base>`, `<link>` and `<script>` tags are dropped, and
 * a CSP blocks every network load except, after the click, images and
 * stylesheets. Links open in a new tab with no opener; the email's own `rel`
 * comes second, and the parser keeps the first.
 */
export function emailDocument(html: string, allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  const csp = `default-src 'none'; img-src data:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}`;
  const body = html
    .replace(/<\s*(meta|base|link)\b[^>]*>/gi, "")
    .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*script\b[^>]*>/gi, "")
    .replace(/<a\b/gi, '<a rel="noopener noreferrer" target="_blank"');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;background:#fff;color:#111;font:14px/1.5 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere;overflow:hidden}body{padding:2px 0}img{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}
