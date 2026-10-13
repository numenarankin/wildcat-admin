"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ChevronLeftDouble,
  ClockRewind,
  Loading01,
  Plus,
  Printer,
  SearchMd,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { relativeAge } from "@/lib/format/relative";
import { Button } from "@/components/ui/button";
import { previewText } from "@/components/ai/message-utils";
import { searchConversations } from "@/lib/ai/conversation-search";
import type { Conversation } from "@/lib/ai/conversations";

interface OrionConversationListProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  /** Print the open conversation (server-rendered PDF → the print dialog). */
  onPrint: () => void;
  /** Nothing worth a sheet of paper on an empty chat. */
  canPrint: boolean;
  /** True while the document is being built, so the control can show a spinner. */
  printing?: boolean;
}

/**
 * Chat history for the Orion page: a side panel of conversations, newest
 * activity first.
 *
 * The row is the Support history row (`@/components/support/support-conversation-list`),
 * which is in turn the staff support inbox's, so all three read the same way.
 * The title leads, the age sits right, and the last thing said previews
 * underneath with `You:` marking the user's own turn.
 *
 * Collapsing folds the panel away to three floating icon buttons — new chat,
 * reopen history, print — in the chat's own left gutter. They carry no card,
 * border or shadow: at that size the chrome was most of what you saw, and the
 * gutter beside a `max-w-3xl` conversation is empty anyway.
 *
 * The two states are one `AnimatePresence` pair rather than a swap, so the
 * panel's width is what animates. Sliding the width means the chat re-centres
 * continuously instead of jumping when the panel is removed from flow, and the
 * icons cross-fade over the top of it. Nothing here goes stale while shut,
 * which is why this collapses and the Support panel does not: there, an unread
 * staff reply has to stay visible.
 */
