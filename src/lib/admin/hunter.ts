import "server-only";
import type { Verification } from "@/lib/admin/outreach/types";

/**
 * Hunter (hunter.io) for the Enrich chat: every address Hunter has seen for a
 * domain, the likely address for a named person, and whether an address
 * delivers. One key, `HUNTER_API_KEY`. The parsers are pure and tested
 * against Hunter's documented v2 shapes; the fetches are thin.
 */

const HUNTER_BASE = "https://api.hunter.io/v2";
const TIMEOUT_MS = 20_000;

export interface HunterEmail {
  email: string;
  /** personal | generic */
  type: string;
  /** 0..100 */
  confidence: number;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  /** Pages Hunter saw the address on. */
  sources: string[];
}

export interface HunterDomain {
  domain: string;
  organization: string | null;
  /** `{first}.{last}` and the like; null when Hunter has not inferred one. */
  pattern: string | null;
  emails: HunterEmail[];
}

export interface HunterFinder {
  email: string | null;
  /** 0..100 */
  score: number | null;
  position: string | null;
}

export interface HunterVerdict {
  email: string;
  verification: Verification;
  /** Hunter's own word: valid | invalid | accept_all | webmail | disposable | unknown */
  status: string;
  score: number | null;
}

export function hasHunter(): boolean {
  return Boolean(process.env.HUNTER_API_KEY);
}

function key(): string {
  const k = process.env.HUNTER_API_KEY;
  if (!k) throw new Error("Hunter is not configured: set HUNTER_API_KEY.");
  return k;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseDomainSearch(json: unknown): HunterDomain {
  const data = ((json as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
  const emails = Array.isArray(data.emails) ? data.emails : [];
  return {
    domain: str(data.domain) ?? "",
    organization: str(data.organization),
    pattern: str(data.pattern),
    emails: emails
      .map((e) => {
        const o = (e ?? {}) as Record<string, unknown>;
        const email = str(o.value);
        if (!email) return null;
        const sources = Array.isArray(o.sources)
          ? o.sources.map((s) => str((s as Record<string, unknown>)?.uri)).filter((s): s is string => s !== null)
          : [];
        return {
          email,
          type: str(o.type) ?? "personal",
          confidence: num(o.confidence) ?? 0,
          firstName: str(o.first_name),
          lastName: str(o.last_name),
          position: str(o.position),
          sources,
        };
      })
      .filter((e): e is HunterEmail => e !== null),
  };
}

export function parseEmailFinder(json: unknown): HunterFinder {
  const data = ((json as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
  return { email: str(data.email), score: num(data.score), position: str(data.position) };
}

/** Hunter's `result` is the verdict; `status` is the reason behind it. */
export function parseVerifier(json: unknown, email: string): HunterVerdict {
  const data = ((json as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
  const result = str(data.result);
  const verification: Verification =
    result === "deliverable" || result === "undeliverable" || result === "risky" ? result : "unknown";
  return { email: str(data.email) ?? email, verification, status: str(data.status) ?? "unknown", score: num(data.score) };
}

async function hunterGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${HUNTER_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("api_key", key());
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  // Hunter answers 404 for "nothing known" on finder and domain search; that
  // is an empty answer, not a failure.
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Hunter ${path} failed (${res.status}).`);
  return res.json();
}

export async function hunterDomainSearch(domain: string): Promise<HunterDomain> {
  return parseDomainSearch(await hunterGet("/domain-search", { domain, limit: "25" }));
}

export async function hunterEmailFinder(domain: string, firstName: string, lastName: string): Promise<HunterFinder> {
  return parseEmailFinder(await hunterGet("/email-finder", { domain, first_name: firstName, last_name: lastName }));
}

export async function hunterVerify(email: string): Promise<HunterVerdict> {
  return parseVerifier(await hunterGet("/email-verifier", { email }), email);
}
