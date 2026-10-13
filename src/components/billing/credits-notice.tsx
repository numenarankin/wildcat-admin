"use client";

import { CreditCard01 } from "@untitledui/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useCredits } from "@/components/billing/credits-context";

/**
 * The org cannot currently pay for an AI call.
 *
 * True on a zero OR NEGATIVE balance — overage drives it below zero, and a
 * negative balance is the case most worth catching, because the user has
 * already been charged for work they may not realise happened.
 *
 * Also true once a call has been refused this session (`exhausted`), which
 * covers the window between spending the last credit and the page reloading
 * with a fresh balance.
 */
export function useAiCreditsBlocked(): boolean {
  const { credits, exhausted } = useCredits();
  return credits <= 0 || exhausted;
}

/**
 * Tell the user their balance is spent, and sell them the fix in the same
 * breath.
 *
 * Rendered in two places by design:
 *
 *  - BEFORE the action, so nobody picks a file, waits, and only then learns
 *    they were never going to get an answer.
 *  - AFTER a refusal, where the file is already stored and a top-up is the only
 *    thing between the user and their result.
 *
 * Shared rather than written per surface: an out-of-credits dead end with no
 * button is a revenue leak, and the way that keeps happening is each new
 * surface inventing its own error string.
 */
export function AiCreditsNotice({
  /** "before" softens the copy to a heads-up; "after" states what was blocked. */
  variant = "before",
  /** What the user was trying to do, e.g. "read this invoice". */
  action,
  className,
}: {
  variant?: "before" | "after";
  action: string;
  className?: string;
}) {
  const { credits, openBuyCredits } = useCredits();
  const blocked = useAiCreditsBlocked();
  if (!blocked) return null;

  // A negative balance is a different message from an empty one: the work was
  // already done and billed, so "top up to continue" would understate it.
  const negative = credits < 0;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-[0.15rem] border bg-muted/40 p-4 text-center",
        className
      )}
    >
      <p className="text-sm font-medium">
        {negative
          ? "Your AI credit balance is negative"
          : "You’re out of AI credits"}
      </p>
      <p className="max-w-sm text-xs text-muted-foreground">
        {negative
          ? `Your organization is ${Math.abs(credits).toLocaleString()} credits overdrawn, so Orion can’t ${action}. Settling the balance restores it.`
          : variant === "before"
            ? `Orion can’t ${action} until your organization tops up.`
            : `Nothing was lost — the file is stored. Top up to ${action} without re-uploading.`}
      </p>
      <Button size="sm" onClick={openBuyCredits}>
        <CreditCard01 className="size-4" />
        Buy AI credits
      </Button>
    </div>
  );
}
