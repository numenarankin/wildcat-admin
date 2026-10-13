"use client";

/**
 * Client-side access to whether the signed-in user is a platform admin.
 *
 * The root layout resolves it server-side (`@/lib/auth/platform-admin`) and
 * feeds the boolean here. The shell reads it to decide which navigation to
 * draw on an /admin path: without it, an outsider's 404 at /admin/anything
 * would be framed by the admin sidebar, which is exactly what the 404 exists
 * to hide.
 *
 * UI selection only. The server guard in `@/lib/auth/platform-admin` is the
 * real enforcement.
 */

import { createContext, useContext, type ReactNode } from "react";

const PlatformAdminContext = createContext<boolean>(false);

export function PlatformAdminProvider({
  platformAdmin,
  children,
}: {
  platformAdmin: boolean;
  children: ReactNode;
}) {
  return (
    <PlatformAdminContext.Provider value={platformAdmin}>
      {children}
    </PlatformAdminContext.Provider>
  );
}

/** True when the current user is on the platform admin list. */
export function usePlatformAdmin(): boolean {
  return useContext(PlatformAdminContext);
}
