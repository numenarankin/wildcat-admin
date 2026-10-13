"use client";

/**
 * Client-side access to the signed-in user's early-access flag.
 *
 * The root layout resolves it server-side (`@/lib/auth/early-access`) and feeds
 * the boolean here; the sidebar and any early-access UI read it via
 * {@link useEarlyAccess} or gate JSX with {@link EarlyAccessOnly}.
 *
 * This drives UI hiding only — the server guards in `@/lib/auth/early-access`
 * are the real enforcement.
 */

import { createContext, useContext, type ReactNode } from "react";

const EarlyAccessContext = createContext<boolean>(false);

export function EarlyAccessProvider({
  earlyAccess,
  children,
}: {
  earlyAccess: boolean;
  children: ReactNode;
}) {
  return (
    <EarlyAccessContext.Provider value={earlyAccess}>
      {children}
    </EarlyAccessContext.Provider>
  );
}

/** True when the current user is in the early-access cohort. */
export function useEarlyAccess(): boolean {
  return useContext(EarlyAccessContext);
}

/** Render `children` only for early-access users. */
export function EarlyAccessOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useEarlyAccess() ? <>{children}</> : <>{fallback}</>;
}
