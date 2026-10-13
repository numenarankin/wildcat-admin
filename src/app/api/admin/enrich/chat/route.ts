import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  smoothStream,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { runAsOrion } from "@/lib/admin/google/orion-guard";
import { enrichTools } from "@/lib/ai/admin/enrich-tools";
import { buildEnrichSystemPrompt } from "@/lib/ai/admin/enrich-prompt";
import { getTarget } from "@/lib/admin/targets";
import { getTargetContacts, getTargetResearch } from "@/lib/admin/outreach/research";
import { getOperatorProfile } from "@/lib/scout/queries";
import { getCommodityQuotes } from "@/lib/pricing/feed";
import { FALLBACK_PRICES } from "@/lib/scout/revenue";
import { SMOOTH_DELAY_MS, smoothChunk } from "@/lib/ai/stream-chunking";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = "claude-opus-5";
/** Research is many small tool calls: searches, page reads, Hunter lookups. */
const MAX_STEPS = 30;

/**
 * The Enrich chat's turn: Orion researching one target. Its own route, like
 * the admin chat, because the catalog is different (web, Hunter, the card's
 * save tools) and scoped to the target in the body. Outsiders get the 404
 * the pages give. Every tool runs inside `runAsOrion`, so even a tool that
 * somehow reached Gmail could not write to it.
 */
export async function POST(req: Request): Promise<Response> {
  if (!(await isPlatformAdmin())) return new Response("Not found", { status: 404 });

  const { messages, targetNo }: { messages: UIMessage[]; targetNo?: number } = await req.json();
  if (typeof targetNo !== "number" || !Number.isInteger(targetNo)) {
    return Response.json({ error: "targetNo required" }, { status: 400 });
  }

  const quotes = await getCommodityQuotes().catch(() => []);
  const prices = {
    oilPerBbl: quotes.find((q) => q.label === "WTI")?.price ?? FALLBACK_PRICES.oilPerBbl,
    gasPerMcf: quotes.find((q) => q.label === "Nat Gas")?.price ?? FALLBACK_PRICES.gasPerMcf,
  };
  const [target, research, contacts] = await Promise.all([
    getTarget(targetNo, prices),
    getTargetResearch(targetNo),
    getTargetContacts(targetNo),
  ]);
  if (!target) return Response.json({ error: "not a target" }, { status: 404 });
  // The P-5 record and officers, from the same read Recon's dossier makes.
  const profile = await getOperatorProfile(targetNo).catch(() => null);

  const system = buildEnrichSystemPrompt(
    { target, p5: profile?.operator ?? null, officers: profile?.officers ?? [], research, contacts },
    new Date()
  );
  const tools = enrichTools(targetNo);
  const asOrion = Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const execute = t.execute as ((...args: unknown[]) => unknown) | undefined;
      return [name, execute ? { ...t, execute: (...args: unknown[]) => runAsOrion(() => execute(...args)) } : t];
    })
  ) as typeof tools;

  const turnId = crypto.randomUUID().slice(0, 8);
  const result = streamText({
    model: anthropic(MODEL),
    system,
    messages: await convertToModelMessages(messages),
    tools: asOrion,
    // Research is tool calls and short judgements; medium keeps the thinking
    // phase from dominating each of the many steps (see CLAUDE.md on Opus 5).
    providerOptions: { anthropic: { effort: "medium", cacheControl: { type: "ephemeral" } } },
    stopWhen: stepCountIs(MAX_STEPS),
    experimental_transform: smoothStream({ delayInMs: SMOOTH_DELAY_MS, chunking: smoothChunk }),
    onFinish: ({ usage, steps }) => {
      console.info("admin-enrich:turn", {
        turnId,
        targetNo,
        steps: steps.length,
        tools: steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    },
  });

  return createUIMessageStreamResponse({ stream: result.toUIMessageStream() });
}
