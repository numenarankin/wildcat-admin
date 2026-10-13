"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spokes } from "@/components/ui/spokes";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import {
  confirmWellCapacityUpgrade,
  getWellCapacityPrompt,
  type TierUpgradePrompt,
} from "@/lib/billing/actions";

/**
 * The consent gate for a well that would move the org up a tier.
 *
 * A tier change is never automatic (docs/plans/billing-test-suite.md §The rule):
 * the action is refused, this states what saying yes costs, and confirming is
 * one act that raises the band AND completes the action the user was already
 * doing. Cancelling writes nothing and leaves their form exactly as typed.
 *
 * Usage, wrapping the write it guards:
 *
 *   const { guard, gate } = useTierUpgradeGate();
 *   await guard(() => createWell(info));
 *   ...
 *   {gate}
 *
 * `guard` returns null when the user declined, so a caller can tell "they said
 * no" from "it worked". The server-side cap (`assertWellCapacity`) still
 * refuses on its own; this is what turns that refusal into a way forward.
 */
export function useTierUpgradeGate() {
  const [prompt, setPrompt] = useState<TierUpgradePrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The confirm resolves the promise `guard` is waiting on, so the caller reads
  // as one straight-line await rather than a pair of callbacks.
  const decide = useRef<((ok: boolean) => void) | null>(null);

  const guard = useCallback(
    async <T,>(run: () => Promise<T>, adding = 1): Promise<T | null> => {
      const quote = await getWellCapacityPrompt(adding).catch(() => null);
      if (!quote) return run();

      setError(null);
      setPrompt(quote);
      const confirmed = await new Promise<boolean>((resolve) => {
        decide.current = resolve;
      });
      if (!confirmed) return null;

      setBusy(true);
      try {
        await confirmWellCapacityUpgrade(adding);
      } catch (err) {
        setBusy(false);
        setError(
          err instanceof Error ? err.message : "Could not change your plan."
        );
        return null;
      }
      setBusy(false);
      setPrompt(null);
      // The band is raised at this point. If the write below fails, the retry
      // is the write alone: `confirmWellCapacityUpgrade` refuses a band the
      // wells now fit, so nobody is charged twice for the same crossing.
      return run();
    },
    []
  );

  function close(confirmed: boolean) {
    if (busy) return;
    decide.current?.(confirmed);
    decide.current = null;
    if (!confirmed) setPrompt(null);
  }

  const gate = (
    <TierUpgradeDialog
      prompt={prompt}
      busy={busy}
      error={error}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  );

  return { guard, gate };
}

/**
 * Thrown by a caller whose contract has no way to say "the user declined" —
 * an inline picker that must resolve to the thing it created. Caught and logged
 * like any other failed create, which is exactly what a cancel should look like.
 */
export class TierUpgradeDeclined extends Error {
  constructor() {
    super("Plan upgrade declined.");
    this.name = "TierUpgradeDeclined";
  }
}

const money = (usd: number) => `$${Math.round(usd).toLocaleString()}`;

/** "per month" / "per year", the way the customer is billed. */
function per(interval: TierUpgradePrompt["interval"]): string {
  return interval === "year" ? "per year" : "per month";
}

/**
 * What the modal says. Facts only: the count, what the action changes, the two
 * prices, the difference, and when it is charged.
 *
 * The per-well band gets its own sentence because it is the one place the
 * customer agrees to future charges they will not be asked about again. Saying
 * so here is the only honest place to say it.
 */
export function tierUpgradeCopy(prompt: TierUpgradePrompt): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  const added = prompt.newWells - prompt.wells;
  const noun = added === 1 ? "This well" : `These ${added} wells`;
  const title =
    added === 1
      ? "Adding this well moves you to the next plan"
      : "Adding these wells moves you to the next plan";

  if (prompt.perWell) {
    return {
      title,
      body: `You have ${prompt.wells.toLocaleString()} wells. ${noun} takes you to ${prompt.newWells.toLocaleString()}, which moves you to per-well pricing: $10 per well ${per(
        prompt.interval
      )}, ${money(prompt.toUsd)} ${per(
        prompt.interval
      )} at ${prompt.newWells.toLocaleString()} wells. Each well you add after this costs $10 ${per(
        prompt.interval
      )} and is charged without asking again.`,
      confirmLabel: added === 1 ? "Upgrade and add well" : "Upgrade and add wells",
    };
  }

  return {
    title,
    body: `You have ${prompt.wells.toLocaleString()} wells, the most your plan covers. ${noun} moves you to the next plan. ${money(
      prompt.fromUsd
    )} to ${money(prompt.toUsd)} ${per(prompt.interval)}. The ${money(
      prompt.deltaUsd
    )} difference is charged pro rata for the rest of your ${
      prompt.interval === "year" ? "term" : "billing period"
    }.`,
    confirmLabel: added === 1 ? "Upgrade and add well" : "Upgrade and add wells",
  };
}

/** Rendered by {@link useTierUpgradeGate}; exported for the dev gallery. */
export function TierUpgradeDialog({
  prompt,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  prompt: TierUpgradePrompt | null;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!prompt) return null;
  const { title, body, confirmLabel } = tierUpgradeCopy(prompt);

  return (
    <SwipeUpModal
      open
      onClose={onCancel}
      title={title}
      description={body}
      elevated
    >
      <div className="px-5 pb-1">
        {error && <p className="text-sm text-error">{error}</p>}
        {!prompt.canUpgrade && (
          <p className="text-sm text-secondary-text">
            Ask an owner or admin to upgrade.
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-5 py-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {/* No confirm button for someone who would be refused: the action is
            admin-only, so offering it is an ad for a refusal. */}
        {prompt.canUpgrade && (
          <Button type="button" onClick={onConfirm} disabled={busy}>
            {busy && <Spokes data-icon="inline-start" />}
            {confirmLabel}
          </Button>
        )}
      </div>
    </SwipeUpModal>
  );
}