export function OrionConversationList({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onPrint,
  canPrint,
  printing = false,
}: OrionConversationListProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
  }, []);

  // An unsent chat gets no row. The workspace seeds a draft on mount and on
  // every "New chat", so listing them put a permanent "New chat" entry at the
  // top that named nothing and, being the newest, outranked the conversation
  // the reader had just been having. A chat earns its place in the history by
  // having something in it.
  const started = useMemo(
    () => conversations.filter((c) => c.messages.length > 0),
    [conversations]
  );

  // Ranked by relevance while searching, by recency otherwise. Memoised on the
  // query because it walks every message of every conversation, and the query
  // changes on each keystroke.
  const sorted = useMemo(
    () => searchConversations(started, searching ? query : ""),
    [started, searching, query]
  );

  return (
    <AnimatePresence initial={false}>
      {collapsed ? (
        // The card this panel replaced, restored exactly: a rounded, bordered
        // surface with a shadow, floating in the chat's top-left, holding the
        // three things the panel does. The only change from the original is the
        // new-chat button, which was `outline` and is now `ghost` like its two
        // neighbours, so the three read as one set.
        <motion.div
          key="strip"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: "linear" }}
          className="absolute left-3 top-3 z-20 flex flex-col gap-1.5 rounded-lg border border-border bg-background-surface p-1.5 shadow-lg"
        >
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="New chat"
            title="New chat"
            onClick={onCreate}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Show chat history"
            title="Show chat history"
            aria-expanded={false}
            onClick={() => setCollapsed(false)}
          >
            <ClockRewind className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Print conversation"
            title="Print conversation"
            disabled={!canPrint || printing}
            onClick={onPrint}
          >
            {printing ? (
              <Loading01 className="size-4 animate-spin" />
            ) : (
              <Printer className="size-4" />
            )}
          </Button>
        </motion.div>
      ) : (
        // The animated box is the WIDTH only; the content inside keeps its full
        // `w-80` throughout, so the rows never reflow mid-slide — they are
        // clipped by the shrinking box instead, which is what makes the panel
        // read as sliding away rather than being squeezed.
        <motion.div
          key="panel"
          initial={{ width: 0 }}
          animate={{ width: "20rem" }}
          exit={{ width: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          className="h-full shrink-0 overflow-hidden border-r bg-background"
        >
          <div className="flex h-full w-80 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-1 border-b pl-4 pr-2 text-sm font-medium">
              Chats
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Collapse chat history"
                title="Collapse"
                aria-expanded
                // The ghost variant fills itself on `aria-expanded="true"`,
                // which is right for a dropdown trigger and wrong here: this
                // one is expanded for as long as the panel is open, so it sat
                // permanently shaded next to two unshaded siblings.
                className="ml-auto aria-expanded:bg-transparent"
                onClick={() => setCollapsed(true)}
              >
                <ChevronLeftDouble className="size-4 text-muted-foreground" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Print conversation"
                title="Print conversation"
                disabled={!canPrint || printing}
                onClick={onPrint}
              >
                {printing ? (
                  <Loading01 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <Printer className="size-4 text-muted-foreground" />
                )}
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={searching ? "Close search" : "Search chats"}
                title="Search chats"
                onClick={() => setSearching((open) => !open)}
              >
                <SearchMd className="size-4 text-muted-foreground" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="New chat"
                title="New chat"
                onClick={onCreate}
              >
                <Plus className="size-4" />
              </Button>
            </div>

            {/* The search bar drops in between the header and the first row,
                pushing the list down rather than covering it. Height is what
                animates, so the rows slide instead of jumping. */}
            <AnimatePresence initial={false}>
              {searching && (
                <motion.div
                  key="search"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                  className="shrink-0 overflow-hidden border-b"
                >
                  <div className="relative px-3 py-2">
                    <input
                      autoFocus
                      // `text`, not `search`. A search input draws the
                      // platform's own clear button, which renders in the OS
                      // accent colour — a blue X in a panel where every other
                      // icon is a plain grey glyph. It is not stylable beyond
                      // hiding it, so the control below is ours.
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") closeSearch();
                      }}
                      placeholder="Search chats by topic…"
                      className="h-8 w-full rounded-md border border-border bg-background pl-2.5 pr-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    {query && (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Clear search"
                        title="Clear search"
                        className="absolute right-4 top-1/2 size-6 -translate-y-1/2"
                        onClick={() => setQuery("")}
                      >
                        <XClose className="size-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto">
              {sorted.length === 0 && (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  {query.trim()
                    ? "No chats mention that."
                    : "No conversations yet."}
                </p>
              )}
              {sorted.map((c) => {
                const last = c.messages[c.messages.length - 1];
                const preview = previewText(last);
                return (
                  // A row is a div rather than a button because it holds the delete
                  // control, and a button cannot legally nest one.
                  <div
                    key={c.id}
                    className={cn(
                      "group relative border-b py-4 pl-4 pr-3 hover:bg-muted/50",
                      activeId === c.id && "bg-muted",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      title={c.title}
                      className="flex w-full min-w-0 flex-col gap-1 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {c.title}
                        </span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {relativeAge(c.updatedAt)}
                        </span>
                      </div>
                      {preview && (
                        <span className="truncate text-xs text-muted-foreground/80">
                          {last?.role === "user" ? "You: " : ""}
                          {preview}
                        </span>
                      )}
                    </button>

                    {/* Delete is kept from the card this panel replaces: it has no
                  other home, and dropping it to match the Support list would
                  have quietly removed the feature.

                  It is taken OUT of the row's flow and floated over the right
                  edge, because a column this narrow cannot spare 24px of gutter
                  on every row for a control that is only ever wanted on one.
                  The gradient behind it is what makes that legible: it fades in
                  from the right so the icon reads against a settled ground,
                  while the title and age stay visible through the transparent
                  left end rather than being cut off. Both only appear on hover,
                  so a list of titles stays a list of titles. */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-y-px right-0 w-24 bg-gradient-to-l from-muted via-muted/90 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete conversation"
                      onClick={() => onDelete(c.id)}
                      className="absolute right-2 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity hover:bg-transparent hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash01 className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
