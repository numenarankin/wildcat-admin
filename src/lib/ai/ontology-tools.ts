import { tool } from "ai";
import { z } from "zod";

import { getRequestSupabase } from "@/lib/supabase/request-client";
import { readConversation, searchChatHistory } from "@/lib/ai/chat-history";
import { coverage } from "@/lib/ontology/coverage";
import { loadRoster } from "@/lib/ontology/entities";
import {
  ENTITY_TYPES,
  handleError,
  parseHandle,
  parseHandleOfType,
  type EntityType,
} from "@/lib/ontology/handles";
import { links } from "@/lib/ontology/links";
import { isAmbiguous, matchEntities } from "@/lib/ontology/match";
import { MEASURABLE, METRICS, measure } from "@/lib/ontology/measure";
import { describeObject } from "@/lib/ontology/object";
import { allocationBasis } from "@/lib/ontology/allocation";
import { contextSearch, fieldNotes } from "@/lib/ontology/prose";
import {
  selectBatteries,
  selectLeases,
  selectMeters,
  selectTanks,
  selectWells,
  selectWellsOn,
} from "@/lib/ontology/select";

/**
 * The ontology layer, as tools.
 *
 * Orion's other tools are single-entity getters: 127 of them, none of which
 * resolves a name, traverses a relationship, computes a derived quantity, or
 * operates on a set. These five do those things and are registered directly
 * rather than behind a dispatcher, because they are called on nearly every
 * analytical turn and their arguments have to be in the schema list where the
 * model cannot get them wrong.
 *
 * Everything is addressed by HANDLE (`well:smith-3`), so the type travels with
 * the id. The schema addresses the same things three different ways — a text
 * slug for a well, uuids elsewhere, untyped `facility_type`/`facility_id` pairs
 * for facilities — and a model asked to carry that distinction gets it wrong
 * silently: an id passed where another type was wanted returns an empty result
 * rather than an error.
 *
 * Read-only. Nothing here writes, so none of it needs an approval gate.
 *
 * ## Why `getRequestSupabase` and not `getSupabaseServer`
 *
 * `getSupabaseServer()` builds a FRESH client per call, and the request memo in
 * `@/lib/cache/loaders` keys on the client object. Eight tools each making their
 * own client share nothing, so every call re-read every tank, every reading and
 * the whole flow graph: the gather stage timed out at 45s doing the same org-wide
 * load eight times. This returns one client per scope, which is what makes those
 * caches collapse to a single read. The caller still has to open the scope with
 * `withRequestScope`.
 */

const handleArg = z
  .string()
  .describe('entity handle, "type:id", e.g. "well:smith-3" — from resolve');

/** `YYYY-MM-DD`, `days` before now, in UTC. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * @param folderId Scopes the chat-history search to one project's conversations,
 *   as the project drawer needs. Omitted (the gather stages, the global page)
 *   searches every conversation.
 */
