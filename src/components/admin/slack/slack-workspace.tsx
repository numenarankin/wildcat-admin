"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SlackConversationList } from "@/components/admin/slack/slack-conversation-list";
import { SlackComposer, SlackMessageList, type SlackPeople } from "@/components/admin/slack/slack-messages";
import { loadSlackHistory, loadSlackThread, sendSlackMessage } from "@/lib/admin/slack/actions";
import {
  conversationTitle,
  mergeSlackMessages,
  sortConversations,
  type SlackConversation,
  type SlackMessage,
  type SlackPerson,
} from "@/lib/admin/slack/map";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { slackSlice } from "@/lib/ai/admin/page-slices";

/**
 * /admin/slack: the Messages page's layout (conversation panel left, the open
 * conversation right) over the admin's own Slack, read and write. A thread
 * opens in a panel on the right, as in Slack.
 *
 * Fresh by polling, not Slack's Events API: the open conversation (and open
 * thread) re-read every POLL_MS while the tab is visible, and on focus. That
 * needs no public webhook, and an internal app's history limit (50+ a minute)
 * covers one admin's tab with room to spare.
 */

const POLL_MS = 10_000;
/** Within this many px of the bottom, new messages keep the view pinned there. */
const STICK_PX = 80;

export function SlackWorkspace({
  teamName,
  selfId,
  conversations,
  people,
}: {
  teamName: string | null;
  selfId: string;
  conversations: SlackConversation[];
  people: SlackPerson[];
}) {
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const byHandle = useMemo(() => new Map(people.map((p) => [p.handle, p])), [people]);
  const roster: SlackPeople = useMemo(() => ({ byId, selfId }), [byId, selfId]);
  const sorted = useMemo(() => sortConversations(conversations, byId, byHandle), [conversations, byId, byHandle]);
  const titleOf = useCallback((c: SlackConversation) => conversationTitle(c, byId, byHandle), [byId, byHandle]);
  const facesOf = useCallback(
    (c: SlackConversation): SlackPerson[] => {
      if (c.kind === "dm") return c.dmUserId && byId.get(c.dmUserId) ? [byId.get(c.dmUserId)!] : [];
      return c.groupHandles
        .map((h) => byHandle.get(h))
        .filter((p): p is SlackPerson => p !== undefined && p.id !== selfId)
        .slice(0, 2);
    },
    [byId, byHandle, selfId]
  );

  const [activeId, setActiveId] = useState<string | null>(sorted[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const active = sorted.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <SlackConversationList
        teamName={teamName}
        conversations={sorted}
        titleOf={titleOf}
        facesOf={facesOf}
        activeId={activeId}
        onSelect={setActiveId}
        query={query}
        onQueryChange={setQuery}
      />
      <div className="relative flex min-w-0 flex-1">
        {active ? (
          <SlackConversationPane key={active.id} conversation={active} title={titleOf(active)} people={roster} />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-background-surface text-sm text-muted-foreground">
            No conversations.
          </div>
        )}
      </div>
    </div>
  );
}

/** Re-run `tick` every POLL_MS while the tab is visible, and when the window regains focus. */
function usePoll(tick: () => void) {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  });
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const id = window.setInterval(run, POLL_MS);
    window.addEventListener("focus", run);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", run);
    };
  }, []);
}

/**
 * A scroller that starts at the bottom, stays there while the reader is there,
 * and holds its place when older messages are put above.
 */
function useTranscriptScroll(messages: SlackMessage[]) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prepend = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prepend.current !== null) {
      el.scrollTop += el.scrollHeight - prepend.current;
      prepend.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }, []);
  /** Call before putting older messages above. */
  const holdPlace = useCallback(() => {
    prepend.current = scrollRef.current?.scrollHeight ?? null;
  }, []);
  /** Call before a send, so the reader lands on what they wrote. */
  const toBottom = useCallback(() => {
    stick.current = true;
  }, []);
  return { scrollRef, onScroll, holdPlace, toBottom };
}

