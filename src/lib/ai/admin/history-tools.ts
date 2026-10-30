import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { readConversation, searchChatHistory, type HistoryTables } from "@/lib/ai/chat-history";

/**
 * The admin Orion's own past chats: the customer Orion's search_chat_history
 * and read_conversation over `admin_conversations` / `admin_messages`. Read
 * through RLS as the signed-in admin, so it is only ever their own history
 * (the Enrich chats on Prospecting included).
 */

const ADMIN_TABLES: HistoryTables = { conversations: "admin_conversations", messages: "admin_messages" };

export function historyTools() {
  return {
    search_chat_history: tool({
      description:
        "Search this admin's past Orion chats for what was discussed or decided before: a customer, a prospect, a plan, a number someone quoted. Ranked over every conversation, best first, with the snippets that match and each conversation's id and date. A wide query is relaxed to its distinctive terms and the result says so. Then read_conversation for the full exchange. Past chats are context, not current figures: re-check any number with a tool.",
      inputSchema: z.object({
        query: z.string().min(1).describe("the subject, in plain words (a name on its own works best)"),
        limit: z.number().int().min(1).max(30).optional().describe("snippets to return, default 10"),
      }),
      execute: async ({ query, limit }) => searchChatHistory(query, limit ?? 10, null, ADMIN_TABLES),
    }),
    read_conversation: tool({
      description:
        "Read one past chat in full, role-labelled, by the conversation id search_chat_history returned. Use it before relying on a snippet.",
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) => ({ conversation: await readConversation(conversationId, ADMIN_TABLES) }),
    }),
  };
}
