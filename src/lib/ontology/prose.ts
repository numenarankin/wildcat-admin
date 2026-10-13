import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { searchDocuments, type DocFilters } from "@/lib/ai/retrieval";
import { formatHandle, type EntityType, type Handle } from "./handles";

/**
 * The unstructured half: what people WROTE, as opposed to what they measured.
 *
 * `search_documents` covers uploaded files and nothing else, because
 * `document_chunks` is only ever written by `embedFile`. Everything a person
 * typed into the app — the /notes page, every comment table, the reason on a
 * downtime event, the note on a service job — has been invisible to Orion
 * entirely. That is most of the operational memory of the business.
 *
 * ## Why this reads the tables live rather than indexing them
 *
 * Entity-scoped retrieval through `document_chunks` would want `embedFile`
 * widened, its unused `well_id` / `source_type` columns populated, a backfill,
 * and a change to the `match_document_chunks` function. The last of those is a
 * migration, and the schema is not ours to change here. These tables are small
 * (an org's whole comment history is thousands of rows, not millions), so
 * reading and matching them in the application is both accurate and cheap, and
 * it needs nothing from the database.
 *
 * Files keep going through `searchDocuments`, which is already good at them.
 */

type Sb = SupabaseClient;

export interface ProseEntry {
  /** Which table it came from, in words the model can quote. */
  source: string;
  /** The entity it hangs off, when it hangs off one. */
  handle: string | null;
  entityName?: string;
  /** ISO date, for ordering and for citation. */
  date: string | null;
  author: string | null;
  text: string;
}

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Join the parts of a row that carry prose, dropping the empty ones. */
function joined(...parts: unknown[]): string {
  return parts.map(clean).filter(Boolean).join(" — ");
}

type Row = Record<string, unknown>;

/**
 * The slice of the PostgREST builder these readers use.
 *
 * Structural rather than the real generic type: the full one instantiates
 * several layers deep per call and the compiler gives up on it, and none of that
 * inference buys anything when every column comes back as `unknown` anyway.
 */
interface Filterable {
  eq(column: string, value: unknown): Filterable;
  is(column: string, value: unknown): Filterable;
}

async function rows(
  sb: Sb,
  table: string,
  select: string,
  apply: (q: Filterable) => Filterable
): Promise<Row[]> {
  const query = apply(sb.from(table).select(select) as unknown as Filterable);
  const { data, error } = (await (query as unknown as Promise<{
    data: Row[] | null;
    error: unknown;
  }>));
  // A missing table or a policy denial must not take the whole answer down; the
  // caller gets what the other sources returned and the absence is invisible
  // rather than fatal. Every source here is additive.
  if (error) return [];
  return data ?? [];
}

/* ------------------------------------------------------------------ *
 * Per-entity prose
 * ------------------------------------------------------------------ */

/**
 * Everything written about one entity, newest first.
 *
 * Retrieval by traversal rather than by query: this is "catch me up on this
 * well", which no search term expresses.
 */
