import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { runAsOrion } from "@/lib/admin/google/orion-guard";
import { enrichTools } from "@/lib/ai/admin/enrich-tools";
import { buildEnrichSystemPrompt, type EnrichTargetContext } from "@/lib/ai/admin/enrich-prompt";
import { getTarget } from "@/lib/admin/targets";
import { getTargetContacts, getTargetResearch } from "@/lib/admin/outreach/research";
import { getOperatorProfile } from "@/lib/scout/queries";
import { getCommodityQuotes } from "@/lib/pricing/feed";
import { FALLBACK_PRICES } from "@/lib/scout/revenue";
import type { CommodityPrices } from "@/lib/analytics/types";

/**
 * Enrichment without a chat: the same persona, card and tool catalog the
 * Enrich tab's chat runs, driven to completion in one `generateText` call.
 * The admin Orion's `enrich_target` tool runs it after the user approves; the
 * card (website, contacts, notes, status) is what it leaves behind, through
 * the same server actions the chat's tools use.
 */

const MODEL = "claude-opus-5";
const MAX_STEPS = 30;
const SUMMARY_CHARS = 6_000;

const HEADLESS_TURN =
  "Research this company now. There is no one in this chat to confirm each step, so work through all four steps without pausing to ask, " +
  "save what you find on the card as you go, and finish with a short report: the website (or that none was found), the decision-makers and their contact details, and what you could not find.";

/** Today's quotes, the way /prospecting prices its targets. */
export async function currentPrices(): Promise<CommodityPrices> {
  const quotes = await getCommodityQuotes().catch(() => []);
  return {
    oilPerBbl: quotes.find((q) => q.label === "WTI")?.price ?? FALLBACK_PRICES.oilPerBbl,
    gasPerMcf: quotes.find((q) => q.label === "Nat Gas")?.price ?? FALLBACK_PRICES.gasPerMcf,
  };
}

/** The target's card as the Enrich chat sees it; null when it is not a target. */
export async function loadEnrichContext(targetNo: number): Promise<EnrichTargetContext | null> {
  const prices = await currentPrices();
  const [target, research, contacts] = await Promise.all([
    getTarget(targetNo, prices),
    getTargetResearch(targetNo),
    getTargetContacts(targetNo),
  ]);
  if (!target) return null;
  const profile = await getOperatorProfile(targetNo).catch(() => null);
  return {
    target,
    p5: profile?.operator ?? null,
    officers: profile?.officers ?? [],
    last12: profile?.last12 ?? null,
    leaseCount: profile?.leaseCount ?? null,
    research,
    contacts,
  };
}

export interface EnrichRun {
  /** Orion's closing report, cut to a readable length. */
  report: string;
  steps: number;
  toolsUsed: string[];
}

export async function runEnrichment(targetNo: number): Promise<EnrichRun | null> {
  const ctx = await loadEnrichContext(targetNo);
  if (!ctx) return null;
  const tools = enrichTools(targetNo);
  const asOrion = Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const execute = t.execute as ((...args: unknown[]) => unknown) | undefined;
      return [name, execute ? { ...t, execute: (...args: unknown[]) => runAsOrion(() => execute(...args)) } : t];
    })
  ) as typeof tools;

  const result = await generateText({
    model: anthropic(MODEL),
    system: buildEnrichSystemPrompt(ctx, new Date()),
    prompt: HEADLESS_TURN,
    tools: asOrion,
    providerOptions: { anthropic: { effort: "medium", cacheControl: { type: "ephemeral" } } },
    stopWhen: stepCountIs(MAX_STEPS),
  });
  const toolsUsed = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
  console.info("admin-enrich:run", { targetNo, steps: result.steps.length, tools: toolsUsed });
  const text = result.text.trim();
  return {
    report: text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text,
    steps: result.steps.length,
    toolsUsed,
  };
}
