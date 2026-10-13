import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { normalizeEmailDraft } from "@/lib/admin/google/gmail/draft-spec";

/**
 * `draft_email`: Orion writes into the New Message card on /email. It returns
 * a directive and does nothing else: no Gmail call, no draft saved, no send.
 * The chat applies the directive to the composer in the user's browser
 * (`usePageActionDispatch`), and only the user's own click on Send sends.
 * See `lib/admin/google/gmail/draft-spec.ts` and `orion-guard.ts`.
 */
export function draftTools() {
  return {
    draft_email: tool({
      description:
        "Write a draft into the New Message card on the Email page, for the user to review and send themselves. " +
        "You CANNOT send email, ever; do not say you sent or will send anything. Fields you leave out keep what the user already typed; " +
        "body replaces the body. If the user is not on the Email page the draft waits there until they open it; tell them so. " +
        "Write the body as plain text, blank lines between paragraphs, no markdown. Their saved signature is added under the body automatically, so never write a sign-off with their name or contact details.",
      inputSchema: z.object({
        to: z.string().optional().describe("Recipients, comma separated: name <email> or bare email."),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional().describe("Plain text body; blank lines separate paragraphs."),
      }),
      execute: async (input) => ({ ok: true as const, directive: normalizeEmailDraft(input) }),
    }),
  };
}
