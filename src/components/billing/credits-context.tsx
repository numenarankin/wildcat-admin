"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { AiCreditsModal } from "@/components/ai/ai-credits-modal";

/**
 * App-wide access to the org's AI credit balance and the "Buy AI credits"
 * modal. Rendering the modal once here (instead of per-consumer) lets any
 * surface open it: the account dropdown's "Buy more" button and Orion's
 * out-of-credits upsell both call `openBuyCredits()`.
 *
 * `exhausted` latches when an AI route refuses a call for lack of credits (HTTP
 * 402). It's the client-side pre-flight signal: while set, chat send is diverted
 * to the buy modal instead of hitting the API again. A fresh positive balance
 * (after a top-up refresh) clears it.
 */
interface CreditsContextValue {
  /** Current org AI credit balance (server-provided; 0 when unconfigured). */
  credits: number;
  /** True once an AI call was refused for lack of credits this session. */
  exhausted: boolean;
  /** Latch the out-of-credits state (call when a route returns 402/no_credits). */
  markExhausted: () => void;
  /** Open the "Buy AI credits" modal. */
  openBuyCredits: () => void;
}

const CreditsContext = createContext<CreditsContextValue | null>(null);

export function useCredits(): CreditsContextValue {
  const ctx = useContext(CreditsContext);
  if (!ctx) {
    throw new Error("useCredits must be used within a CreditsProvider");
  }
  return ctx;
}

export function CreditsProvider({
  credits,
  children,
}: {
  credits: number;
  children: React.ReactNode;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  // Clear the latch when a fresh positive balance arrives (e.g. after a top-up +
  // router.refresh feeds a new `credits` prop). Adjusting state during render on
  // a prop change is the recommended pattern over a setState-in-effect.
  const [prevCredits, setPrevCredits] = useState(credits);
  if (credits !== prevCredits) {
    setPrevCredits(credits);
    if (credits > 0) setExhausted(false);
  }

  const openBuyCredits = useCallback(() => setModalOpen(true), []);
  const markExhausted = useCallback(() => setExhausted(true), []);

  return (
    <CreditsContext.Provider
      value={{ credits, exhausted, markExhausted, openBuyCredits }}
    >
      {children}
      <AiCreditsModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </CreditsContext.Provider>
  );
}

/**
 * Whether an error thrown by the chat transport is the credit gate's 402. The
 * transport throws `new Error(await response.text())`, so the message carries
 * our JSON body `{ error: "ai_unavailable", reason: "no_credits" }`. Matched
 * defensively (parse first, substring fallback) since it's an off-the-wire shape.
 */
export function isOutOfCreditsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message) return false;
  try {
    const parsed = JSON.parse(message) as {
      error?: unknown;
      reason?: unknown;
    };
    if (parsed?.error === "ai_unavailable") return true;
    if (parsed?.reason === "no_credits") return true;
  } catch {
    // Not JSON; fall through to a substring check.
  }
  return message.includes("ai_unavailable") || message.includes("no_credits");
}
