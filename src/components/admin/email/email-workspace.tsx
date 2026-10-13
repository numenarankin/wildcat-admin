"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { EmailThreadList } from "@/components/admin/email/email-thread-list";
import { EmailTable } from "@/components/admin/email/email-table";
import { EmailToolbar } from "@/components/admin/email/email-toolbar";
import { EmailThread, type ThreadActions } from "@/components/admin/email/email-thread";
import { EmailCardLayer, type CardMode, type CardSpec } from "@/components/admin/email/email-card";
import { EmailComposeCard, type ComposeInit } from "@/components/admin/email/email-compose-card";
import { EmailSettingsView } from "@/components/admin/email/email-settings-view";
import type { EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { markGmailThreadRead, modifyGmailThread, trashGmailThread } from "@/lib/admin/google/gmail-actions";
import { fetchGmailThread, fetchGmailThreads } from "@/lib/admin/google/gmail/browser";
import { mergeRefreshedPage } from "@/lib/admin/google/gmail/view";
import { forwardQuote, forwardSubject, replyAllRecipients, replyQuote, replySubject } from "@/lib/admin/google/gmail/compose";
import type { EmailIndex } from "@/lib/admin/google/gmail/suggest";
import {
  GMAIL_FILTERS,
  type GmailFilter,
  type GmailMessageView,
  type GmailThreadPage,
  type GmailThreadSummary,
  type GmailThreadView,
} from "@/lib/admin/google/gmail/types";
import { usePageAction, usePageContextSlice } from "@/lib/ai/use-ai-context";
import { EMAIL_DRAFT_ACTION, type EmailDraftDirective } from "@/lib/admin/google/gmail/draft-spec";
import { emailListSlice, emailThreadSlice } from "@/lib/ai/admin/page-slices";

const CONNECTIONS = "Settings > Connections";

/** An error line, with "Settings > Connections" as the link to it when the message names it. */
export function EmailError({ message, connectionsHref }: { message: string; connectionsHref: string }) {
  const at = message.indexOf(CONNECTIONS);
  if (at < 0) return <>{message}</>;
  return (
    <>
      {message.slice(0, at)}
      <Link href={connectionsHref} className="underline underline-offset-2 hover:text-foreground">
        {CONNECTIONS}
      </Link>
      {message.slice(at + CONNECTIONS.length)}
    </>
  );
}

/** Rows whose full thread is fetched ahead of a click. */
const PREFETCH_THREADS = 10;
/** A list page this young is shown without asking Gmail again. */
const FRESH_MS = 60_000;
const PREFETCH_CONCURRENCY = 4;
const THREAD_CACHE_MAX = 150;

/** A read card's key: one per thread, so each minimized email keeps its tab. Drafts are c1, c2, … */
const readKey = (threadId: string) => `r:${threadId}`;

type CardRecord =
  | { key: string; kind: "read"; threadId: string; mode: CardMode }
  | { key: string; kind: "compose"; mode: CardMode; init: ComposeInit };

/** What has been fetched for a thread: the view, or why not. */
type Loaded = { thread: GmailThreadView | null; error: string | null };

function cacheKey(filter: GmailFilter, q: string): string {
  return `${filter}\u0000${q}`;
}

/**
 * /email: the agenda's top bar (`EmailToolbar`) over the inbox as a table
 * (arrival) or the support desk's split layout (list left, thread right).
 * Reading and writing happen in cards over the page (`EmailCardLayer`).
 * Opening an unread thread marks it read in Gmail. Coming back to the window
 * refreshes the list and the open thread.
 */
export function EmailWorkspace({
  initialPage,
  initialError,
  connectionsHref,
  initialSettings,
  accountEmail,
  initialIndex,
}: {
  initialPage: GmailThreadPage | null;
  initialError: string | null;
  connectionsHref: string;
  initialSettings: EmailSettings;
  /** The connected Gmail address: left out of Reply all. */
  accountEmail: string | null;
  initialIndex: EmailIndex;
}) {
  const [settings, setSettings] = useState(initialSettings);
  // The composer's autofill: who the admin has sent to and what subjects
  // they used. The page supplies it; a send re-reads it.
  const [index, setIndex] = useState<EmailIndex>(initialIndex);
  const loadIndex = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/google/gmail/index", { cache: "no-store" });
      if (res.ok) setIndex((await res.json()) as EmailIndex);
    } catch {
      // No autofill until the next load; composing works without it.
    }
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  // On arrival the inbox is a full-width table; a click there opens the
  // email in a card over its right side. The toolbar toggle switches to the
  // split view (list and reading pane).
  const [split, setSplit] = useState(false);
  const [threads, setThreads] = useState<GmailThreadSummary[]>(initialPage?.threads ?? []);
  const [nextPageToken, setNextPageToken] = useState<string | null>(initialPage?.nextPageToken ?? null);
  const [listError, setListError] = useState<string | null>(initialError);
  const [filter, setFilter] = useState<GmailFilter>("inbox");
  const [query, setQuery] = useState("");
  const [activeQ, setActiveQ] = useState("");
  const [pending, setPending] = useState(false);
  // The thread last clicked: the split view's pane, and what Orion is told about.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Every thread fetched for reading, by id; a card or the pane shows one.
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});

  // The cards over the page (`EmailCardLayer`): a read card per opened
  // email (table view only) and a draft per compose, in the order opened.
  // Cards stack where they overlap; a click brings one to the front. Each
  // draft's form lives in its own component, so a minimized draft keeps
  // its text.
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [composeTitles, setComposeTitles] = useState<Record<string, string>>({});
  const nextKey = useRef(0);
  const setMode = useCallback((key: string, mode: CardMode) => {
    setCards((prev) => prev.map((c) => (c.key === key ? { ...c, mode } : c)));
  }, []);
  const openCompose = useCallback((init: ComposeInit): string => {
    const key = `c${++nextKey.current}`;
    setCards((prev) => [...prev, { key, kind: "compose", mode: "open", init }]);
    return key;
  }, []);
  const openRead = useCallback((threadId: string) => {
    const key = readKey(threadId);
    setCards((prev) => {
      const existing = prev.find((c) => c.key === key);
      // Re-opening moves the card to the end: newest nearest the corner.
      return [
        ...prev.filter((c) => c.key !== key),
        existing ? { ...existing, mode: existing.mode === "min" ? "open" : existing.mode } : { key, kind: "read", threadId, mode: "open" },
      ];
    });
  }, []);
  const closeCard = useCallback((key: string) => {
    setCards((prev) => prev.filter((c) => c.key !== key));
  }, []);

  // Orion's `draft_email` fills the newest draft, or opens one; it never sends.
  const [draft, setDraft] = useState<{ key: string; nonce: number; directive: EmailDraftDirective } | null>(null);
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  });
  usePageAction<EmailDraftDirective>(EMAIL_DRAFT_ACTION, (directive) => {
    const target = [...cardsRef.current].reverse().find((c) => c.kind === "compose");
    const key = target?.key ?? openCompose({});
    if (target && target.mode === "min") setMode(key, "open");
    if (directive.subject !== undefined) setComposeTitles((prev) => ({ ...prev, [key]: directive.subject! }));
    setDraft((prev) => ({ key, nonce: (prev?.nonce ?? 0) + 1, directive }));
  });

  // Responses for a folder or search the user has since left are dropped.
  const listSeq = useRef(0);
  const loadingMore = useRef(false);
  // Pages loaded for the current folder and search; a refresh past page one merges.
  const pages = useRef(1);

  // Page one of every folder and search seen this visit, with when it was
  // fetched. Gmail allows 6,000 quota units a minute per user and one page
  // costs 26 calls (about 520 units), so a page younger than FRESH_MS is
  // shown as is, never fetched again.
  const [loadedAt] = useState(() => Date.now());
  const cache = useRef(
    new Map<string, { page: GmailThreadPage; at: number }>(
      initialPage ? [[cacheKey("inbox", ""), { page: initialPage, at: loadedAt }]] : []
    )
  );
  const isFresh = useCallback((key: string) => {
    const hit = cache.current.get(key);
    return hit !== undefined && Date.now() - hit.at < FRESH_MS;
  }, []);

  const load = useCallback(async (nextFilter: GmailFilter, q: string, force = false) => {
    const seq = ++listSeq.current;
    const key = cacheKey(nextFilter, q);
    const cached = cache.current.get(key)?.page;
    pages.current = 1;
    if (cached) {
      setThreads(cached.threads);
      setNextPageToken(cached.nextPageToken);
      setListError(null);
      setPending(false);
      if (!force && isFresh(key)) return;
    } else {
      setPending(true);
    }
    const res = await fetchGmailThreads({ filter: nextFilter, q });
    if (res.ok) cache.current.set(key, { page: res.data, at: Date.now() });
    if (seq !== listSeq.current) return;
    setPending(false);
    if (res.ok) {
      // More pages loaded while this refreshed: keep them.
      if (pages.current > 1) {
        const fresh = res.data.threads;
        setThreads((prev) => mergeRefreshedPage(fresh, prev));
      } else {
        setThreads(res.data.threads);
        setNextPageToken(res.data.nextPageToken);
      }
      setListError(null);
    } else if (!cached) {
      setThreads([]);
      setNextPageToken(null);
      setListError(res.error);
    }
  }, [isFresh]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore.current) return;
    loadingMore.current = true;
    const seq = listSeq.current;
    const res = await fetchGmailThreads({ filter, q: activeQ, pageToken: nextPageToken });
    loadingMore.current = false;
    if (seq !== listSeq.current) return;
    if (res.ok) {
      setThreads((prev) => {
        const ids = new Set(prev.map((t) => t.id));
        return [...prev, ...res.data.threads.filter((t) => !ids.has(t.id))];
      });
      setNextPageToken(res.data.nextPageToken);
      pages.current += 1;
    } else {
      setListError(res.error);
      setNextPageToken(null);
    }
  }, [filter, activeQ, nextPageToken]);

  // Full threads, prefetched for the newest PREFETCH_THREADS rows on screen,
  // so a click shows one at once and refreshes it behind.
  const threadCache = useRef(new Map<string, GmailThreadView>());
  // Each listed thread's historyId: sent with an open so the server can
  // answer from its cache instead of Gmail.
  const historyOf = useRef(new Map<string, string>());
  useEffect(() => {
    for (const t of threads) if (t.historyId) historyOf.current.set(t.id, t.historyId);
  }, [threads]);
  const remember = useCallback((thread: GmailThreadView) => {
    const c = threadCache.current;
    c.delete(thread.id);
    c.set(thread.id, thread);
    // Oldest out first: a Map iterates in insertion order.
    while (c.size > THREAD_CACHE_MAX) c.delete(c.keys().next().value!);
  }, []);

  // `known` is the list's message count for the thread: a cached copy with
  // that many messages is current (Gmail threads only grow), so no call.
  const fetchThread = useCallback(async (id: string, quiet: boolean, known?: number) => {
    const cached = threadCache.current.get(id);
    if (!quiet) setLoaded((prev) => ({ ...prev, [id]: { thread: cached ?? null, error: null } }));
    if (cached && known !== undefined && cached.messages.length === known) return;
    const res = await fetchGmailThread(id, historyOf.current.get(id));
    if (res.ok) remember(res.data);
    setLoaded((prev) => {
      const current = prev[id];
      if (res.ok) return { ...prev, [id]: { thread: res.data, error: null } };
      // A quiet refresh, or a card already showing a copy, keeps what it has.
      if ((quiet || cached) && current?.thread) return prev;
      return { ...prev, [id]: { thread: null, error: res.error } };
    });
  }, [remember]);

  // Prefetch the newest rows of whatever list is showing, a few at a time
  // (each is a full Gmail threads.get; Gmail rate-limits per user).
  const prefetchQueue = useRef<string[]>([]);
  const prefetching = useRef(0);
  useEffect(() => {
    const queued = new Set(prefetchQueue.current);
    for (const t of threads.slice(0, PREFETCH_THREADS)) {
      if (!threadCache.current.has(t.id) && !queued.has(t.id)) prefetchQueue.current.push(t.id);
    }
    const pump = () => {
      while (prefetching.current < PREFETCH_CONCURRENCY && prefetchQueue.current.length > 0) {
        const id = prefetchQueue.current.shift()!;
        if (threadCache.current.has(id)) continue;
        prefetching.current++;
        void fetchGmailThread(id, historyOf.current.get(id)).then((res) => {
          prefetching.current--;
          if (res.ok) remember(res.data);
          pump();
        });
      }
    };
    pump();
  }, [threads, remember]);

  const markRead = useCallback((id: string) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unread: false } : t)));
    markGmailThreadRead(id).then((res) => {
      if (!res.ok) {
        console.error("markGmailThreadRead failed", res.error);
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unread: true } : t)));
      }
    });
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      setActiveId(id);
      if (!split) openRead(id);
      void fetchThread(id, false, threads.find((t) => t.id === id)?.messageCount);
      if (threads.find((t) => t.id === id)?.unread) markRead(id);
    },
    [threads, fetchThread, markRead, split, openRead]
  );

  // Escape closes the open (not minimized) read card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const openRead = [...cardsRef.current].reverse().find((c) => c.kind === "read" && c.mode !== "min");
      if (openRead) closeCard(openRead.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeCard]);

  // A label change (archive, star, unread, trash) moves threads between
  // folders: every cached page is stale, and the row is updated in place.
  const afterLabelChange = useCallback(() => {
    cache.current.clear();
  }, []);
  const dropThread = useCallback(
    (id: string) => {
      setThreads((prev) => prev.filter((t) => t.id !== id));
      threadCache.current.delete(id);
      afterLabelChange();
      closeCard(readKey(id));
      setLoaded((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setActiveId((prev) => (prev === id ? null : prev));
    },
    [afterLabelChange, closeCard]
  );

  const threadActionsFor = useCallback(
    (thread: GmailThreadView): ThreadActions => {
      const row = threads.find((t) => t.id === thread.id);
      const quotedOf = (m: GmailMessageView) => ({ ...m, subject: thread.subject });
      return {
        starred: row?.starred ?? false,
        reply: (m, all) => {
          const who = all ? replyAllRecipients(m, accountEmail ?? "") : { to: m.replyTo, cc: "" };
          openCompose({
            to: who.to,
            cc: who.cc,
            subject: replySubject(thread.subject),
            quoted: replyQuote(quotedOf(m)),
            reply: {
              threadId: thread.id,
              inReplyTo: m.rfcMessageId,
              references: [m.references, m.rfcMessageId].filter(Boolean).join(" ") || null,
            },
          });
        },
        forward: (m) => {
          openCompose({
            subject: forwardSubject(thread.subject),
            quoted: forwardQuote(quotedOf(m)),
            forward: { messageId: m.id, attachments: m.attachments },
          });
        },
        archive: () => {
          dropThread(thread.id);
          modifyGmailThread(thread.id, { remove: ["INBOX"] }).then((res) => {
            if (!res.ok) toast.error(res.error);
          });
        },
        trash: () => {
          dropThread(thread.id);
          trashGmailThread(thread.id).then((res) => {
            if (!res.ok) toast.error(res.error);
          });
        },
        toggleStar: () => {
          const next = !(row?.starred ?? false);
          setThreads((prev) => prev.map((t) => (t.id === thread.id ? { ...t, starred: next } : t)));
          afterLabelChange();
          modifyGmailThread(thread.id, next ? { add: ["STARRED"] } : { remove: ["STARRED"] }).then((res) => {
            if (!res.ok) toast.error(res.error);
          });
        },
        markUnread: () => {
          setThreads((prev) => prev.map((t) => (t.id === thread.id ? { ...t, unread: true } : t)));
          afterLabelChange();
          closeCard(readKey(thread.id));
          setActiveId((prev) => (prev === thread.id ? null : prev));
          modifyGmailThread(thread.id, { add: ["UNREAD"] }).then((res) => {
            if (!res.ok) toast.error(res.error);
          });
        },
      };
    },
    [threads, accountEmail, openCompose, dropThread, afterLabelChange, closeCard]
  );

  // Freshness: page one again (and the open thread) whenever the window regains focus.
  const latest = useRef({ filter, activeQ, activeId });
  useEffect(() => {
    latest.current = { filter, activeQ, activeId };
  });
  useEffect(() => {
    const onFocus = async () => {
      const { filter: f, activeQ: q } = latest.current;
      // Focus comes back every time the user clicks out of an email's frame;
      // a list fetched within FRESH_MS is left alone.
      if (isFresh(cacheKey(f, q))) return;
      const seq = listSeq.current;
      const res = await fetchGmailThreads({ filter: f, q });
      if (res.ok) cache.current.set(cacheKey(f, q), { page: res.data, at: Date.now() });
      if (seq !== listSeq.current || !res.ok) return;
      const opened = latest.current.activeId;
      const fresh = res.data.threads;
      // The open thread is fetched again only if it gained a message.
      const openedRow = opened ? fresh.find((t) => t.id === opened) : undefined;
      if (openedRow) void fetchThread(openedRow.id, true, openedRow.messageCount);
      if (pages.current > 1) {
        setThreads((prev) => mergeRefreshedPage(fresh, prev));
      } else {
        setThreads(fresh);
        setNextPageToken(res.data.nextPageToken);
      }
      setListError(null);
      if (opened && fresh.find((t) => t.id === opened)?.unread) markRead(opened);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchThread, markRead, isFresh]);

  // What the Orion drawer sees: the list as loaded, and the open thread.
  usePageContextSlice(
    "admin-email-list",
    emailListSlice({
      folder: GMAIL_FILTERS.find((f) => f.id === filter)?.label ?? filter,
      search: activeQ,
      threads,
      more: nextPageToken !== null,
    })
  );
  const active = activeId ? loaded[activeId] : undefined;
  usePageContextSlice("admin-email-thread", active?.thread ? emailThreadSlice(active.thread) : null);

  /** A thread as the split pane or a read card shows it: loading, failed, or the thread. */
  const paneFor = (id: string | null): ReactNode => {
    const state = id ? loaded[id] : undefined;
    if (!id || !state) return <div className="flex flex-1 bg-background-surface" />;
    if (state.error) {
      return (
        <div className="flex flex-1 items-center justify-center bg-background-surface px-4 text-center text-sm text-muted-foreground">
          <p>
            <EmailError message={state.error} connectionsHref={connectionsHref} />
          </p>
        </div>
      );
    }
    if (state.thread) return <EmailThread key={state.thread.id} thread={state.thread} embedded={!split} actions={threadActionsFor(state.thread)} />;
    return (
      <div className="flex flex-1 items-center justify-center bg-background-surface">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  };

  return (
    <div className="light relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <EmailToolbar
        filter={filter}
        onFilter={(f) => {
          setShowSettings(false);
          setFilter(f);
          void load(f, activeQ);
        }}
        settings={showSettings}
        onSettings={() => setShowSettings(true)}
        split={split}
        onSplit={(next) => {
          setShowSettings(false);
          setSplit(next);
          // The split view reads in its own pane; the table reads in cards.
          if (next) setCards((prev) => prev.filter((c) => c.kind !== "read"));
          else if (activeId) openRead(activeId);
        }}
        query={query}
        onQueryChange={setQuery}
        onSearch={() => {
          setShowSettings(false);
          const q = query.trim();
          setActiveQ(q);
          void load(filter, q);
        }}
        onNewMessage={() => openCompose({})}
      />
      {showSettings ? (
        <EmailSettingsView settings={settings} onSaved={setSettings} />
      ) : !split ? (
        <EmailTable
          threads={threads}
          activeId={cards.some((c) => c.kind === "read" && c.threadId === activeId && c.mode !== "min") ? activeId : null}
          onSelect={handleSelect}
          hasMore={nextPageToken !== null && !pending}
          onLoadMore={() => void loadMore()}
          pending={pending}
          error={listError ? <EmailError message={listError} connectionsHref={connectionsHref} /> : null}
        />
      ) : (
      <div className="flex min-h-0 flex-1">
        <EmailThreadList
          threads={threads}
          activeId={activeId}
          onSelect={handleSelect}
          hasMore={nextPageToken !== null && !pending}
          onLoadMore={() => void loadMore()}
          pending={pending}
          error={listError ? <EmailError message={listError} connectionsHref={connectionsHref} /> : null}
        />
        <div className="relative flex min-w-0 flex-1">{paneFor(activeId)}</div>
      </div>
      )}
      <EmailCardLayer
        cards={cards.map((c): CardSpec => {
          if (c.kind === "read") {
            return {
              key: c.key,
              kind: "read",
              mode: c.mode,
              title: loaded[c.threadId]?.thread?.subject ?? threads.find((t) => t.id === c.threadId)?.subject ?? "Message",
              node: <div className="quiet-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">{paneFor(c.threadId)}</div>,
            };
          }
          return {
            key: c.key,
            kind: "compose",
            mode: c.mode,
            title: composeTitles[c.key] || c.init.subject || "New Message",
            node: (
              <EmailComposeCard
                cardKey={c.key}
                init={c.init}
                settings={settings}
                index={index}
                draft={draft?.key === c.key ? draft : null}
                onSubjectChange={(subject) => setComposeTitles((prev) => ({ ...prev, [c.key]: subject }))}
                onSent={(threadId) => {
                  closeCard(c.key);
                  // The sent message lands in Sent and All, and a reply in its thread.
                  cache.current.clear();
                  void load(filter, activeQ, true);
                  // The index just learned these recipients and subject.
                  void loadIndex();
                  if (loaded[threadId]) void fetchThread(threadId, true);
                }}
              />
            ),
          };
        })}
        onMode={setMode}
        onClose={closeCard}
      />
    </div>
  );
}
