import "server-only";

import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { withDerivedFacilityName } from "@/lib/notifications/facility-name";

/** One in-app notification as seen by the bell/toast client. */
export interface NotificationRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
  in_app: boolean;
}

export interface NotificationSeed {
  /** The 20 most recent in-app rows for this user, newest first. */
  items: NotificationRow[];
  /** Exact count of the user's unread in-app rows (not capped at 20). */
  unreadCount: number;
}

const RECENT_LIMIT = 20;

/**
 * Seed data for the notification bell, fetched in the server layout so the bell
 * paints correctly with no loading flash. RLS scopes both queries to the signed-
 * in user; only in-app rows are surfaced (email-only rows never reach the bell).
 */
export async function getRecentNotifications(): Promise<NotificationSeed> {
  const empty: NotificationSeed = { items: [], unreadCount: 0 };
  if (!hasSupabase()) return empty;

  try {
    const sb = await getSupabaseServer();
    const [{ data }, { count }] = await Promise.all([
      sb
        .from("notifications")
        .select("id, type, payload, read_at, created_at, in_app")
        .eq("in_app", true)
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT),
      sb
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("in_app", true)
        .is("read_at", null),
    ]);
    // Tanks and meters name themselves from their lease and number; the stored
    // payload cannot. See `withDerivedFacilityName` — it is a no-op for every
    // other row, so this costs nothing on a normal bell.
    const items = await Promise.all(
      ((data ?? []) as NotificationRow[]).map(async (row) => ({
        ...row,
        payload: await withDerivedFacilityName(sb, row.payload ?? {}),
      }))
    );
    return { items, unreadCount: count ?? 0 };
  } catch (error) {
    console.error("getRecentNotifications failed", error);
    return empty;
  }
}
