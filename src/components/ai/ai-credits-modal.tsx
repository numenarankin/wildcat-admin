"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import {
  chargeTopUp,
  estimateTopUpTax,
  listPaymentMethods,
} from "@/lib/billing/actions";
import type { PaymentMethodInfo } from "@/lib/billing/payment-methods";

interface TaxQuote {
  subtotalCents: number;
  /** Cents the org's platform credit will cover (referral rewards). */
  creditCents: number;
  taxCents: number;
  /** What the card is actually charged, after credit. */
  totalCents: number;
}

/** Cents -> "$1,234.56". */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cardLabel(pm: PaymentMethodInfo): string {
  return `${titleCase(pm.brand)} •••• ${pm.last4}`;
}

interface AiCreditsModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Dollar amount to open with. Settings picks one from its preset buttons
   * before opening this, so arriving here with the field already filled in is
   * the point: the modal confirms the purchase rather than restarting it.
   */
  initialAmount?: number;
}

export function AiCreditsModal({
  open,
  onClose,
  initialAmount,
}: AiCreditsModalProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loadingCards, setLoadingCards] = useState(false);
  const [methods, setMethods] = useState<PaymentMethodInfo[]>([]);
  const [methodId, setMethodId] = useState<string>("");
  const [amount, setAmount] = useState(
    initialAmount != null ? String(initialAmount) : "50"
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ credits: number; credited: boolean } | null>(
    null
  );
  const [quote, setQuote] = useState<TaxQuote | null>(null);

  // Re-seed the amount each time the modal opens, so reopening it after picking
  // a different preset shows the new one rather than the last one bought. Done
  // during render (not an effect) to avoid a cascading render, matching the
  // other dialogs in the app.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAmount(initialAmount != null ? String(initialAmount) : "50");
      setLoadingCards(true);
      setError(null);
      setSuccess(null);
      setQuote(null);
    }
  }

  // Lazily load the org's cards when the modal opens (avoids a Stripe round-trip
  // on every page that renders the header). The state this resets is cleared in
  // the open transition above rather than here: a setState in an effect body
  // costs a second render pass, and this one runs on every open.
  useEffect(() => {
    if (!open) return;
    let active = true;
    listPaymentMethods()
      .then((list) => {
        if (!active) return;
        setMethods(list);
        const preferred = list.find((m) => m.isDefault) ?? list[0];
        setMethodId(preferred?.id ?? "");
      })
      .catch(() => {
        if (active) setError("Couldn't load your payment methods.");
      })
      .finally(() => {
        if (active) setLoadingCards(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const usd = Number(amount);

  // Subtotal is known instantly (mirrors the server's rounding), so the breakdown
  // renders immediately; tax + total stay as skeletons until the quote lands and
  // matches the current amount.
  const subtotalCents = Math.max(0, Math.round(Number.isFinite(usd) ? usd : 0)) * 100;
  const quoteMatches = !!quote && quote.subtotalCents === subtotalCents;
  const creditCents = quoteMatches ? quote!.creditCents : 0;
  // Platform credit is spent before the card, so when it covers the whole
  // purchase no PaymentIntent is created and no card is needed — which is why
  // the buy button must NOT require one in that case.
  const paidByCredit =
    quoteMatches && subtotalCents > 0 && quote!.totalCents === 0;
  // True once BOTH unknowns have resolved: which cards exist, and whether
  // credit covers the whole amount. Everything that would otherwise render a
  // guess waits on this.
  const methodResolved = !loadingCards && (quoteMatches || !(usd > 0));
  const canBuy =
    !pending &&
    Number.isFinite(usd) &&
    usd > 0 &&
    quoteMatches &&
    (paidByCredit || methodId.length > 0);

  // Quote sales tax (debounced) so the breakdown updates as the amount changes.
  // The charge recomputes tax authoritatively, so a slightly stale quote is fine.
  useEffect(() => {
    if (!open || success) return;
    // A stale quote is simply hidden below (the breakdown/total render is gated
    // on usd > 0), so there's nothing to clear synchronously here.
    if (!(Number.isFinite(usd) && usd > 0)) return;
    let active = true;
    // No debounce for the FIRST quote of this open: the payment method and the
    // button both wait on it, and making them wait 400ms is what produced a
    // visible flash from "Visa ••••" to "Platform credit". Later edits stay
    // debounced so typing an amount doesn't spam the server.
    const timer = setTimeout(
      () => {
        estimateTopUpTax(usd)
          .then((q) => {
            if (active) setQuote(q);
          })
          .catch(() => {
            if (active) setQuote(null);
          });
      },
      quote === null ? 0 : 400
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // `quote` is read only to pick the delay; re-running on every quote change
    // is harmless because the effect no-ops once the quote matches the amount.
  }, [usd, open, success, quote]);

  function buy() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await chargeTopUp(usd, methodId || undefined);
        setSuccess({ credits: res.credits, credited: res.credited });
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      title="Buy AI credits"
      description={
        paidByCredit
          ? "Covered by your platform credit, so no card will be charged."
          : "Top up your AI credit balance."
      }
      className={cn(
        "transition-[max-width] duration-500 ease-out",
        success && "max-w-sm"
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {success ? (
          <SuccessView
            key="success"
            credits={success.credits}
            credited={success.credited}
            onDone={onClose}
          />
        ) : (
          <motion.div
            key="form"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col gap-4 px-5 py-5"
          >
            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Amount to spend
          </span>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              $
            </span>
            <Input
              className="h-10 pl-7 font-mono"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="50"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Payment method
          </span>
          {!methodResolved ? (
            // Neither a card nor "Platform credit" until the quote says which.
            // Showing a card here and swapping it a moment later reads as a bug.
            <div className="h-10 animate-pulse rounded-md border bg-muted/30" />
          ) : paidByCredit ? (
            <div className="flex h-10 items-center rounded-md border bg-muted/30 px-3 text-sm">
              Platform credit
            </div>
          ) : (
          <Select
            value={methodId}
            onValueChange={(v) => setMethodId(v ?? "")}
            disabled={loadingCards || methods.length === 0}
          >
            <SelectTrigger className="h-10 w-full">
              <SelectValue>
                {(value) => {
                  const pm = methods.find((m) => m.id === value);
                  if (pm) {
                    return `${cardLabel(pm)}${pm.isDefault ? " (default)" : ""}`;
                  }
                  return loadingCards
                    ? "Loading cards…"
                    : methods.length === 0
                      ? "No cards on file"
                      : "Select a card";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {methods.map((pm) => (
                <SelectItem key={pm.id} value={pm.id}>
                  {cardLabel(pm)}
                  {pm.isDefault ? " (default)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
          {methodResolved && !paidByCredit && methods.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Add a card on the Billing tab to buy credits.
            </span>
          )}
        </label>

        {usd > 0 && (
          <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span className="tabular-nums">{money(subtotalCents)}</span>
            </div>
            {creditCents > 0 && (
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Platform credit</span>
                <span className="tabular-nums">-{money(creditCents)}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Sales tax</span>
              {quoteMatches ? (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="tabular-nums"
                >
                  {money(quote!.taxCents)}
                </motion.span>
              ) : (
                <span className="inline-block h-4 w-12 animate-pulse rounded bg-muted-foreground/20" />
              )}
            </div>
            <div className="mt-1 flex items-center justify-between border-t pt-1.5 font-semibold">
              <span>Total</span>
              {quoteMatches ? (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="tabular-nums"
                >
                  {money(quote!.totalCents)}
                </motion.span>
              ) : (
                <span className="inline-block h-4 w-16 animate-pulse rounded bg-muted-foreground/20" />
              )}
            </div>
          </div>
        )}

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="button" size="lg" disabled={!canBuy} onClick={buy}>
            {pending && <Loader2Icon className="size-4 animate-spin" />}
            {usd > 0 && !quoteMatches
              ? "Continue"
              : paidByCredit
                ? `Use ${money(subtotalCents)} credit`
                : `Pay ${usd > 0 ? money(quote!.totalCents) : "$0"}`}
          </Button>
        </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SwipeUpModal>
  );
}

/** Animated confirmation shown after a successful top-up. */
function SuccessView({
  credits,
  credited,
  onDone,
}: {
  credits: number;
  credited: boolean;
  onDone: () => void;
}) {
  return (
    <motion.div
      key="success"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col items-center gap-4 px-6 pb-7 pt-9 text-center"
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.05 }}
        className="flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      >
        <CheckIcon className="size-7" strokeWidth={3} />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.25 }}
        className="flex flex-col gap-1.5"
      >
        <p className="text-base font-semibold">Payment received</p>
        <p className="text-sm text-muted-foreground">
          {credited ? (
            <>
              <span className="font-semibold text-foreground tabular-nums">
                {credits.toLocaleString()}
              </span>{" "}
              AI credits have been added to your account.
            </>
          ) : (
            "Your credits will appear in your account shortly."
          )}
        </p>
      </motion.div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="mt-1"
      >
        <Button type="button" size="lg" onClick={onDone}>
          Done
        </Button>
      </motion.div>
    </motion.div>
  );
}
