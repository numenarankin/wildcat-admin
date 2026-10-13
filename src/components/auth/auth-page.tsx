"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPassword } from "@/components/auth/forgot-password";
import { useAuthActions } from "@/components/auth/auth-actions";
import { Spokes } from "@/components/ui/spokes";

/**
 * The admin app's sign-in. The customer app's `AuthPage` with sign-up and
 * referrals taken out: staff accounts are created from Settings > Team, never
 * here. "forgot" is a second view rather than its own route, as there.
 */
type Mode = "signin" | "forgot";

/**
 * Where to land after sign-in: the `next` path the proxy stashed when it
 * bounced an unauthenticated request here, or home. Validated to a same-origin
 * relative path to avoid an open redirect.
 */
function safeNext(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//") && next !== "/auth") {
    return next;
  }
  return "/";
}

export function AuthPage({ initialMode }: { initialMode?: Mode } = {}) {
  const actions = useAuthActions();
  const [mode, setMode] = useState<Mode>(initialMode ?? "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await actions.signIn(email, password);
      // Hard navigation so the fresh session cookie is on the next request and
      // the proxy lets us through.
      actions.navigate(safeNext());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  if (mode === "forgot") {
    return (
      <AuthShell
        title="Reset your password"
        subtitle="We'll email you a link to set a new one."
        pane="forgot"
      >
        <ForgotPassword
          onBack={() => {
            setMode("signin");
            setError(null);
          }}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to WildcatIQ Admin." pane="signin">
      <form onSubmit={handleSubmit} className="space-y-3">
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
            placeholder="you@wildcatiq.ai"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">Password</span>
            <button
              type="button"
              onClick={() => {
                setMode("forgot");
                setShowPassword(false);
                setError(null);
              }}
              className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Forgot password?
            </button>
          </div>
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
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

        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        <Button type="submit" className="h-11 w-full" disabled={loading}>
          {loading && <Spokes data-icon="inline-start" />}
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
