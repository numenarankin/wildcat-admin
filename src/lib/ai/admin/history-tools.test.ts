import { describe, expect, it, vi } from "vitest";

/*
 * Two past admin chats: one about Roil Operating's renewal, one about the
 * pricing page. A search for the renewal must find the first, and both reads
 * must hit the admin tables, never the customer ones.
 */
const tablesRead: string[] = [];
const rows: Record<string, Record<string, unknown>[]> = {
  admin_conversations: [
    { id: "c1", title: "Roil renewal", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" },
    { id: "c2", title: "Pricing page copy", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" },
  ],
  admin_messages: [
    { conversation_id: "c1", role: "user", position: 0, parts: [{ type: "text", text: "Roil Operating wants annual billing at renewal. Offer two months free." }] },
    { conversation_id: "c1", role: "assistant", position: 1, parts: [{ type: "text", text: "Noted: annual at renewal, two months free." }] },
    { conversation_id: "c2", role: "user", position: 0, parts: [{ type: "text", text: "Rewrite the pricing headline." }] },
  ],
};

function builder(table: string) {
  tablesRead.push(table);
  let data = rows[table] ?? [];
  const b = {
    select: () => b,
    order: () => b,
    eq: (col: string, v: unknown) => ((data = data.filter((r) => r[col === "conversation_id" ? "conversation_id" : col] === v)), b),
    in: (col: string, vs: unknown[]) => ((data = data.filter((r) => vs.includes(r[col]))), b),
    maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
    then: (ok: (v: { data: unknown; error: null }) => unknown) => ok({ data, error: null }),
  };
  return b;
}
vi.mock("@/lib/env", () => ({ hasSupabase: () => true }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServer: async () => ({ from: (t: string) => builder(t) }) }));

describe("admin chat history tools", () => {
  it("finds the earlier chat about a subject, reading only the admin tables", async () => {
    const { historyTools } = await import("./history-tools");
    const { search_chat_history, read_conversation } = historyTools();
    const found = (await search_chat_history.execute!({ query: "Roil renewal annual billing" }, { toolCallId: "t", messages: [] })) as {
      hits: { conversationId: string; text: string }[];
    };
    expect(found.hits[0].conversationId).toBe("c1");
    expect(found.hits.map((h) => h.conversationId)).not.toContain("c2");

    const full = (await read_conversation.execute!({ conversationId: "c1" }, { toolCallId: "t", messages: [] })) as {
      conversation: { title: string; transcript: string };
    };
    expect(full.conversation.title).toBe("Roil renewal");
    expect(full.conversation.transcript).toContain("Assistant: Noted: annual at renewal, two months free.");

    expect(new Set(tablesRead)).toEqual(new Set(["admin_conversations", "admin_messages"]));
  });
});
