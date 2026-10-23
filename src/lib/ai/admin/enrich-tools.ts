import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { hasHunter, hunterDomainSearch, hunterEmailFinder, hunterVerify } from "@/lib/admin/hunter";
import { NotConfigured, webTools } from "@/lib/ai/admin/web-tools";
import {
  saveResearchNotes,
  saveWebsite,
  setResearchStatus,
  upsertContacts,
} from "@/lib/admin/outreach/research-actions";

/**
 * The Enrich chat's tool catalog: research the web, ask Hunter, and record
 * what was found on the target's card. Every write lands in
 * `admin_target_research` / `admin_target_contacts` through the same server
 * actions the user's own clicks use (platform-admin RLS).
 *
 * NOTHING HERE SENDS, ENROLLS OR SCHEDULES. Those are the user's buttons on
 * the Targets, Enrich and Sequence tabs; `enrich-tools.test.ts` pins the
 * catalog and `no-send.test.ts` walks the route's imports for a send path.
 */

export const ENRICH_TOOL_NAMES = [
  "search_web",
  "read_page",
  "hunter_domain_search",
  "hunter_find_email",
  "hunter_verify_email",
  "save_website",
  "save_contacts",
  "save_notes",
  "set_status",
] as const;


export function enrichTools(targetNo: number) {
  return {
    ...webTools({
      search:
        "Use it to find the company's own website: query the name without its corporate suffix, the city and state, and 'oil gas'; in the objective say that the operator's own site ranks first and that directories, social profiles and aggregators are to be skipped.",
      read: "Use it on the homepage, then on the contact/about/team links it returns (at most ten pages per site).",
    }),

    hunter_domain_search: tool({
      description:
        "Every email address Hunter has seen for a domain, with the domain's address pattern and each address's name, position and confidence. " +
        "Run it once the website is confirmed; it often names the people by itself.",
      inputSchema: z.object({ domain: z.string().min(3).max(253) }),
      execute: async ({ domain }) => {
        if (!hasHunter()) return NotConfigured("Hunter", "HUNTER_API_KEY");
        try {
          return { ok: true as const, result: await hunterDomainSearch(domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")) };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : "Hunter failed." };
        }
      },
    }),

    hunter_find_email: tool({
      description: "Hunter's most likely address for a named person at a domain, with a 0-100 score. For a decision-maker the domain search did not list.",
      inputSchema: z.object({
        domain: z.string().min(3).max(253),
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
      }),
      execute: async ({ domain, firstName, lastName }) => {
        if (!hasHunter()) return NotConfigured("Hunter", "HUNTER_API_KEY");
        try {
          return { ok: true as const, result: await hunterEmailFinder(domain, firstName, lastName) };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : "Hunter failed." };
        }
      },
    }),

    hunter_verify_email: tool({
      description:
        "Whether an address delivers (Hunter): deliverable, risky (accept-all domain), undeliverable or unknown. Verify every address before saving it as usable, found or guessed.",
      inputSchema: z.object({ email: z.string().email() }),
      execute: async ({ email }) => {
        if (!hasHunter()) return NotConfigured("Hunter", "HUNTER_API_KEY");
        try {
          return { ok: true as const, result: await hunterVerify(email) };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : "Hunter failed." };
        }
      },
    }),

    save_website: tool({
      description:
        "Record the company's website on its card, with what on the site matched the P-5 record. Call it once you have read the homepage and checked the phone, address, city and officer names against it. " +
        "The user confirms the link themselves; a match on phone or address is the strong evidence, a name alone is a guess and you must say so.",
      inputSchema: z.object({
        website: z.string().url(),
        matches: z.object({
          phone: z.boolean().describe("The P-5 phone appears on the site."),
          address: z.boolean().describe("The P-5 street address appears on the site."),
          city: z.boolean().describe("The P-5 city appears on the site."),
          names: z.array(z.string()).describe("P-5 officer names seen on the site."),
        }),
      }),
      execute: async ({ website, matches }) => {
        await saveWebsite(targetNo, website, matches);
        return { ok: true as const };
      },
    }),

    save_contacts: tool({
      description:
        "Record people and addresses on the company's card. One row per person or mailbox; an address already on file is updated, not duplicated. " +
        "source is where it came from: p5 (the RRC filing), website (a page you read; give sourceUrl), hunter (found by Hunter), guess (built from the domain's pattern). " +
        "Set verification from hunter_verify_email; leave it out when not verified. Mark decisionMaker true for the owner, president, operations or production manager, office or accounting lead.",
      inputSchema: z.object({
        contacts: z
          .array(
            z.object({
              name: z.string().max(200).optional(),
              title: z.string().max(200).optional(),
              email: z.string().email().optional(),
              phone: z.string().max(40).optional(),
              source: z.enum(["p5", "website", "hunter", "guess"]),
              sourceUrl: z.string().url().optional(),
              confidence: z.number().int().min(0).max(100).optional(),
              verification: z.enum(["deliverable", "risky", "undeliverable", "unknown"]).optional(),
              decisionMaker: z.boolean().optional(),
            })
          )
          .min(1)
          .max(30),
      }),
      execute: async ({ contacts }) => {
        const saved = await upsertContacts(targetNo, contacts);
        return { ok: true as const, saved: saved.map((c) => ({ id: c.id, name: c.name, email: c.email, generic: c.generic })) };
      },
    }),

    save_notes: tool({
      description:
        "Replace the research notes on the company's card: a short plain-text summary of what you found (what they do, where, size, anything relevant to selling them software). Not a transcript.",
      inputSchema: z.object({ notes: z.string().max(20_000) }),
      execute: async ({ notes }) => {
        await saveResearchNotes(targetNo, notes);
        return { ok: true as const };
      },
    }),

    set_status: tool({
      description:
        "Move the company's research status: researching while you work, reviewed when the website is confirmed and the decision-makers and their contact details are saved. Never enrolled: only the user's Add to sequence does that.",
      inputSchema: z.object({ status: z.enum(["researching", "reviewed"]) }),
      execute: async ({ status }) => {
        await setResearchStatus(targetNo, status);
        return { ok: true as const };
      },
    }),
  };
}
