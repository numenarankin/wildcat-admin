"use client";

/**
 * Client-side access to the signed-in user's effective permissions.
 *
 * The root layout resolves the permissions server-side (see
 * `@/lib/auth/permissions`) and feeds the already-expanded list here. Components
 * read it via {@link usePermissions}/{@link useCan} or gate JSX with {@link Can}.
 * This drives UI hiding only — the database RLS is the real enforcement.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PermissionKey } from "@/lib/settings/org";

const PermissionsContext = createContext<ReadonlySet<PermissionKey>>(new Set());

export function PermissionsProvider({
  permissions,
  children,
}: {
  permissions: PermissionKey[];
  children: ReactNode;
}) {
  const set = useMemo(() => new Set(permissions), [permissions]);
  return (
    <PermissionsContext.Provider value={set}>
      {children}
    </PermissionsContext.Provider>
  );
}

/** The full set of effective permission keys for the current user. */
export function usePermissions(): ReadonlySet<PermissionKey> {
  return useContext(PermissionsContext);
}

/** True if the user holds any of the given permission(s). */
export function useCan(permission: PermissionKey | PermissionKey[]): boolean {
  const set = usePermissions();
  const wanted = Array.isArray(permission) ? permission : [permission];
  return wanted.some((p) => set.has(p));
}

/**
 * Render `children` only when the user holds (any of) `permission`; otherwise
 * render `fallback` (default: nothing). Use to hide buttons/sections inline.
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: PermissionKey | PermissionKey[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(permission) ? <>{children}</> : <>{fallback}</>;
}
