import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { getTargetNumbers, getTargets, operatorPoints } from "@/lib/admin/targets";
import { addTargets } from "@/lib/admin/target-actions";
import { getEnrichQueue, getTargetContacts, getTargetResearch } from "@/lib/admin/outreach/research";
import { queueTarget } from "@/lib/admin/outreach/research-actions";
import { getDefaultSequence, getEnrollments } from "@/lib/admin/outreach/sequences";
import { enrollTarget } from "@/lib/admin/outreach/sequence-actions";
import { getProspectingSettings, getScheduledEmails } from "@/lib/admin/outreach/settings";
import { todayInAdminZone, type EnrichStatus } from "@/lib/admin/outreach/types";
import { EMPTY_TARGET_FILTERS, filterTargets } from "@/lib/admin/target-types";
import { TIERS, type TierKey } from "@/lib/billing/tiers";
import { currentPrices, runEnrichment } from "@/lib/ai/admin/enrich-run";
import { getOperatorProfile, searchOperators } from "@/lib/scout/queries";
import { fmtDate8, fmtPhone, partyName, titleCase } from "@/lib/scout/format";

/**
 * The admin Orion's /prospecting catalog: everything the page shows, to read,
 * and the page's four actions, to do after the user approves.
 *
 * Reads go through the same readers the page renders from, so a figure Orion
 * quotes is the figure on screen. Writes go through the same server actions
 * the page's buttons call (platform-admin RLS), each flagged `needsApproval`
 * so the chat shows an approval card and nothing happens until the user
 * clicks it. Nothing here sends email, schedules one, or records a sequence
 * step: those stay the user's buttons on the Sequence tab, and
 * `prospecting-tools.test.ts` pins the catalog.
 */

export const PROSPECTING_READ_TOOL_NAMES = [
  "find_operators",
  "operator_profile",
  "list_targets",
  "enrich_queue",
  "target_card",
  "sequence_enrollments",
  "scheduled_emails",
  "prospecting_settings",
] as const;

export const PROSPECTING_WRITE_TOOL_NAMES = ["add_targets", "queue_for_enrichment", "enrich_target", "add_to_sequence"] as const;

export const PROSPECTING_TOOL_NAMES = [...PROSPECTING_READ_TOOL_NAMES, ...PROSPECTING_WRITE_TOOL_NAMES] as const;

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** One approval card per call; the batch is the user's whole selection, not a page of it. */
const MAX_BATCH = 1000;
const TIER_KEYS = TIERS.map((t) => t.key) as [TierKey, ...TierKey[]];
const TIER_BANDS = TIERS.map((t) => `${t.key} = ${t.minWells}${t.maxWells === null ? "+" : `-${t.maxWells}`} active wells`).join(", ");
const ENRICH_STATUSES = ["queued", "researching", "reviewed", "enrolled"] as const;

const operatorRef = z.object({
  operatorNo: z.number().int().positive().describe("RRC operator number, from find_operators or list_targets."),
  name: z.string().min(1).max(200).describe("The operator's name as the tools returned it; shown on the approval card."),
});

const notATarget = (missing: number[]) => ({
  ok: false as const,
  error: `Not on the targets list: ${missing.join(", ")}. Add them with add_targets first.`,
});

