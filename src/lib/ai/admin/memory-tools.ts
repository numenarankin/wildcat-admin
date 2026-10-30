import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { loadAdminDocs, MEMORY_CHAR_CAP, saveAdminDoc } from "./memory";

/**
 * The admin asking Orion to remember something now, rather than waiting for
 * the reflection pass. A write, so the admin approves the exact sentence
 * first. It lands in the same MEMORY document the reflection pass maintains.
 */
export function memoryTools() {
  return {
    remember: tool({
      description:
        "Keep a durable fact or preference in your memory for every future chat, when the admin asks you to remember something (\"remember that...\", \"from now on...\"). One plain sentence about who or what, never a figure that will change (look those up). It waits for the admin's approval.",
      inputSchema: z.object({ fact: z.string().min(1).max(400).describe("the fact, as one short sentence") }),
      needsApproval: true,
      execute: async ({ fact }) => {
        const docs = await loadAdminDocs();
        const line = `- ${fact.trim().replace(/^[-*]\s*/, "")}`;
        const next = docs.memory.trim() ? `${docs.memory.trim()}\n${line}` : line;
        if (next.length > MEMORY_CHAR_CAP) {
          return { ok: false, error: `Memory is full (${MEMORY_CHAR_CAP} characters). Nothing was saved; the reflection pass consolidates it over the next chats.` };
        }
        await saveAdminDoc("memory", next, { updatedBy: "user", rationale: "asked to remember" });
        return { ok: true, remembered: line.slice(2) };
      },
    }),
  };
}
