"use client";

import { describeAIError } from "@/lib/ai/errors";

/**
 * Browser-side Orion failure logging.
 *
 * `useChat` surfaces a failed turn as an `error` object and nothing else: no
 * console output, no request id, no indication of which surface or conversation
 * it came from. A user reporting "Orion stopped working" had nothing to send us
 * and we had nothing to search for.
 *
 * The server puts a short turn id in the `x-orion-turn-id` response header and
 * repeats it in the user-visible message ("… (ref a1b2c3d4)"), so the same id
 * appears here, in the red box on screen, and in the server log for the turn.
 * Grep the server logs for that id to get the full provider detail.
 */

export interface OrionErrorContext {
  /** Which chat surface: the full page or the side drawer. */
  surface: "orion-page" | "drawer";
  conversationId: string;
  /** Project chat, when inside one. */
  folderId?: string;
  /** How many messages were in the thread when it failed. */
  messageCount?: number;
}

/** Pull the `(ref xxxxxxxx)` the server appended, if it survived. */
export function turnIdFromMessage(message: string): string | undefined {
  return /\(ref ([0-9a-f]{8})\)/.exec(message)?.[1];
}

/**
 * What goes in the red box.
 *
 * Both surfaces used to render a fixed "Orion is having trouble responding"
 * regardless of what actually happened, throwing away the server's explanation
 * AND the turn id — so a screenshot told us nothing. Prefer the server's message
 * whenever it carries a ref (it is already written for a non-technical reader
 * and ends in the id); otherwise fall back to the generic line, since a raw SDK
 * message is not something to show a pumper.
 */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (turnIdFromMessage(message)) return message;
  return "Orion is having trouble responding right now. Please try again in a moment.";
}

export function logOrionClientError(
  err: unknown,
  ctx: OrionErrorContext
): void {
  const detail = describeAIError(err);
  const turnId = turnIdFromMessage(detail.message);

  // A collapsed group: one line in the console until it's clicked open, so a
  // failure is obvious without burying whatever else the user was debugging.
  console.groupCollapsed(
    `%corion:error%c ${turnId ? `ref ${turnId} ` : ""}${detail.message}`,
    "background:#b42318;color:#fff;padding:1px 4px;border-radius:3px",
    "color:inherit"
  );
  console.error("context", { ...ctx, turnId, at: new Date().toISOString() });
  console.error("error", detail);
  if (detail.stack) console.error("stack", detail.stack);
  console.info(
    turnId
      ? `Server logs: search for "${turnId}" to get the provider request id and full error.`
      : "No turn id on this error — it failed before the server responded (network, or the request never left the browser)."
  );
  console.groupEnd();
}
