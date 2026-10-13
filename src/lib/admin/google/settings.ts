import "server-only";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasGoogle } from "@/lib/env";
import { getGoogleConnection } from "@/lib/admin/google/connections";
import type { GoogleService } from "@/lib/admin/google/oauth";

/** What Settings > Connections shows: the caller's own Google connection. */
export interface GoogleSettings {
  configured: boolean;
  accountEmail: string | null;
  services: GoogleService[];
  needsReauth: boolean;
  /** False when nothing is connected. */
  connected: boolean;
}

/** Null when the connection could not be read. */
export async function getGoogleSettings(): Promise<GoogleSettings | null> {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return null;
  try {
    const conn = await getGoogleConnection(user.id);
    return {
      configured: hasGoogle(),
      accountEmail: conn?.accountEmail ?? null,
      services: conn?.services ?? [],
      needsReauth: conn?.status === "needs_reauth",
      connected: conn !== null,
    };
  } catch (error) {
    console.error("getGoogleSettings failed", error);
    return null;
  }
}
