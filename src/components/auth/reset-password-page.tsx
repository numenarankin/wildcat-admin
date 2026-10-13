"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthShell } from "@/components/auth/auth-shell";
import { useAuthActions } from "@/components/auth/auth-actions";
import {
  MIN_PASSWORD_LENGTH,
  passwordProblem,
} from "@/lib/auth/recovery-core";
import { Spokes } from "@/components/ui/spokes";

/**
 * The landing page for an emailed reset link.
 *
 * The link carries Supabase's hashed recovery token. Redeeming it with
 * `verifyOtp` is what mints the short-lived session that `updateUser` then needs
 * — so the token has to be spent on arrival, before the user has typed
 * anything. That is why an expired link is reported here rather than at submit:
 * by the time the form is visible, the hard part already succeeded.
 */

type Stage = "verifying" | "expired" | "ready" | "done";

export function ResetPasswordPage({ tokenHash }: { tokenHash: string | null }) {
  const actions = useAuthActions();
  // No token means there is nothing to verify, so that is the opening state
  // rather than a transition an effect has to fire on mount.
  const [stage, setStage] = useState<Stage>(tokenHash ? "verifying" : "expired");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // React runs effects twice in development's strict mode. The second run would
  // present an already-spent token and report a valid link as expired.
  const redeemed = useRef(false);

  useEffect(() => {
    if (!tokenHash || redeemed.current) return;
    redeemed.current = true;

    void (async () => {
      if (!(await actions.verifyResetToken(tokenHash))) {
        setStage("expired");
        return;
      }
      // Drop the token from the address bar so it does not linger in history,
      // in a screenshot, or in the Referer of anything this page loads next.
      window.history.replaceState(null, "", "/auth/reset");
      setStage("ready");
    })();
  }, [tokenHash, actions]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }

    setSaving(true);
    try {
      await actions.setPassword(password);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set your password.");
    } finally {
      setSaving(false);
    }
  }

  if (stage === "verifying") {
    return (
      <AuthShell
        title="One moment"
        subtitle="Checking your reset link."
        pane={stage}
        brand={false}
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spokes className="size-4" />
          Verifying
        </div>
      </AuthShell>
    );
  }

  if (stage === "expired") {
    return (
      <AuthShell
        title="This link has expired"
        subtitle="Reset links last an hour and work only once."
        pane={stage}
      >
        <div className="space-y-6">
          <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            We&apos;ll email you a fresh one right away.
          </p>
          <Button
            className="h-11 w-full"
            onClick={() => actions.navigate("/auth?mode=forgot")}
          >
            Send a new link
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (stage === "done") {
    return (
      <AuthShell
        title="Password updated"
        subtitle="You're signed in with your new password."
        pane={stage}
      >
        <div className="space-y-6">
          <div className="flex items-start gap-3 rounded-lg bg-muted px-3 py-3 text-sm text-muted-foreground">
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              Use it next time you sign in. Any other device stays signed in
              until its session runs out.
            </span>
          </div>
          {/* Hard navigation so the fresh session cookie is sent on the next
              request and the proxy lets us through. */}
          <Button
            className="h-11 w-full"
            onClick={() => actions.navigate("/")}
          >
            Continue to WildcatIQ
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Then you're back in."
      pane={stage}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">New password</span>
          <Input
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={MIN_PASSWORD_LENGTH}
            className="h-11"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <span className="text-xs text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Confirm new password</span>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            className="h-11"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
          />
        </label>

        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="h-11 w-full" disabled={saving}>
          {saving && (
            <Spokes data-icon="inline-start" />
          )}
          Set new password
        </Button>
      </form>
    </AuthShell>
  );
}
