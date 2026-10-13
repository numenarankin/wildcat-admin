"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { wildcatAppUrl } from "@/lib/wildcat-app-url";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { buildInApp } from "@/lib/notifications/in-app";
import {
  needsDerivedName,
  withDerivedFacilityName,
} from "@/lib/notifications/facility-name";
import { showNotificationToast } from "@/components/notifications/toast";
import type { NotificationRow } from "@/lib/notifications/recent";

/**
 * App-wide in-app notification channel: the second consumer (after email) of the
 * `notifications` rows. Seeds from the server layout, subscribes to Supabase
 * Realtime for the signed-in user, fires a bottom-right toast on each new in-app
 * row, and backs the header bell. Preference opt-out is applied at enqueue in SQL
 * (an in-app-muted type never creates an `in_app` row), so this layer trusts the
 * `in_app` flag it receives and does no per-type filtering of its own.
 */

const RECENT_LIMIT = 20;

interface NotificationsContextValue {
  items: NotificationRow[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(
  null
);

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error(
      "useNotifications must be used within a NotificationsProvider"
    );
  }
  return ctx;
}

export function NotificationsProvider({
  userId,
  initialItems,
  initialUnread,
  children,
}: {
  userId: string;
  initialItems: NotificationRow[];
  initialUnread: number;
  children: React.ReactNode;
}) {
  const [items, setItems] = useState<NotificationRow[]>(initialItems);
  const [unreadCount, setUnreadCount] = useState(initialUnread);

  // Keep a live ref to items so the realtime UPDATE handler (registered once)
  // and the mark-read callbacks can read current state without re-subscribing
  // or re-creating on every change. Synced in an effect (updating a ref during
  // render is disallowed); handlers fire asynchronously, after the ref is set.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Every notification names a page in the customer app.
  const navigate = useCallback(
    (href: string) => window.location.assign(wildcatAppUrl(href)),
    []
  );

  // Re-fetch the recent slice + exact unread count. Called on reconnect, since
  // INSERTs during a dropped socket are missed by the live listener.
  const refetch = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    const [{ data }, { count }] = await Promise.all([
      supabase
        .from("notifications")
        .select("id, type, payload, read_at, created_at, in_app")
        .eq("in_app", true)
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("in_app", true)
        .is("read_at", null),
    ]);
    if (data) setItems(data as NotificationRow[]);
    setUnreadCount(count ?? 0);
  }, []);

  /** Land one row in the list, bump the count, and raise its toast. */
  const show = useCallback(
    (row: NotificationRow) => {
      setItems((prev) => {
        if (prev.some((n) => n.id === row.id)) return prev; // de-dupe echoes
        return [row, ...prev].slice(0, RECENT_LIMIT);
      });
      if (!row.read_at) setUnreadCount((n) => n + 1);

      const info = buildInApp(row.type, row.payload);
      if (info) showNotificationToast(info, navigate);
    },
    [navigate]
  );

  const onInsert = useCallback(
    (row: NotificationRow) => {
      if (!row.in_app) return; // email-only row; nothing to show in-app
      // A comment on a tank or a meter arrives carrying the retired stored
      // name. Deriving it costs one read, so only that case waits for it;
      // everything else shows in the same tick it arrives.
      if (!needsDerivedName(row.payload ?? {})) {
        show(row);
        return;
      }
      void withDerivedFacilityName(getSupabaseBrowser(), row.payload ?? {})
        .then((payload) => show({ ...row, payload }))
        .catch(() => show(row));
    },
    [show]
  );

  const onUpdate = useCallback((row: NotificationRow) => {
    // Sync read state across tabs/devices.
    const existing = itemsRef.current.find((n) => n.id === row.id);
    if (!existing) return;
    if (existing.read_at === row.read_at) return;
    setItems((prev) =>
      prev.map((n) => (n.id === row.id ? { ...n, read_at: row.read_at } : n))
    );
    if (!existing.read_at && row.read_at) {
      setUnreadCount((n) => Math.max(0, n - 1));
    } else if (existing.read_at && !row.read_at) {
      setUnreadCount((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabaseBrowser();
    let subscribedOnce = false;
    let cancelled = false;

    // Register the postgres_changes listeners SYNCHRONOUSLY, before any await.
    // Realtime requires all `.on()` bindings to be added before `subscribe()`,
    // and creating the channel up front guarantees cleanup can remove it. If we
    // deferred creation into the async block, a mount/unmount/remount (React
    // StrictMode in dev) would run cleanup while `channel` was still null,
    // leaking a subscribed channel; the next mount would reuse it and throw
    // "cannot add postgres_changes callbacks ... after subscribe()".
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => onInsert(payload.new as NotificationRow)
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => onUpdate(payload.new as NotificationRow)
      );

    (async () => {
      // Ensure the realtime socket carries the user's access token so RLS
      // authorizes the channel; without it the channel connects but delivers
      // nothing. Skip subscribing if we unmounted while awaiting the session.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }

      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // Self-heal missed rows after a (re)connect, but skip the first
          // subscribe since the server seed is already fresh.
          if (subscribedOnce) void refetch();
          subscribedOnce = true;
        }
      });
    })();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, onInsert, onUpdate, refetch]);

  const markRead = useCallback((id: string) => {
    const existing = itemsRef.current.find((n) => n.id === id);
    if (!existing || existing.read_at) return;
    const readAt = new Date().toISOString();
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: readAt } : n))
    );
    setUnreadCount((n) => Math.max(0, n - 1));
    void getSupabaseBrowser()
      .from("notifications")
      .update({ read_at: readAt })
      .eq("id", id)
      .then(({ error }) => {
        if (error) console.error("markRead failed", error);
      });
  }, []);

  const markAllRead = useCallback(() => {
    const readAt = new Date().toISOString();
    const hadUnread = itemsRef.current.some((n) => !n.read_at);
    setItems((prev) =>
      prev.map((n) => (n.read_at ? n : { ...n, read_at: readAt }))
    );
    setUnreadCount(0);
    if (!hadUnread) return;
    void getSupabaseBrowser()
      .from("notifications")
      .update({ read_at: readAt })
      .eq("in_app", true)
      .is("read_at", null)
      .then(({ error }) => {
        if (error) console.error("markAllRead failed", error);
      });
  }, []);

  const value = useMemo(
    () => ({ items, unreadCount, markRead, markAllRead }),
    [items, unreadCount, markRead, markAllRead]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}