export async function fieldNotes(
  sb: Sb,
  handle: Handle,
  limit = 50
): Promise<ProseEntry[]> {
  const self = formatHandle(handle.type, handle.id);
  const isWell = handle.type === "well";
  const commentTable =
    handle.type === "tank" ? "tank_comments" : handle.type === "meter" ? "meter_comments" : null;
  const commentColumn = handle.type === "tank" ? "tank_id" : "meter_id";

  /*
   * Every source at once.
   *
   * These were eight sequential awaits, which is eight round trips stacked end
   * to end for one entity — and the gather stage calls this alongside seven other
   * tools. None of them depends on another, so the wall clock is the SLOWEST
   * query rather than their sum.
   */
  const [tagged, comments, services, events, shots, tests, facility] = await Promise.all([
    rows(
      sb,
      "note_tags",
      "target_type, target_id, notes(id, title, content, author_name, created_at, deleted_at)",
      (q) => q.eq("target_type", tagType(handle.type)).eq("target_id", handle.id)
    ),
    isWell
      ? rows(sb, "well_comments", "body, author_name, created_at", (q) =>
          q.eq("well_id", handle.id)
        )
      : commentTable
        ? rows(sb, commentTable, "body, author_name, created_at", (q) =>
            q.eq(commentColumn, handle.id)
          )
        : Promise.resolve([] as Row[]),
    isWell
      ? rows(sb, "well_service", "job, vendor, notes, date, created_at", (q) =>
          q.eq("well_id", handle.id)
        )
      : Promise.resolve([] as Row[]),
    isWell
      ? rows(
          sb,
          "well_events",
          "event_type, reason, comments, start_date, end_date, created_at",
          (q) => q.eq("well_id", handle.id)
        )
      : Promise.resolve([] as Row[]),
    isWell
      ? rows(sb, "well_shots", "notes, fluid_level_ft, shot_date", (q) =>
          q.eq("well_id", handle.id)
        )
      : Promise.resolve([] as Row[]),
    isWell
      ? rows(sb, "well_tests", "notes, test_date", (q) => q.eq("well_id", handle.id))
      : Promise.resolve([] as Row[]),
    rows(sb, "facility_comments", "body, author_name, created_at, deleted_at", (q) =>
      q.eq("entity_type", handle.type).eq("entity_id", handle.id)
    ),
  ]);

  const out: ProseEntry[] = [];

  for (const t of tagged) {
    const note = t.notes as Row | null;
    if (!note || note.deleted_at) continue;
    out.push({
      source: "note",
      handle: self,
      date: isoDate(note.created_at),
      author: clean(note.author_name) || null,
      text: joined(note.title, note.content),
    });
  }

  for (const c of comments) {
    out.push({
      source: isWell ? "well comment" : `${handle.type} comment`,
      handle: self,
      date: isoDate(c.created_at),
      author: clean(c.author_name) || null,
      text: clean(c.body),
    });
  }

  for (const s of services) {
    out.push({
      source: "service job",
      handle: self,
      date: isoDate(s.date ?? s.created_at),
      author: clean(s.vendor) || null,
      text: joined(s.job, s.notes),
    });
  }

  for (const e of events) {
    out.push({
      source: "downtime event",
      handle: self,
      date: isoDate(e.start_date ?? e.created_at),
      author: null,
      text: joined(e.event_type, e.reason, e.comments),
    });
  }

  for (const s of shots) {
    const measured =
      s.fluid_level_ft === null || s.fluid_level_ft === undefined
        ? ""
        : `fluid level ${String(s.fluid_level_ft)} ft`;
    const text = joined(measured, s.notes);
    if (text) {
      out.push({
        source: "well shot",
        handle: self,
        date: isoDate(s.shot_date),
        author: null,
        text,
      });
    }
  }

  for (const t of tests) {
    const text = clean(t.notes);
    if (text) {
      out.push({
        source: "well test",
        handle: self,
        date: isoDate(t.test_date),
        author: null,
        text,
      });
    }
  }

  for (const c of facility) {
    if (c.deleted_at) continue;
    out.push({
      source: "facility comment",
      handle: self,
      date: isoDate(c.created_at),
      author: clean(c.author_name) || null,
      text: clean(c.body),
    });
  }

  return out
    .filter((e) => e.text.length > 0)
    .sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : -1))
    .slice(0, limit);
}

/** `note_tags.target_type` for one of our handle types. */
function tagType(type: EntityType): string {
  if (type === "vendor") return "service_provider";
  if (type === "owner") return "royalty_owner";
  return type;
}

