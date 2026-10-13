"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { fetchAndPrint } from "@/lib/export/download";

/**
 * Print the open conversation.
 *
 * This used to be `window.print()` over the chat DOM with a `@media print`
 * block in globals.css. That could only ever produce a picture of a chat
 * window: viewport-clipped, screen-styled, charts at whatever size the layout
 * happened to give them. The document is now built server-side
 * (`/api/ai/conversations/<id>/pdf`) from the same message structures the
 * screen reads, and THAT is what gets printed — real type, the WildcatIQ
 * letterhead, page numbers, charts redrawn from their specs.
 *
 * Still a print, not a download. `fetchAndPrint` pulls the bytes, loads them
 * into an offscreen iframe and opens the print dialog on that, so the user
 * stays on the page and "Save as PDF" is still right there in the dialog if
 * that is what they wanted.
 *
 * The conversation has to be SAVED first: the route renders from the database,
 * not from what is mounted in the browser. That is deliberate — it puts the
 * whole thread on paper rather than only the part React is holding — but it
 * means the caller must gate the control on a non-empty conversation.
 *
 * Failures are surfaced. On the old path a permission failure was simply an
 * unstyled printout; here a 403 or a 500 is a toast, because a button that
 * silently does nothing reads as a broken app.
 */
export function usePrintConversation(): {
  printConversation: (id: string) => Promise<void>;
  printing: boolean;
} {
  const [printing, setPrinting] = useState(false);

  const printConversation = useCallback(
    async (id: string) => {
      if (printing) return;
      setPrinting(true);
      try {
        await fetchAndPrint(`/api/ai/conversations/${id}/pdf`);
      } catch (error) {
        console.error("Conversation print failed", error);
        const status =
          error instanceof Error && /\((\d{3})\)/.exec(error.message)?.[1];
        toast.error(
          status === "403"
            ? "You do not have permission to print this conversation."
            : status === "404"
              ? "This conversation has not been saved yet."
              : "Could not build the document. Please try again."
        );
      } finally {
        setPrinting(false);
      }
    },
    [printing]
  );

  return { printConversation, printing };
}
