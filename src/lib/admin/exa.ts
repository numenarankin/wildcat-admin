import "server-only";

/**
 * Exa (exa.ai): web search and page contents for the Enrich chat. One key,
 * `EXA_API_KEY`; absent, the tools say so and the rest of the page works.
 *
 * Request shapes follow Exa's own `build-with-exa` skill
 * (`.agents/skills/build-with-exa`): a search is the query, the agent's
 * objective, `type: "auto"` and `contents: { highlights: true }`, nothing
 * else; a contents read puts `text` at the top level and reads `statuses`,
 * since a 200 can still carry a failed URL. The parsers are pure and tested.
 */

const EXA_BASE = "https://api.exa.ai";
const TIMEOUT_MS = 30_000;

export interface ExaResult {
  title: string;
  url: string;
  /** The page's highlights (search) or its text (contents); empty when none came back. */
  text: string;
  publishedDate: string | null;
}

export function hasExa(): boolean {
  return Boolean(process.env.EXA_API_KEY);
}

function key(): string {
  const k = process.env.EXA_API_KEY;
  if (!k) throw new Error("Exa is not configured: set EXA_API_KEY.");
  return k;
}

/** The results of a search or contents response, highlights joined into `text`. */
export function parseExaResults(json: unknown): ExaResult[] {
  const results = (json as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : "";
      if (!url) return null;
      const highlights = Array.isArray(o.highlights) ? o.highlights.filter((h): h is string => typeof h === "string") : [];
      return {
        title: typeof o.title === "string" ? o.title : url,
        url,
        text: highlights.length ? highlights.join("\n") : typeof o.text === "string" ? o.text : "",
        publishedDate: typeof o.publishedDate === "string" ? o.publishedDate : null,
      };
    })
    .filter((r): r is ExaResult => r !== null);
}

/** URLs a contents response could not read, from its `statuses`. */
export function parseExaFailures(json: unknown): { url: string; error: string }[] {
  const statuses = (json as { statuses?: unknown[] } | null)?.statuses;
  if (!Array.isArray(statuses)) return [];
  return statuses
    .map((s) => (s ?? {}) as Record<string, unknown>)
    .filter((s) => s.status !== "success" && typeof s.id === "string")
    .map((s) => ({
      url: s.id as string,
      error: typeof s.error === "object" && s.error && typeof (s.error as { tag?: unknown }).tag === "string"
        ? ((s.error as { tag: string }).tag)
        : String(s.status ?? "error"),
    }));
}

async function exaPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${EXA_BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Exa ${path} failed (${res.status}).`);
  return res.json();
}

/**
 * A web search. `objective` is the agent's goal for this turn (what should
 * rank first, what to skip, what to pull), forwarded as Exa recommends.
 */
export async function exaSearch(query: string, objective?: string): Promise<ExaResult[]> {
  const json = await exaPost("/search", {
    query,
    ...(objective ? { objective } : {}),
    type: "auto",
    contents: { highlights: true },
  });
  return parseExaResults(json);
}

/**
 * The text of given pages, rendered by Exa (JavaScript sites included), cut
 * to a budget the chat's context can carry.
 */
export async function exaContents(
  urls: string[],
  textChars = 12_000
): Promise<{ results: ExaResult[]; failed: { url: string; error: string }[] }> {
  if (urls.length === 0) return { results: [], failed: [] };
  const json = await exaPost("/contents", {
    urls: urls.slice(0, 10),
    text: { maxCharacters: textChars },
  });
  return { results: parseExaResults(json), failed: parseExaFailures(json) };
}