export function ontologyTools(folderId?: string) {
  return {
    resolve: tool({
      description:
        "Turn something the user said into an entity HANDLE. START HERE for any question about a specific well, lease, tank, battery, meter, purchaser, vendor, owner or person: every other ontology tool takes a handle, and guessing an id silently returns an empty result instead of an error. Matches the way names are actually written and spoken, so 'repass 2', 'REPASS #2' and 'the Repass' all find the same thing. Returns ranked candidates with a detail line to tell them apart; when the top two tie it says so rather than picking one, and you should ask the user which they meant.",
      inputSchema: z.object({
        query: z.string().describe("the name as the user said it"),
        types: z
          .array(z.enum(ENTITY_TYPES))
          .optional()
          .describe("restrict to these entity types; omit to search all"),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async ({ query, types, limit }) => {
        const sb = await getRequestSupabase();
        const { candidates } = await loadRoster(sb);
        const matches = matchEntities(query, candidates, {
          types: types as EntityType[] | undefined,
          limit: limit ?? 8,
        });
        return {
          query,
          matches,
          ambiguous: isAmbiguous(matches),
          ...(matches.length === 0
            ? {
                note: `Nothing on file is named anything like "${query}". Say so rather than guessing at a similar name; the entity may simply not exist yet.`,
              }
            : {}),
          ...(isAmbiguous(matches)
            ? {
                note: "Two or more candidates match equally well. Ask which one rather than choosing.",
              }
            : {}),
        };
      },
    }),

    get_object: tool({
      description:
        "Everything known about one entity, in a single call: its own record, what it belongs to, and its current oil / gas / water rates over the last 90 days. Use this instead of chaining get_well, get_lease, get_tank and get_production. Rates come from the production engines, NOT from the static columns on the well record, which are hand-entered and stale. Every rate says whether it is measured or allocated. Takes an entity handle from resolve.",
      inputSchema: z.object({ handle: handleArg }),
      execute: async ({ handle }) => {
        const parsed = parseHandle(handle);
        if (!parsed) return handleError(handle);
        const sb = await getRequestSupabase();
        return describeObject(sb, parsed);
      },
    }),

    get_links: tool({
      description:
        "The relationships out of one entity: which lease a well is on, which battery and meters it produces to and at what allocation percentage, which wells feed a tank or a meter, what sits on a lease. This is how you answer 'where does this well's oil go', 'which wells are on this battery', or 'what is on the Repass lease'. Allocation percentages come back on the edges that carry them, which is what makes an allocated production number explicable. Works for well, lease, tank, battery and meter. Takes an entity handle from resolve.",
      inputSchema: z.object({ handle: handleArg }),
      execute: async ({ handle }) => {
        const parsed = parseHandle(handle);
        if (!parsed) return handleError(handle);
        const sb = await getRequestSupabase();
        return links(sb, parsed);
      },
    }),

    get_measure: tool({
      description:
        "The company's own production series for one entity and one metric — oil (bbl), gas (MCF) or water (bbl) — as a monthly or daily series with the total, the trailing daily rate and the dates covered. This is the ONE canonical derivation: the same engine (and the same partial-gauge-day cut) the well page, the production table and the lease page read, so a figure from here cannot disagree with the app. Omit the handle for the whole company. Oil can be measured for a well, lease, tank or battery; gas and water for a well or lease. A well's figure is ALLOCATED (a facility measurement divided by an allocation), everything else is measured, and the result says which. Never quote an RRC figure and one of these as the same number.",
      inputSchema: z.object({
        handle: z
          .string()
          .optional()
          .describe("entity handle; omit for the whole company"),
        metric: z.enum(METRICS),
        from: z.string().optional().describe("YYYY-MM-DD, inclusive"),
        to: z.string().optional().describe("YYYY-MM-DD, inclusive"),
        grain: z.enum(["day", "month"]).optional().describe("default month"),
      }),
      execute: async ({ handle, metric, from, to, grain }) => {
        const allowed = MEASURABLE[metric];
        const parsed = handle ? parseHandleOfType(handle, allowed) : null;
        if (handle && !parsed) return handleError(handle, allowed);
        const sb = await getRequestSupabase();
        return measure(sb, parsed, metric, { from, to, grain });
      },
    }),

    select_entities: tool({
      description:
        "Build a SET of handles to run something over: every active well, the wells on a lease or a battery or a meter, every oil tank, every gas meter. Use it before any question about more than one entity so the set is explicit and complete rather than assembled from a list you filtered by eye. Inactive wells (shut in, plugged, sold) are excluded unless you ask for them. Filters here are the ones the records support; a cut-off on a produced quantity ('wells under 5 bbl/d') is a ranking over get_measure, not a filter.",
      inputSchema: z.object({
        kind: z.enum(["wells", "leases", "tanks", "batteries", "meters"]),
        on: z
          .string()
          .optional()
          .describe('wells only: a battery or meter handle, e.g. "battery:uuid"'),
        leaseId: z.string().optional().describe("restrict to one lease's id"),
        wellType: z.enum(["producer", "injection"]).optional(),
        product: z.enum(["oil", "water"]).optional().describe("tanks only"),
        substance: z.enum(["gas", "water"]).optional().describe("meters only"),
        county: z.string().optional().describe("wells only"),
        includeInactive: z.boolean().optional(),
      }),
      execute: async ({
        kind,
        on,
        leaseId,
        wellType,
        product,
        substance,
        county,
        includeInactive,
      }) => {
        const sb = await getRequestSupabase();
        const activeOnly = includeInactive ? false : undefined;

        if (kind === "wells") {
          if (on) {
            const parent = parseHandleOfType(on, ["battery", "meter"]);
            if (!parent) return handleError(on, ["battery", "meter"]);
            return selectWellsOn(sb, parent as { type: "battery" | "meter"; id: string });
          }
          return selectWells({
            leaseId,
            wellType,
            county,
            ...(activeOnly === false ? { activeOnly: false } : {}),
          });
        }
        if (kind === "leases") return selectLeases(!includeInactive);
        if (kind === "tanks") {
          return selectTanks(sb, { product, leaseId, activeOnly: !includeInactive });
        }
        if (kind === "batteries") {
          return selectBatteries(sb, { leaseId, activeOnly: !includeInactive });
        }
        return selectMeters(sb, { substance, leaseId, activeOnly: !includeInactive });
      },
    }),

    allocation_basis: tool({
      description:
        "WHY a well's production number is the size it is: the full dated allocation timeline of the facility that governs it, every period with its dates, its shares and its METHOD. Call this before explaining, defending or questioning any allocated figure, and always before calling a split wrong. An allocation is a timeline, not a number — a battery that ran 90/10 for five years and was re-split to 50/50 last month is not inconsistent with its history, and get_links only shows you today. A `manual` period is a number somebody typed; a `well-test` period is derived from filed tests. It also reports configuration that governs nothing, such as a tank carrying its own split while its battery is what actually allocates. Takes a well, battery, tank or meter handle from resolve.",
      inputSchema: z.object({
        handle: handleArg,
        substance: z
          .enum(["oil", "gas", "water"])
          .optional()
          .describe("which stream's allocation; default oil"),
      }),
      execute: async ({ handle, substance }) => {
        const parsed = parseHandle(handle);
        if (!parsed) return handleError(handle);
        const sb = await getRequestSupabase();
        return allocationBasis(sb, parsed, substance ?? "oil");
      },
    }),

    field_notes: tool({
      description:
        "Everything anyone has WRITTEN about one entity, newest first: notes tagged to it, comments left on it, service jobs, downtime reasons, well shots and test notes. This is 'catch me up on this well' — the question no search term expresses. Use it before diagnosing anything, because the reason a well is down is usually typed somewhere rather than measured. Takes an entity handle from resolve.",
      inputSchema: z.object({
        handle: handleArg,
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ handle, limit }) => {
        const parsed = parseHandle(handle);
        if (!parsed) return handleError(handle);
        const sb = await getRequestSupabase();
        const entries = await fieldNotes(sb, parsed, limit ?? 50);
        return {
          handle,
          entries,
          count: entries.length,
          ...(entries.length === 0
            ? { note: "Nobody has written anything about this entity." }
            : {}),
        };
      },
    }),

    context_search: tool({
      description:
        "Search what PEOPLE WROTE across the company: the notes page, every comment on a well, tank or meter, downtime reasons, service-job notes, plus the uploaded documents. Wider than search_documents, which only covers uploaded files and has never seen a note or a comment. Pass a handle to scope it to one entity. Written passages and document passages come back separately because their scores are not comparable.",
      inputSchema: z.object({
        query: z.string(),
        handle: z
          .string()
          .optional()
          .describe("scope to one entity; omit to search the whole company"),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ query, handle, limit }) => {
        const parsed = handle ? parseHandle(handle) : null;
        if (handle && !parsed) return handleError(handle);
        const sb = await getRequestSupabase();
        return contextSearch(sb, query, {
          handle: parsed ?? undefined,
          limit: limit ?? 10,
        });
      },
    }),

    get_coverage: tool({
      description:
        "How complete the data actually is for one entity over a window, before you compute anything from it. Reports, per metric, how many days carry a reading, which months are empty, and which of two very different problems you have: NOT WIRED (nothing measures this — the well is on no battery or meter, and no data entry fixes it) or NOT RECORDED (the path exists, the readings were never entered). Call this whenever a figure looks low, a trend looks like a collapse, or you are about to state an average over a long window. An average over a quarter of a year is arithmetically correct and materially wrong. Takes an entity handle from resolve.",
      inputSchema: z.object({
        handle: handleArg,
        from: z.string().optional().describe("YYYY-MM-DD, default 365 days ago"),
        to: z.string().optional().describe("YYYY-MM-DD, default today"),
      }),
      execute: async ({ handle, from, to }) => {
        const parsed = parseHandle(handle);
        if (!parsed) return handleError(handle);
        const sb = await getRequestSupabase();
        return coverage(sb, parsed, from ?? daysAgo(365), to ?? today());
      },
    }),

    /*
     * Past conversations, in the researcher's reach.
     *
     * The gather stages had no way to see them, so the only thing that ever
     * searched chat history was the answering model, and only when it thought
     * to. Asked "what plays are like our Repass 2", it did not think to — and
     * the standing plan for that well, worked over several sessions, lives
     * nowhere else. The turn answered from field records about a well whose
     * plan was in the chat log all along.
     *
     * That is not an edge case. In this app the DECISION about a well is
     * usually a conversation, while the database holds only what was measured.
     * A researcher that reads every record and no discussion is reading half
     * the company.
     */
    search_chat_history: tool({
      description: `Search PAST conversations${folderId ? " in THIS project" : ""} for what was discussed, planned or decided about something. Ranked keyword search with stemming and oilfield synonyms across EVERY conversation, not a verbatim phrase match. CHECK THIS BEFORE SAYING SOMETHING WAS NEVER DISCUSSED, and for any question about a plan, an intention or a standing position — those live in past chats, not in the records. Use SHORT, DISTINCTIVE queries: the well or lease name alone ('Repass 2') beats a description of what you hope to find, because every extra word narrows the match. Retry with fewer words before concluding there is nothing. Treat what was said as prior discussion, not established fact.`,
      inputSchema: z.object({
        query: z.string().describe("the subject, as few words as possible"),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      execute: async ({ query, limit }) =>
        searchChatHistory(query, limit ?? 10, folderId),
    }),

    read_conversation: tool({
      description:
        "Read one past conversation in full, by the id search_chat_history returned. Use it whenever a snippet suggests a plan or a decision: a snippet shows that something was discussed and rarely shows what was concluded, and the last word on a well is usually a correction to something said earlier in the same thread.",
      inputSchema: z.object({ conversationId: z.string() }),
      execute: async ({ conversationId }) => ({
        conversation: await readConversation(conversationId),
      }),
    }),
  };
}