function SlackConversationPane({
  conversation,
  title,
  people,
}: {
  conversation: SlackConversation;
  title: string;
  people: SlackPeople;
}) {
  const [messages, setMessages] = useState<SlackMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [threadTs, setThreadTs] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { scrollRef, onScroll, holdPlace, toBottom } = useTranscriptScroll(messages);
  const channel = conversation.id;

  // What the Orion drawer can see of Slack: it has no Slack tools.
  const nameOf = (id: string | null) => (id ? (people.byId.get(id)?.name ?? id) : null);
  usePageContextSlice(
    "admin-slack",
    slackSlice({
      name: title,
      id: conversation.id,
      kind: conversation.kind,
      thread: threadTs !== null,
      messages: messages.map((m) => ({
        who: m.userId === people.selfId ? "Me" : (nameOf(m.userId) ?? m.botName ?? "bot"),
        at: m.at,
        text: m.text.replace(/<@([A-Z0-9]+)>/g, (_, id: string) => `@${nameOf(id)}`),
      })),
    })
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await loadSlackHistory(channel);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setMessages(res.data.messages);
        setOlderCursor(res.data.nextCursor);
      } else {
        setError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel]);

  // The newest page again, folded onto what is loaded (older pages stay).
  usePoll(() => {
    setNow(Date.now());
    void loadSlackHistory(channel).then((res) => {
      if (res.ok) setMessages((prev) => mergeSlackMessages(prev, res.data.messages));
    });
  });

  async function loadOlder() {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    const res = await loadSlackHistory(channel, olderCursor);
    setLoadingOlder(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    holdPlace();
    setMessages((prev) => mergeSlackMessages(prev, res.data.messages));
    setOlderCursor(res.data.nextCursor);
  }

  async function send(text: string): Promise<boolean> {
    const res = await sendSlackMessage(channel, text);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    toBottom();
    setMessages((prev) => mergeSlackMessages(prev, [res.data]));
    return true;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background-surface">
        <div className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b bg-background px-4">
          <span aria-hidden />
          <h1 className="truncate font-heading text-lg font-medium tracking-tight">{title}</h1>
          <span aria-hidden />
        </div>

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-28">
          {olderCursor && (
            <div className="mb-4 flex justify-center">
              <Button type="button" size="sm" variant="outline" disabled={loadingOlder} onClick={() => void loadOlder()}>
                Older messages
              </Button>
            </div>
          )}
          {error ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{error}</p>
          ) : (
            !loading &&
            messages.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">No messages yet. Say something to {title}.</p>
            )
          )}
          <SlackMessageList messages={messages} people={people} now={now} onOpenThread={setThreadTs} />
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-4">
          <SlackComposer placeholder={`Message ${title}…`} onSend={send} />
        </div>
      </div>

      {threadTs && (
        <SlackThreadPanel
          key={threadTs}
          channel={channel}
          threadTs={threadTs}
          people={people}
          now={now}
          onClose={() => setThreadTs(null)}
          onReplied={(parent) => setMessages((prev) => mergeSlackMessages(prev, [parent]))}
        />
      )}
    </div>
  );
}

/** One thread, parent first, with its own composer posting into it. */
function SlackThreadPanel({
  channel,
  threadTs,
  people,
  now,
  onClose,
  onReplied,
}: {
  channel: string;
  threadTs: string;
  people: SlackPeople;
  now: number;
  onClose: () => void;
  /** The parent with its new reply count, for the transcript. */
  onReplied: (parent: SlackMessage) => void;
}) {
  const [messages, setMessages] = useState<SlackMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { scrollRef, onScroll, toBottom } = useTranscriptScroll(messages);

  const read = useCallback(async () => {
    const res = await loadSlackThread(channel, threadTs);
    if (res.ok) {
      setMessages(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
  }, [channel, threadTs]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await loadSlackThread(channel, threadTs);
      if (cancelled) return;
      if (res.ok) setMessages(res.data);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, threadTs]);

  usePoll(() => void read());

  async function send(text: string): Promise<boolean> {
    const res = await sendSlackMessage(channel, text, threadTs);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    toBottom();
    setMessages((prev) => mergeSlackMessages(prev, [res.data]));
    // The transcript's "N replies" moves now; the next poll brings Slack's own count.
    const parent = messages.find((m) => m.ts === threadTs);
    if (parent) onReplied({ ...parent, threadTs, replyCount: parent.replyCount + 1 });
    return true;
  }

  return (
    <div className="relative flex h-full min-h-0 w-[26rem] shrink-0 flex-col border-l bg-background-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b bg-background pl-4 pr-2">
        <span className="font-heading text-lg font-medium tracking-tight">Thread</span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close thread" className="ml-auto" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-28">
        {error ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{error}</p>
        ) : (
          <SlackMessageList messages={messages} people={people} now={now} />
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
        <SlackComposer placeholder="Reply…" onSend={send} />
      </div>
    </div>
  );
}
