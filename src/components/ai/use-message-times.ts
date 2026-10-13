"use client";

import { useRef } from "react";
import type { UIMessage } from "ai";
import { messageCreatedAt } from "@/lib/ai/conversations";

/**
 * When each message in the transcript was written.
 *
 * A saved message carries its own timestamp (hydration puts the row's
 * `created_at` on the message), but a message in the CURRENT turn has not been
 * saved yet and has none. Stamping those at render time would be wrong twice
 * over: the clock would tick forward on every re-render, and a streaming answer
 * would keep re-dating itself as it arrived.
 *
 * So a live message is stamped ONCE, the first time it is seen, and held. The
 * ref survives re-renders and dies with the conversation, which is exactly the
 * lifetime wanted — once the thread is saved and reloaded, the database value
 * takes over and this is never consulted for it again.
 */
export function useMessageTimes(): (message: UIMessage) => number {
  const seen = useRef(new Map<string, number>());

  return (message: UIMessage) => {
    const stored = messageCreatedAt(message);
    if (stored !== null) return stored;
    const first = seen.current.get(message.id);
    if (first !== undefined) return first;
    const now = Date.now();
    seen.current.set(message.id, now);
    return now;
  };
}