function isoDate(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  return raw.slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/** Words worth matching on. Short ones match everything and rank nothing. */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Score a passage against the query terms.
 *
 * Every term present scores 1; a passage carrying only some of them scores in
 * proportion. Deliberately simple: this ranks a few thousand short strings, and
 * a cleverer scorer would be harder to explain than the answers are worth.
 */
export function scoreProse(text: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const haystack = text.toLowerCase();
  const hits = queryTerms.filter((t) => haystack.includes(t)).length;
  return hits / queryTerms.length;
}

/** Every note and comment in the org, for an unscoped search. */
async function allProse(sb: Sb): Promise<ProseEntry[]> {
  const out: ProseEntry[] = [];

  // Independent tables, so one round trip's worth of wall clock rather than six.
  const [notes, wellC, tankC, meterC, facilityC, events, services] = await Promise.all([
    rows(sb, "notes", "title, content, author_name, created_at, deleted_at", (q) =>
      q.is("deleted_at", null)
    ),
    rows(sb, "well_comments", "well_id, body, author_name, created_at", (q) => q),
    rows(sb, "tank_comments", "tank_id, body, author_name, created_at", (q) => q),
    rows(sb, "meter_comments", "meter_id, body, author_name, created_at", (q) => q),
    rows(
      sb,
      "facility_comments",
      "entity_type, entity_id, body, author_name, created_at, deleted_at",
      (q) => q.is("deleted_at", null)
    ),
    rows(sb, "well_events", "well_id, event_type, reason, comments, start_date", (q) => q),
    rows(sb, "well_service", "well_id, job, vendor, notes, date", (q) => q),
  ]);

  for (const n of notes) {
    out.push({
      source: "note",
      handle: null,
      date: isoDate(n.created_at),
      author: clean(n.author_name) || null,
      text: joined(n.title, n.content),
    });
  }

  for (const [list, column, type] of [
    [wellC, "well_id", "well"],
    [tankC, "tank_id", "tank"],
    [meterC, "meter_id", "meter"],
  ] as [Row[], string, EntityType][]) {
    for (const c of list) {
      out.push({
        source: `${type} comment`,
        handle: formatHandle(type, String(c[column] ?? "")),
        date: isoDate(c.created_at),
        author: clean(c.author_name) || null,
        text: clean(c.body),
      });
    }
  }

  for (const c of facilityC) {
    out.push({
      source: "facility comment",
      handle: `${clean(c.entity_type)}:${clean(c.entity_id)}`,
      date: isoDate(c.created_at),
      author: clean(c.author_name) || null,
      text: clean(c.body),
    });
  }

  for (const e of events) {
    out.push({
      source: "downtime event",
      handle: formatHandle("well", String(e.well_id ?? "")),
      date: isoDate(e.start_date),
      author: null,
      text: joined(e.event_type, e.reason, e.comments),
    });
  }

  for (const s of services) {
    out.push({
      source: "service job",
      handle: formatHandle("well", String(s.well_id ?? "")),
      date: isoDate(s.date),
      author: clean(s.vendor) || null,
      text: joined(s.job, s.notes),
    });
  }

  return out.filter((e) => e.text.length > 0);
}

export interface ContextSearchResult {
  query: string;
  scope: string | null;
  written: (ProseEntry & { score: number })[];
  documents: { fileId: string; fileName: string; content: string; score: number }[];
  /** Set when the document half could not be narrowed to the requested entity. */
  documentScope?: string;
  note?: string;
}

/**
 * Search what people wrote, optionally scoped to one entity.
 *
 * Two result sets rather than one merged list, because their scores are not
 * comparable: `written` is a term-overlap fraction over short passages and
 * `documents` is a hybrid semantic score over chunks. Interleaving them by score
 * would imply an ordering neither number supports.
 */
export async function contextSearch(
  sb: Sb,
  query: string,
  opts: { handle?: Handle; limit?: number; includeDocuments?: boolean } = {}
): Promise<ContextSearchResult> {
  const limit = opts.limit ?? 10;
  const queryTerms = terms(query);
  const scope = opts.handle
    ? formatHandle(opts.handle.type, opts.handle.id)
    : null;

  const pool = opts.handle
    ? await fieldNotes(sb, opts.handle, 500)
    : await allProse(sb);

  const written = pool
    .map((e) => ({ ...e, score: scoreProse(e.text, queryTerms) }))
    .filter((e) => e.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Newest first within a score. Parenthesised deliberately: written as
        // `b.score - a.score || a.date < b.date ? 1 : -1` the whole expression
        // becomes one ternary on the truthiness of the left side, and the score
        // ordering silently disappears.
        ((a.date ?? "") < (b.date ?? "") ? 1 : -1)
    )
    .slice(0, limit);

  // Documents are narrowed in the SAME call rather than afterwards. Filtering
  // the results would filter the global top N, so a well named in twenty
  // documents returns nothing whenever none of them ranks corpus-wide for the
  // phrase, which reads as "nothing was written" and is a ranking artefact.
  const filters: DocFilters | undefined = opts.handle
    ? opts.handle.type === "well"
      ? { wellIds: [opts.handle.id] }
      : opts.handle.type === "lease"
        ? { leaseIds: [opts.handle.id] }
        : undefined
    : undefined;

  const documents =
    opts.includeDocuments === false
      ? []
      : await searchDocuments(query, limit, null, filters).catch(() => []);

  return {
    query,
    scope,
    written,
    documents,
    ...(opts.handle && !filters
      ? {
          documentScope:
            `Documents were searched across the whole corpus: only wells and leases carry a document scope, and this is a ${opts.handle.type}. Passages below may be about something else.`,
        }
      : {}),
    ...(queryTerms.length === 0
      ? {
          note: "The query carried no word longer than two characters, so nothing could be matched. Ask for the entity's field notes instead of searching.",
        }
      : {}),
  };
}
