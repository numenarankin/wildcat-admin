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
import { adminTools } from "@/lib/ai/admin/tools";
import { googleTools } from "@/lib/ai/admin/google-tools";
import { draftTools } from "@/lib/ai/admin/draft-tools";
import { prospectingTools } from "@/lib/ai/admin/prospecting-tools";
import { dbTools } from "@/lib/ai/admin/db-tools";
import { taskTools } from "@/lib/ai/admin/task-tools";
import { webTools } from "@/lib/ai/admin/web-tools";
import { fileTools } from "@/lib/ai/admin/file-tools";
import { runAsOrion } from "@/lib/admin/google/orion-guard";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { buildAdminSystemPrompt } from "@/lib/ai/admin/system-prompt";
import { getAdminProjectContext } from "@/lib/admin/project-context";
import { listCustomers } from "@/lib/admin/customers";
import { SMOOTH_DELAY_MS, smoothChunk } from "@/lib/ai/stream-chunking";
import { appendToUserTurn, pageContextNote } from "@/lib/ai/admin/page-context-note";

export const runtime = "nodejs";
// An approved enrich_target runs a whole research pass inside one turn
// (`enrich-run.ts`), the same budget the Enrich chat's route has.
export const maxDuration = 300;

const MODEL = "claude-opus-5";
const MAX_STEPS = 10;

/**
 * Every tool runs inside `runAsOrion`, so the Google fetch layer refuses any
 * Gmail write it attempts, however it got there (`orion-guard.ts`).
 */
function asOrion<T extends Record<string, { execute?: (...args: never[]) => unknown }>>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute as ((...args: unknown[]) => unknown) | undefined;
    out[name] = execute ? { ...t, execute: (...args: unknown[]) => runAsOrion(() => execute(...args)) } : t;
  }
  return out as T;
}

/**
 * The admin Orion's turn. Its own route, not a mode of /api/chat: the two
 * assistants hand the model different catalogs, and a route that chose
 * between them per request would be one condition away from handing a
 * customer the business. The gate is the same answer the pages give an
 * outsider, a 404. No credit gate or metering: this is Wildcat's own use,
 * not a customer org's, and metering it would bill whichever workspace the
 * admin happens to belong to.
 */
export async function POST(req: Request): Promise<Response> {
  if (!(await isPlatformAdmin())) return new Response("Not found", { status: 404 });

  const {
    messages,
    folderId,
    pageContext,
  }: { messages: UIMessage[]; folderId?: string; pageContext?: string } = await req.json();
  const turnId = crypto.randomUUID().slice(0, 8);
  // `folderId` is the shared chat surface's project field; here it names an
  // admin project. Read through RLS, so an id that is not one comes back null
  // and the turn runs unscoped.
  const [customers, project, google] = await Promise.all([
    listCustomers(),
    folderId ? getAdminProjectContext(folderId) : Promise.resolve(null),
    getGoogleSettings(),
  ]);
  // The caller's own Google, read only, for the services they connected.
  const connected = google && !google.needsReauth ? google.services : [];
  const system = buildAdminSystemPrompt(customers, new Date(), project ?? undefined);

  // Where the user is rides the CURRENT user turn, not the system prompt: it
  // changes on every navigation, and in `system` it would break the cached
  // prefix. Once the turn is history it is frozen with the page it came from.
  const modelMessages = await convertToModelMessages(messages);
  if (typeof pageContext === "string" && pageContext.trim()) {
    appendToUserTurn(modelMessages, pageContextNote(pageContext));
  }

  const result = streamText({
    model: anthropic(MODEL),
    system,
    messages: modelMessages,
    tools: asOrion({ ...adminTools(), ...googleTools(connected), ...draftTools(), ...prospectingTools(), ...dbTools(),
      ...taskTools(),
      ...webTools({
        search: "Use it for anything outside Wildcat's own data: a company, a person, news, prices, regulations. In the objective say what should rank first and what facts to pull.",
        read: "Use it to read a result in full before quoting it.",
      }),
      ...fileTools(),
    }),
    // Business questions are a tool call and a sentence; the thinking phase
    // is what costs the wall clock here (see CLAUDE.md on Opus 5 effort).
    providerOptions: { anthropic: { effort: "medium", cacheControl: { type: "ephemeral" } } },
    stopWhen: stepCountIs(MAX_STEPS),
    experimental_transform: smoothStream({ delayInMs: SMOOTH_DELAY_MS, chunking: smoothChunk }),
    onFinish: ({ usage, steps }) => {
      console.info("admin-orion:turn", {
        turnId,
        steps: steps.length,
        tools: steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    },
  });

  return createUIMessageStreamResponse({ stream: result.toUIMessageStream() });
}
