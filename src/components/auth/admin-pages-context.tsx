"use client";

/**
 * Client-side access to the pages the signed-in admin may open.
 *
 * The `(admin)` layout resolves the list server-side
 * (`getPlatformAdminAccess` in `@/lib/auth/platform-admin`) and feeds it here.
 * The sidebar reads it to draw only the pages on the list.
 *
 * UI selection only. `requireAdminPage` on every page and the proxy are the
 * real enforcement.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { AdminPageKey } from "@/lib/admin/pages";

const AdminPagesContext = createContext<ReadonlySet<AdminPageKey>>(new Set());

export function AdminPagesProvider({ pages, children }: { pages: AdminPageKey[]; children: ReactNode }) {
  return <AdminPagesContext.Provider value={new Set(pages)}>{children}</AdminPagesContext.Provider>;
}

/** The pages the current admin may open. */
export function useAdminPages(): ReadonlySet<AdminPageKey> {
  return useContext(AdminPagesContext);
}
