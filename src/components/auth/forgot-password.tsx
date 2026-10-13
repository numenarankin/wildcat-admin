"use client";

import { useState, useTransition } from "react";
import { MailCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useAuthActions } from "@/components/auth/auth-actions";
import { hasUsableQuery, type RecoveryMatch } from "@/lib/auth/recovery-core";
import { Spokes } from "@/components/ui/spokes";
import { AnimatePresence } from "framer-motion";
import { SwipeUp } from "@/components/ui/swipe-up";

/**
 * The signed-out recovery panel, shown in place of the sign-in form.
 *
 * Two steps, because forgetting a password and forgetting which address you
 * used are different problems: the first pane takes an email and sends a link,
 * the second finds the address by company name or phone and offers to send the
 * link there without ever showing it in full.
 *
 * Everything here is deliberately unable to tell the user whether an account
 * exists — the "check your inbox" confirmation is the same for an address we
 * mailed and one we did not.
 */

type Step = "email" | "find" | "sent";

/** Format a US phone as it is typed, matching the Settings profile field. */
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length === 0) return "";
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const actions = useAuthActions();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [matches, setMatches] = useState<RecoveryMatch[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Which match's "Send link" is in flight. One shared `pending` would spin
  // every button on the panel at once, including the search button that is not
  // doing anything — so the spinner has to name the row it belongs to.
  const [sendingToken, setSendingToken] = useState<string | null>(null);

  function handleSendToEmail(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const { throttled } = await actions.requestPasswordReset(email);
      if (throttled) {
        setError("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      setNotice(
        `If an account uses ${email.trim()}, a reset link is on its way. Check your inbox and spam folder.`
      );
      setStep("sent");
    });
  }

  function handleFind(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMatches(null);
    // The action already refuses an empty query, but it refuses it by returning
    // no matches — which would render as "nothing matched that", blaming the
    // data for a form the user has not filled in yet.
    if (!hasUsableQuery(company, phone)) {
      setError("Enter a company name or a full phone number.");
      return;
    }
    startTransition(async () => {
      const result = await actions.recoverEmail({ company, phone });
      if (result.throttled) {
        setError("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      setMatches(result.matches);
    });
  }

  function handleSendToMatch(match: RecoveryMatch) {
    setError(null);
    setSendingToken(match.token);
    startTransition(async () => {
      const result = await actions.sendRecoveredReset(match.token);
      setSendingToken(null);
      if (result.throttled) {
        setError("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      if (!result.ok) {
        // The handle expired while the panel sat open. Searching again mints a
        // fresh one, so that is the instruction rather than a dead end.
        setError("That link expired. Search again to send a new one.");
        setMatches(null);
        return;
      }
      setNotice(
        `A reset link is on its way to ${match.maskedEmail}. Check your inbox and spam folder.`
      );
      setStep("sent");
    });
  }

  // A finished search: the form has served its purpose and is replaced by its
  // answer.
  const hasResults = matches !== null && matches.length > 0;

  if (step === "sent") {
    // The same arrival the verification wall uses: this is the same moment in
    // the same story — the mail is out, go and look at your inbox.
    return (
      <AnimatePresence mode="wait">
        <SwipeUp key="sent" className="space-y-6">
          <div className="flex items-start gap-3 rounded-lg bg-muted px-3 py-3 text-sm text-muted-foreground">
            <MailCheckIcon className="mt-0.5 size-4 shrink-0" />
            <span>{notice}</span>
          </div>
          <Button variant="outline" className="h-11 w-full" onClick={onBack}>
            Back to sign in
          </Button>
        </SwipeUp>
      </AnimatePresence>
    );
  }

  return (
    /*
      Sideways, not upward: searching and then reading the answer is a move
      forward through one screen, so the form leaves to the left as its results
      arrive from the right. `mode="wait"` keeps the two from overlapping, which
      matters here because they are different heights.
    */
    <AnimatePresence mode="wait">
      <SwipeUp
        key={`${step}-${hasResults}`}
        direction="left"
        className="space-y-6"
      >
        {step === "email" ? (
          <form onSubmit={handleSendToEmail} className="space-y-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Email</span>
              <Input
                type="email"
                autoComplete="email"
                required
                autoFocus
                className="h-11"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </label>

            {error && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="h-11 w-full" disabled={pending}>
              {pending && (
                <Spokes data-icon="inline-start" />
              )}
              Send reset link
            </Button>
          </form>
        ) : hasResults ? (
          /* Once there are matches the search is finished, so the form and its
             button go away rather than sitting under the answer inviting another
             run. "Search again" brings them back. */
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {matches!.length === 1 ? "Found this account:" : "Found these accounts:"}
            </p>
            {/*
              Ordered best-first by the lookup, so the top row is the one we think
              they want — given the same accent as the recommended operator on the
              onboarding match step, since it is the same "this is probably you"
              claim being made.
            */}
            {matches!.map((match, i) => (
              <div
                key={match.token}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-[0.15rem] border px-3 py-2.5",
                  i === 0
                    ? "border-data-accent bg-data-accent/10"
                    : "border-border bg-card"
                )}
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{match.maskedEmail}</p>
                  {match.company && (
                    <p className="truncate text-xs text-muted-foreground">
                      {match.company}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => handleSendToMatch(match)}
                >
                  {sendingToken === match.token && (
                    <Spokes data-icon="inline-start" />
                  )}
                  Send link
                </Button>
              </div>
            ))}

            {error && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={() => {
                setMatches(null);
                setError(null);
              }}
              className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80"
            >
              Search again
            </button>
          </div>
        ) : (
          <form onSubmit={handleFind} className="space-y-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Company name</span>
              <Input
                className="h-11"
                autoFocus
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Acme Energy"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Or phone number</span>
              <Input
                type="tel"
                className="h-11"
                value={phone}
                onChange={(e) => setPhone(formatPhone(e.target.value))}
                placeholder="(555) 555-5555"
              />
            </label>

            {error && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="h-11 w-full" disabled={pending}>
              {pending && (
                <Spokes data-icon="inline-start" />
              )}
              Find my email
            </Button>

            {matches !== null && matches.length === 0 && (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                Nothing matched that. Try the company name exactly as it appears on
                your account, or the phone number on your profile.
              </p>
            )}
          </form>
        )}

        <p className="text-sm text-muted-foreground">
          {step === "email" ? (
            <>
              Don&apos;t remember your email?{" "}
              <button
                type="button"
                onClick={() => {
                  setStep("find");
                  setError(null);
                  setMatches(null);
                }}
                className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
              >
                Look it up
              </button>
            </>
          ) : (
            <>
              Remembered it?{" "}
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setError(null);
                  setMatches(null);
                }}
                className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
              >
                Enter your email
              </button>
            </>
          )}
        </p>

        <p className="text-sm text-muted-foreground">
          <button
            type="button"
            onClick={onBack}
            className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Back to sign in
          </button>
        </p>
      </SwipeUp>
    </AnimatePresence>
  );
}
