/**
 * The product's own help docs, made readable by Orion.
 *
 * A user asking "how do I record a gauge" is asking about THIS app, and the
 * answer is written down in `site-docs/`. Without these tools Orion answered
 * from the system prompt's general description of the app, which is a summary
 * of a summary: it produced confident, plausible, occasionally wrong click
 * paths, and nothing distinguished a remembered answer from a documented one.
 *
 * Two tools, matching the two things a reader does:
 *
 *   search_docs  which doc covers this, in the user's words (see `search.ts`
 *                for the synonym table that makes "stick a tank" find "Record
 *                a tank gauge")
 *   read_doc     that doc, verbatim
 *
 * ## Not gated, by design
 *
 * These are the product's public documentation, not the org's records: there is
 * nothing here to withhold from anyone who is already signed in, and a
 * workspace that switched off help would only get worse answers to the same
 * questions. Hence the `docs` area is `alwaysOn` in `tool-permissions.ts` and
 * there is no settings switch for it.
 *
 * ## Verbatim
 *
 * `read_doc` returns the markdown as written. Nothing here summarises: a
 * summarised step list is exactly where an invented click path comes from, and
 * the docs are short enough that the whole page is affordable.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { DOC_SECTIONS, findDoc, findSection } from "@/lib/docs/catalog";
import { docsAvailable, searchDocs } from "@/lib/docs/search";

const DOCS_DIR = path.join(process.cwd(), "site-docs");

/** The whole shape of the corpus, short enough to state rather than look up. */
export const DOC_SECTION_LIST = DOC_SECTIONS.map(
  (s) => `${s.slug} (${s.title}, ${s.pages.length} docs)`
).join("; ");

const NOT_CONFIGURED = {
  ok: false as const,
  error:
    "The help docs are not present in this environment. Answer from what you " +
    "know about the app and say plainly that you could not check the docs.",
};

export function docsTools() {
  return {
    search_docs: tool({
      description:
        "Search the product's own help documentation — the written, step-by-step instructions for using WildcatIQ. USE THIS WHENEVER THE USER ASKS HOW TO DO SOMETHING IN THE APP (where a screen is, how to enter or correct something, what a button does, why something is not showing), before answering. Pass the question in the user's own words: field vocabulary is mapped onto the docs' wording, so 'stick a tank' finds 'Record a tank gauge' and 'check stub' finds the statement docs. Returns the docs that bear on it, best first, each with its section, slug, title and a snippet. Then call read_doc on the one you picked and answer from what it actually says.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "what the user is trying to do, in their words, e.g. 'stick a tank', 'stop a coworker seeing revenue', 'enter a check stub'"
          ),
        section: z
          .string()
          .optional()
          .describe(
            `restrict to one section slug. The sections are: ${DOC_SECTION_LIST}`
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe("how many docs to return (default 5, max 20)"),
      }),
      execute: async ({ query, section, limit }) => {
        if (!docsAvailable()) return NOT_CONFIGURED;
        if (section && !findSection(section)) {
          return {
            ok: false as const,
            error: `"${section}" is not a section. They are: ${DOC_SECTION_LIST}`,
          };
        }
        const hits = searchDocs(query, {
          ...(section ? { section } : {}),
          ...(limit ? { limit } : {}),
        });
        if (hits.length === 0) {
          return {
            ok: true as const,
            hits: [],
            note: "Nothing in the help docs matches that. Try the user's other words for it, or answer from what you know and say the docs do not cover it.",
          };
        }
        return {
          ok: true as const,
          hits,
          next: "read_doc(section, slug) returns the full text of one of these. Answer from that text, not from this snippet.",
        };
      },
    }),

    read_doc: tool({
      description:
        "Read one help doc in full, as written. `section` and `slug` come from search_docs. Use it to answer a how-to question with the actual steps rather than a remembered approximation: name the doc's title in your answer so the user can find it themselves, follow its steps in its order, and if it does not answer the question say so instead of filling the gap.",
      inputSchema: z.object({
        section: z
          .string()
          .describe(`section slug, one of: ${DOC_SECTION_LIST}`),
        slug: z.string().describe("the doc's slug, as search_docs returned it"),
      }),
      execute: async ({ section, slug }) => {
        const found = findDoc(section.trim(), slug.trim());
        if (!found) {
          return {
            ok: false as const,
            error: `There is no help doc at ${section}/${slug}. Use search_docs to find the right one.`,
          };
        }
        try {
          // Path built from the catalog, never from the argument, so a slug
          // cannot walk out of the corpus.
          const markdown = await readFile(
            path.join(DOCS_DIR, found.section.slug, `${found.page.slug}.md`),
            "utf8"
          );
          return {
            ok: true as const,
            section: found.section.slug,
            sectionTitle: found.section.title,
            slug: found.page.slug,
            title: found.page.title,
            url: `/docs/${found.section.slug}/${found.page.slug}`,
            markdown,
          };
        } catch {
          return NOT_CONFIGURED;
        }
      },
    }),
  };
}