export function prospectingTools() {
  return {
    // ---- Recon ------------------------------------------------------------
    find_operators: tool({
      description:
        "Look up RRC operators by name (the Recon map's operator search): up to ten matches with operator number, city, state, well counts, " +
        "and whether each is already a target or on the enrich queue. Use it to resolve a company the user names before add_targets.",
      inputSchema: z.object({ query: z.string().min(2).max(120) }),
      execute: async ({ query }) => {
        const [matches, points, targets, queue] = await Promise.all([
          searchOperators(query),
          operatorPoints(),
          getTargetNumbers(),
          getEnrichQueue(),
        ]);
        const queued = new Map(queue.map((q) => [q.operatorNo, q.status]));
        return {
          operators: matches.map((m) => {
            const pt = points.get(m.operator_number);
            return {
              operatorNo: m.operator_number,
              name: m.operator_name ?? pt?.nm ?? String(m.operator_number),
              city: pt?.c ?? null,
              state: pt?.s ?? null,
              activeWells: pt ? (pt.wa ?? pt.w) : null,
              totalWells: pt?.w ?? null,
              isTarget: targets.has(m.operator_number),
              enrichStatus: queued.get(m.operator_number) ?? null,
            };
          }),
        };
      },
    }),

    operator_profile: tool({
      description:
        "One operator's RRC record, the dossier Recon opens: P-5 status and filing date, mailing address, phone, officers, well and lease counts, " +
        "last-12-month oil and gas. Works for any operator, target or not.",
      inputSchema: z.object({ operatorNo: z.number().int().positive() }),
      execute: async ({ operatorNo }) => {
        const p = await getOperatorProfile(operatorNo);
        const o = p.operator;
        return {
          operatorNo,
          name: o?.operator_name ?? null,
          p5Status: o?.p5_status ?? null,
          lastP5Filed: fmtDate8(o?.last_p5_date) ?? null,
          address: o
            ? titleCase([o.addr_line1, o.addr_line2, [o.city, o.state, o.zip || ""].filter(Boolean).join(" ")].filter(Boolean).join(", "))
            : null,
          phone: fmtPhone(o?.phone) ?? null,
          oilGatherer: o?.oil_gatherer ?? null,
          gasGatherer: o?.gas_gatherer ?? null,
          officers: p.officers.map((f) => ({
            name: partyName(f.officer_name),
            title: f.officer_title ? titleCase(f.officer_title) : null,
            city: f.officer_city ? titleCase([f.officer_city, f.officer_state].filter(Boolean).join(", ")) : null,
          })),
          wellCount: p.wellCount,
          leaseCount: p.leaseCount,
          last12: { oilBbl: p.last12.oil_last12, gasMcf: p.last12.gas_last12, monthsReported: p.last12.months },
        };
      },
    }),

    // ---- Targets ------------------------------------------------------------
    list_targets: tool({
      description:
        "The Targets tab: every target with its live figures, or the subset a filter keeps (the same filters as the tab's bar; every row that matches is returned, never a page). " +
        "activeWells is what a subscription bills; projectedUsdPerMonth and projectedUsdPerYear are what the operator would pay Wildcat at the current per-well price (null when the price could not be read); " +
        "revenueUsdPerMonth is their estimated production revenue at today's prices; enrichStatus is where the Enrich tab has them (null = not queued). " +
        `Tiers: ${TIER_BANDS}. Compute medians, totals and rankings from the rows; never estimate. Pass the operatorNo and name of each row to the action tools.`,
      inputSchema: z.object({
        query: z.string().max(120).optional().describe("Name or city contains this."),
        minWells: z.number().int().min(0).optional().describe("Active wells, inclusive."),
        maxWells: z.number().int().min(0).optional(),
        tiers: z.array(z.enum(TIER_KEYS)).optional().describe("Subscription bands by active wells; any of."),
        minRevenueUsdPerMonth: z.number().min(0).optional(),
        maxRevenueUsdPerMonth: z.number().min(0).optional(),
        hqCountyCodes: z.array(z.number().int()).optional().describe("RRC county codes the HQ is in; any of."),
        enrichStatus: z
          .array(z.enum([...ENRICH_STATUSES, "none"]))
          .optional()
          .describe("Keep targets whose Enrich status is any of these; 'none' = not on the queue."),
      }),
      execute: async (f) => {
        const prices = await currentPrices();
        const [rows, queue] = await Promise.all([getTargets(prices), getEnrichQueue()]);
        const status = new Map<number, EnrichStatus>(queue.map((q) => [q.operatorNo, q.status]));
        const wanted = f.enrichStatus ? new Set<string>(f.enrichStatus) : null;
        const kept = filterTargets(rows, {
          ...EMPTY_TARGET_FILTERS,
          query: f.query ?? "",
          minWells: f.minWells ?? null,
          maxWells: f.maxWells ?? null,
          tiers: f.tiers ?? [],
          minRevenue: f.minRevenueUsdPerMonth ?? null,
          maxRevenue: f.maxRevenueUsdPerMonth ?? null,
          counties: f.hqCountyCodes ?? [],
        }).filter((t) => !wanted || wanted.has(status.get(t.operatorNo) ?? "none"));
        return {
          prices,
          totalTargets: rows.length,
          matching: kept.length,
          targets: kept.map((t) => ({
            operatorNo: t.operatorNo,
            name: t.name,
            city: t.city,
            state: t.state,
            hqCounty: t.hqCounty,
            activeWells: t.activeWells,
            totalWells: t.totalWells,
            counties: t.counties,
            revenueUsdPerMonth: Math.round(t.revenueUsd),
            projectedUsdPerMonth: t.projectedUsd,
            projectedUsdPerYear: t.projectedYearUsd,
            enrichStatus: status.get(t.operatorNo) ?? null,
            addedOn: t.createdAt.slice(0, 10),
          })),
        };
      },
    }),

    // ---- Enrich -------------------------------------------------------------
    enrich_queue: tool({
      description: "The Enrich tab's queue: each queued target with its status (queued, researching, reviewed, enrolled), website and when it was queued.",
      inputSchema: z.object({}),
      execute: async () => ({ queue: await getEnrichQueue() }),
    }),

    target_card: tool({
      description:
        "One target's research card from the Enrich tab: status, website and what on it matched the P-5 record, notes, and every contact with its id, " +
        "source, verification, whether it is a generic mailbox and whether it is a decision-maker; plus the target's active sequence enrollments. " +
        "Read it before add_to_sequence to pick the contact ids.",
      inputSchema: z.object({ operatorNo: z.number().int().positive() }),
      execute: async ({ operatorNo }) => {
        const [research, contacts, enrollments] = await Promise.all([
          getTargetResearch(operatorNo),
          getTargetContacts(operatorNo),
          getEnrollments(),
        ]);
        return {
          operatorNo,
          research,
          contacts,
          enrollments: enrollments.filter((e) => e.operatorNo === operatorNo),
        };
      },
    }),

    // ---- Sequence -----------------------------------------------------------
    sequence_enrollments: tool({
      description:
        "The Sequence tab: the default sequence's steps (round, weekday, email or call) and every enrollment with its company, contact, current step, " +
        "next due date, state and last recorded outcome. dueToday lists what the user owes today in the admin time zone.",
      inputSchema: z.object({}),
      execute: async () => {
        const [sequence, enrollments] = await Promise.all([getDefaultSequence(), getEnrollments()]);
        const today = todayInAdminZone();
        return {
          today,
          sequence: sequence
            ? { name: sequence.name, steps: sequence.steps.map((s) => ({ round: s.round, weekday: WEEKDAY[s.weekday], action: s.action })) }
            : null,
          dueToday: enrollments.filter((e) => e.state === "active" && e.nextDueOn != null && e.nextDueOn <= today).map((e) => e.id),
          enrollments,
        };
      },
    }),

    scheduled_emails: tool({
      description: "Emails the user scheduled for the cron to send (pending and failed): recipient, subject, send time, the named schedule, and any error.",
      inputSchema: z.object({}),
      execute: async () => ({ scheduled: await getScheduledEmails() }),
    }),

    prospecting_settings: tool({
      description: "The prospecting settings: the outreach email template (with its {{placeholders}}) and the named send schedules.",
      inputSchema: z.object({}),
      execute: async () => {
        const s = await getProspectingSettings();
        return {
          template: s.template,
          schedules: s.schedules.map((x) => ({ name: x.name, weekday: x.weekday == null ? "every day" : WEEKDAY[x.weekday], time: x.time })),
        };
      },
    }),

    // ---- Actions (each waits for the user's approval) -----------------------
    add_targets: tool({
      description:
        "Add operators to the Targets list, the way checking them on the Recon map and pressing Add does. Resolve each with find_operators first. " +
        "An operator already on the list is left as it is. The user approves the card before anything is written.",
      inputSchema: z.object({ operators: z.array(operatorRef).min(1).max(MAX_BATCH) }),
      needsApproval: true,
      execute: async ({ operators }) => {
        const [points, existing] = await Promise.all([operatorPoints(), getTargetNumbers()]);
        await addTargets(
          operators.map((o) => {
            const pt = points.get(o.operatorNo);
            return { operatorNo: o.operatorNo, name: pt?.nm ?? o.name, city: pt?.c ?? null, state: pt?.s ?? null };
          })
        );
        return {
          ok: true as const,
          added: operators.filter((o) => !existing.has(o.operatorNo)).map((o) => o.operatorNo),
          alreadyTargets: operators.filter((o) => existing.has(o.operatorNo)).map((o) => o.operatorNo),
        };
      },
    }),

    queue_for_enrichment: tool({
      description:
        "Put targets on the Enrich queue (the Targets tab's Enrich button). They must already be targets. A target already queued is left as it is. " +
        "Queueing does not research anything; enrich_target does.",
      inputSchema: z.object({ operators: z.array(operatorRef).min(1).max(MAX_BATCH) }),
      needsApproval: true,
      execute: async ({ operators }) => {
        const targets = await getTargetNumbers();
        const missing = operators.filter((o) => !targets.has(o.operatorNo)).map((o) => o.operatorNo);
        if (missing.length) return notATarget(missing);
        for (const o of operators) await queueTarget(o.operatorNo);
        return { ok: true as const, queued: operators.map((o) => o.operatorNo) };
      },
    }),

    enrich_target: tool({
      description:
        "Research ONE target the way the Enrich tab's chat does, start to finish: find its website, the decision-makers, and their email addresses (Exa and Hunter), " +
        "and save them on its card. It must be a target; it is queued if it is not already. Takes a minute or two and spends search credits, so one target per call, " +
        "and the user approves each. Returns Orion's report and what the card now holds; show the user the report and tell them the card is on the Enrich tab.",
      inputSchema: operatorRef,
      needsApproval: true,
      execute: async ({ operatorNo }) => {
        const targets = await getTargetNumbers();
        if (!targets.has(operatorNo)) return notATarget([operatorNo]);
        await queueTarget(operatorNo);
        const run = await runEnrichment(operatorNo);
        if (!run) return notATarget([operatorNo]);
        const [research, contacts] = await Promise.all([getTargetResearch(operatorNo), getTargetContacts(operatorNo)]);
        return {
          ok: true as const,
          report: run.report,
          steps: run.steps,
          card: {
            status: research?.status ?? null,
            website: research?.website ?? null,
            notes: research?.notes ?? "",
            contacts: contacts.map((c) => ({
              id: c.id,
              name: c.name,
              title: c.title,
              email: c.email,
              phone: c.phone,
              source: c.source,
              verification: c.verification,
              generic: c.generic,
              decisionMaker: c.decisionMaker,
            })),
          },
        };
      },
    }),

    add_to_sequence: tool({
      description:
        "Enroll a target in the default sequence (the research card's Add to sequence button): one enrollment per chosen contact, or one with no contact " +
        "(calls go to the P-5 phone) when contacts is empty. Read target_card first and choose decision-makers with a deliverable, non-generic email; " +
        "never a generic mailbox unless the user asks. A contact already active in the sequence is skipped. The user approves the card before anything is written.",
      inputSchema: z.object({
        operatorNo: operatorRef.shape.operatorNo,
        name: operatorRef.shape.name,
        contacts: z
          .array(
            z.object({
              id: z.string().uuid().describe("Contact id from target_card."),
              name: z.string().max(200).nullable().describe("Shown on the approval card."),
              email: z.string().max(320).nullable().describe("Shown on the approval card."),
            })
          )
          .max(20),
      }),
      needsApproval: true,
      execute: async ({ operatorNo, contacts }) => {
        const targets = await getTargetNumbers();
        if (!targets.has(operatorNo)) return notATarget([operatorNo]);
        const onFile = new Set((await getTargetContacts(operatorNo)).map((c) => c.id));
        const unknown = contacts.filter((c) => !onFile.has(c.id)).map((c) => c.id);
        if (unknown.length) {
          return { ok: false as const, error: `Not this target's contacts: ${unknown.join(", ")}. Read target_card and use its ids.` };
        }
        const { enrolled } = await enrollTarget(
          operatorNo,
          contacts.map((c) => c.id)
        );
        return { ok: true as const, enrolled, alreadyActive: contacts.length === 0 ? (enrolled === 0 ? 1 : 0) : contacts.length - enrolled };
      },
    }),
  };
}
