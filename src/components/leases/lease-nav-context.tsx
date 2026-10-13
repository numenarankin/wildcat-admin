"use client";

/**
 * The lease → facilities tree the root layout read for the sidebar's Leases
 * flyout, so the first hover shows the list instead of fetching it. Null when
 * the layout had nothing (no permission, read failed): the flyout then loads
 * on hover as it always did. Refreshed whenever the layout renders, which is
 * every page load and every `router.refresh()` a facility write triggers.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { LeaseNavLease } from "@/lib/leases/nav-tree";

const LeaseNavContext = createContext<LeaseNavLease[] | null>(null);

export function LeaseNavProvider({
  tree,
  children,
}: {
  tree: LeaseNavLease[] | null;
  children: ReactNode;
}) {
  return (
    <LeaseNavContext.Provider value={tree}>{children}</LeaseNavContext.Provider>
  );
}

export function useLeaseNavTree(): LeaseNavLease[] | null {
  return useContext(LeaseNavContext);
}
