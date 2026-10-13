"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthShell } from "@/components/auth/auth-shell";
import { useAuthActions } from "@/components/auth/auth-actions";
import { Spokes } from "@/components/ui/spokes";

interface AcceptInviteProps {
  /** Raw invite token from the URL; re-validated server-side on submit. */
  token: string;
  /** Invited email. Fixed by the invite, shown read-only. */
  email: string;
  /**
   * This address already has a WildcatIQ account, so the invite adds the admin
   * side rather than creating an account. Nothing is asked for. The server
   * decides this for itself, so a forged `false` only produces a form whose
   * submit is refused.
   */
  hasAccount?: boolean;
}

/**
 * Admin team onboarding: the customer app's `AcceptInvite`, cut down for an
 * internal tool. The invitee sets a password and nothing else; their name is
 * the one the inviter typed. On submit the accept route creates the account
 * and the roster row; we then establish the browser session and land in the app.
 */
export function AcceptInvite({ token, email, hasAccount = false }: AcceptInviteProps) {
  const actions = useAuthActions();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const joinedExisting = await actions.acceptInvite({ token, password, fallbackEmail: email });
      // Hard navigation so the fresh session cookie is on the next request.
      actions.navigate(joinedExisting ? "/auth" : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Join the admin team"
      subtitle={
        hasAccount
          ? "The admin side is being added to the account you already have."
          : "Choose a password to finish setting up your account."
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Email</span>
          <Input type="email" value={email} readOnly disabled className="h-11" />
        </label>

        {!hasAccount && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Password</span>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                autoFocus
                required
                minLength={6}
                className="h-11 pr-11"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                tabIndex={-1}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
              >
                {showPassword ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </button>
            </div>
          </label>
        )}

        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        <Button type="submit" className="h-11 w-full" disabled={loading}>
          {loading && <Spokes data-icon="inline-start" />}
          Join team
        </Button>
      </form>
    </AuthShell>
  );
}
