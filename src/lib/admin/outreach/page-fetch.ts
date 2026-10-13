/**
 * Reading a company's web page for the Enrich chat: the page as text, plus
 * the addresses and phone numbers written on it. Pure helpers (tested) over
 * one polite fetch: a real User-Agent, a timeout, a size cap, no retries,
 * and robots.txt honoured for the path.
 */

const UA = "Mozilla/5.0 (compatible; WildcatIQ-Enrich/1.0; +https://wildcatiq.ai)";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 400_000;
/** Enough to read a contact page; keeps the model's context sane. */
export const MAX_TEXT_CHARS = 12_000;

export interface PageRead {
  url: string;
  title: string;
  text: string;
  emails: string[];
  phones: string[];
  /** Same-site links whose text or path suggests people or contact details. */
  contactLinks: string[];
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/** Markup to readable text: block tags become line breaks, the rest is dropped. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** US numbers as people write them: (432) 555-0100, 432-555-0100, 432.555.0100, +1 432 555 0100. */
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/** `(432) 555-0100` from any of the written forms; null when not ten digits. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Emails and phones on a page: mailto/tel links first, then the text. */
export function extractContacts(html: string, text: string): { emails: string[]; phones: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) {
    const e = decodeEntities(m[1]).trim().toLowerCase();
    if (EMAIL_RE.test(e)) emails.add(e);
    EMAIL_RE.lastIndex = 0;
  }
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)/gi)) {
    const p = normalizePhone(decodeURIComponent(m[1]));
    if (p) phones.add(p);
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    // An image or script name that happens to look like an address.
    if (/\.(png|jpg|jpeg|gif|svg|webp|js|css)$/i.test(e)) continue;
    emails.add(e);
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const p = normalizePhone(m[0]);
    if (p) phones.add(p);
  }
  return { emails: [...emails], phones: [...phones] };
}

const CONTACT_WORDS = /contact|about|team|staff|leadership|people|management|our-?company|who-?we-?are|officers/i;

/** Links on the page worth following for people: same site, contact-ish, deduplicated. */
export function contactLinks(html: string, pageUrl: string): string[] {
  const base = new URL(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]).trim();
    const label = htmlToText(m[2]);
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.host !== base.host) continue;
    if (!/^https?:$/.test(url.protocol)) continue;
    if (!CONTACT_WORDS.test(url.pathname) && !CONTACT_WORDS.test(label)) continue;
    url.hash = "";
    out.add(url.toString());
    if (out.size >= 10) break;
  }
  return [...out];
}

/** Whether robots.txt lets a generic crawler read the path. Absent or unreadable = allowed. */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  let applies = false;
  let allowed = true;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    switch (field.trim().toLowerCase()) {
      case "user-agent":
        applies = value === "*";
        break;
      case "disallow":
        if (applies && value && path.startsWith(value)) allowed = false;
        break;
      case "allow":
        if (applies && value && path.startsWith(value)) allowed = true;
        break;
    }
  }
  return allowed;
}

/** One page, read politely. Throws with a plain message the tool can relay. */
export async function readPage(url: string): Promise<PageRead> {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error("Only http(s) pages can be read.");
  try {
    const robots = await fetch(new URL("/robots.txt", target), {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(5_000),
    });
    if (robots.ok && !robotsAllows(await robots.text(), target.pathname)) {
      throw new Error("The site's robots.txt does not allow reading that page.");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("robots.txt")) throw err;
    // No robots.txt, or unreachable: proceed.
  }
  const res = await fetch(target, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The page answered ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  if (!/html|xml|text\/plain/i.test(type)) throw new Error(`Not a web page (${type || "unknown type"}).`);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder().decode(buf.slice(0, MAX_BYTES));
  const text = htmlToText(html);
  const { emails, phones } = extractContacts(html, text);
  return {
    url: res.url || url,
    title: pageTitle(html),
    text: text.slice(0, MAX_TEXT_CHARS),
    emails,
    phones,
    contactLinks: contactLinks(html, res.url || url),
  };
}
