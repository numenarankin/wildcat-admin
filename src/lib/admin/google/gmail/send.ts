import "server-only";
import { googleFetch } from "@/lib/admin/google/fetch";
import { GMAIL_BASE } from "@/lib/admin/google/gmail/client";

/**
 * Gmail messages.send, apart from the readers in `client.ts` so that nothing
 * Orion loads can reach it (`lib/ai/admin/no-send.test.ts` walks the admin
 * chat route's imports). Its only caller is the composer's Send action.
 */
export async function sendMessage(userId: string, raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
  return googleFetch<{ id: string; threadId: string }>(userId, "gmail", `${GMAIL_BASE}messages/send`, {
    method: "POST",
    // `threadId` puts a reply in its thread; the headers do the rest.
    json: threadId ? { raw, threadId } : { raw },
  });
}
