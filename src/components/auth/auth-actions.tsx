"use client";

import { createContext, useContext } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import {
  accountExists,
  recoverEmail,
  requestPasswordReset,
  sendRecoveredReset,
  notifyPasswordReset,
} from "@/lib/auth/account-recovery";

/**
 * Everything the signed-out screens do to the outside world, behind one
 * interface. The customer app's version also signs people up and changes
 * emails; the admin app does neither. Staff join by accepting an invite sent
 * from Settings > Team, so here there is sign-in, accepting an invite and
 * password recovery. All of it against the shared Supabase project: the same
 * auth the customer app signs into.
 */
export interface AuthActions {
  /** Sign in an existing user. Throws on failure. */
  signIn(email: string, password: string): Promise<void>;
  /**
   * Accept an admin invite: create the account with `password` and sign in.
   * Resolves `true` when the address already had an account, which then
   * joined as it is and has to sign in with the password it already has.
   */
  acceptInvite(input: { token: string; password: string; fallbackEmail: string }): Promise<boolean>;
  /** Spend a recovery token. `false` means expired or already used. */
  verifyResetToken(tokenHash: string): Promise<boolean>;
  /** Set a new password on the session the token opened, and notify the owner. */
  setPassword(password: string): Promise<void>;
  /** End the session. */
  signOut(): Promise<void>;

  requestPasswordReset: typeof requestPasswordReset;
  recoverEmail: typeof recoverEmail;
  sendRecoveredReset: typeof sendRecoveredReset;

  /**
   * Leave for another page. A hard navigation, because the fresh session
   * cookie has to be on the next request or the proxy bounces it back to
   * `/auth`.
   */
  navigate(path: string): void;
}

/**
 * Turn GoTrue's `Invalid login credentials` into which half was wrong, as the
 * customer app does.
 */
async function describeSignInFailure(email: string, message: string): Promise<Error> {
  if (!/invalid login credentials/i.test(message)) return new Error(message);
  const exists = await accountExists(email).catch(() => null);
  if (exists === false) {
    return new Error(`There's no account for ${email.trim()}. Check the address.`);
  }
  if (exists === true) {
    return new Error("That password doesn't match this account. Try again, or reset it below.");
  }
  return new Error("That email and password don't match an account.");
}

export const defaultAuthActions: AuthActions = {
  async signIn(email, password) {
    const { error } = await getSupabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) throw await describeSignInFailure(email, error.message);
  },

  async acceptInvite({ token, password, fallbackEmail }) {
    const res = await fetch("/api/auth/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const result = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      email?: string;
      error?: string;
      existingAccount?: boolean;
    };
    if (!res.ok || !result.ok) {
      throw new Error(result.error ?? "Could not accept the invite.");
    }
    // They joined with the account they already had: no password to sign in
    // with here (the form never asked for one).
    if (result.existingAccount) return true;
    const { error } = await getSupabaseBrowser().auth.signInWithPassword({
      email: result.email ?? fallbackEmail,
      password,
    });
    if (error) throw error;
    return false;
  },

  async verifyResetToken(tokenHash) {
    const { error } = await getSupabaseBrowser().auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });
    return !error;
  },

  async setPassword(password) {
    const { error } = await getSupabaseBrowser().auth.updateUser({ password });
    if (error) throw error;
    await notifyPasswordReset();
  },

  async signOut() {
    await getSupabaseBrowser().auth.signOut();
  },

  requestPasswordReset,
  recoverEmail,
  sendRecoveredReset,

  navigate(path) {
    window.location.assign(path);
  },
};

const AuthActionsContext = createContext<AuthActions>(defaultAuthActions);

export const AuthActionsProvider = AuthActionsContext.Provider;

export function useAuthActions(): AuthActions {
  return useContext(AuthActionsContext);
}
