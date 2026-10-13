/**
 * Curated, always-in-context memory for a project's agent (Tier 1
 * of the project agent's memory; the on-demand transcript tools are Tier 2).
 *
 * One evolving summary per project, regenerated from the prior memory + the
 * latest conversation after each turn. This is what lets the project agent feel
 * like it already knows the project "second-hand" — without stuffing every raw
 * message into context, and without RAG's lossy top-k recall for what is really
 * a continuity/state problem.
 *
 * MISSION-CRITICAL bias handling: conversation history is full of speculation
 * and hopeful framing. The summariser is instructed to TYPE every item as
 * established (grounded in project data) vs provisional (discussed/hypothesised)
 * and to never promote a hypothesis to fact. The project page prompt then
 * treats provisional memory as provisional. This keeps memory from amplifying
 * confirmation bias. Project memory is also isolated from the platform-wide
 * `agent_memory` (user-level facts) — it never crosses projects or into the
 * global agent.
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";

const MEMORY_MODEL = "claude-opus-5";

interface MessageRow {
  role: string;
  parts: { type?: string; text?: string }[] | null;
}

/** Flatten a stored message's text parts. */
function messageToText(m: MessageRow): string {
  return (m.parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join(" ")
    .trim();
}

/** The current project memory summary, or "" if none yet. */
export async function getProjectMemory(folderId: string): Promise<string> {
  if (!hasSupabase()) return "";
  const sb = await getSupabaseServer();
  const { data } = await sb
    .from("project_memory")
    .select("content")
    .eq("folder_id", folderId)
    .maybeSingle();
  return data?.content ?? "";
}

const SUMMARISER_SYSTEM = `You maintain the working memory of an oil & gas \
project's analysis assistant. You are given the existing project \
memory and the most recent conversation, and you produce an updated memory \
document. This memory is injected into the assistant's context so it remembers \
the project across chats.

This is mission-critical: the memory must NOT become a vehicle for optimism or \
confirmation bias. Follow these rules exactly:
- TYPE every item. Only list something under "Established (grounded in data)" \
if the conversation shows it was confirmed against the project's actual files/\
data. Everything else — ideas, interpretations, hopes, leads — goes under \
"Provisional / hypotheses" and must be phrased as provisional.
- NEVER promote a hypothesis to an established fact. If the conversation merely \
discussed or assumed something, it stays provisional.
- Preserve durable items from the existing memory; integrate the new \
conversation; move resolved questions to decisions/established; drop nothing \
important. Record negative results and ruled-out ideas explicitly — they matter \
as much as positive ones.
- Be concise and neutral. No promotional language. Keep it under ~350 words.

Output in this exact section structure (omit a section only if truly empty):

## Working model
(1–3 sentence neutral synopsis of the current technical picture.)

## Established (grounded in project data)
- ...

## Decisions & directions
- ...

## Open questions
- ...

## Provisional / hypotheses (NOT established)
- ...

## Ruled out / negative results
- ...`;

/**
 * Regenerate the project memory from the existing memory + the most recently
 * updated conversation in the folder. Cheap (one summary + one transcript) and
 * bounded regardless of total project history. No-op if there's nothing to
 * summarise. Best-effort: callers fire-and-forget and log failures.
 */
export async function refreshProjectMemory(folderId: string): Promise<void> {
  if (!hasSupabase()) return;
  const sb = await getSupabaseServer();

  // The latest conversation in this project — the turn we just finished.
  const { data: conv } = await sb
    .from("conversations")
    .select("id, title")
    .eq("folder_id", folderId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) return;

  const { data: msgs } = await sb
    .from("messages")
    .select("role, parts, position")
    .eq("conversation_id", conv.id)
    .order("position", { ascending: true });

  const transcript = (msgs ?? [])
    .map((m) => {
      const text = messageToText(m as MessageRow);
      if (!text) return "";
      const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
      return `${who}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
  if (!transcript) return;

  const existing = await getProjectMemory(folderId);

  const { text: updated } = await generateText({
    model: anthropic(MEMORY_MODEL),
    system: SUMMARISER_SYSTEM,
    prompt: `Existing project memory:\n${existing || "(none yet)"}\n\n---\n\nMost recent conversation (titled "${conv.title}"):\n${transcript}\n\n---\n\nProduce the updated project memory.`,
  });

  const content = updated.trim();
  if (!content) return;

  const { error } = await sb
    .from("project_memory")
    .upsert({ folder_id: folderId, content }, { onConflict: "folder_id" });
  if (error) throw new Error(`refreshProjectMemory: ${error.message}`);
}
