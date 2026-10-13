"use client";

import { HashIcon, LockIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { SlackConversation, SlackPerson } from "@/lib/admin/slack/map";

/**
 * The Slack conversation panel: `MessagesConversationList`'s frame (w-80, an
 * h-14 header, border-b rows) with the email list's search row under the
 * header. Slack gives no last-activity time without a read per conversation,
 * so the rows carry no clock or preview: channels first, then DMs and group
 * DMs, each alphabetical, the way Slack's own sidebar sections them.
 */
export function SlackConversationList({
  teamName,
  conversations,
  titleOf,
  facesOf,
  activeId,
  onSelect,
  query,
  onQueryChange,
}: {
  teamName: string | null;
  conversations: SlackConversation[];
  titleOf: (c: SlackConversation) => string;
  facesOf: (c: SlackConversation) => SlackPerson[];
  activeId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  const shown = needle ? conversations.filter((c) => titleOf(c).toLowerCase().includes(needle)) : conversations;
  const channels = shown.filter((c) => c.kind === "channel" || c.kind === "private");
  const direct = shown.filter((c) => c.kind === "dm" || c.kind === "group");

  const row = (c: SlackConversation) => {
    const title = titleOf(c);
    const isChannel = c.kind === "channel" || c.kind === "private";
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => onSelect(c.id)}
        title={title}
        className={cn(
          "flex w-full items-center gap-3 border-b py-4 pl-4 pr-3 text-left hover:bg-muted/50",
          activeId === c.id && "bg-muted"
        )}
      >
        {isChannel ? (
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
            {c.kind === "private" ? <LockIcon className="size-4" /> : <HashIcon className="size-4" />}
          </span>
        ) : (
          <div className="flex -space-x-2">
            {facesOf(c).map((u) => (
              <Avatar key={u.id} size="sm" className="ring-2 ring-background">
                {u.avatarUrl && <AvatarImage src={u.avatarUrl} alt={u.name} />}
                <AvatarFallback>{u.initials}</AvatarFallback>
              </Avatar>
            ))}
          </div>
        )}
        <span className="truncate text-sm font-medium">{isChannel ? title.replace(/^#/, "") : title}</span>
      </button>
    );
  };

  return (
    <div className="flex w-80 shrink-0 flex-col border-r bg-background">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b pl-4 pr-2 text-sm font-medium">
        <span className="truncate">{teamName ?? "Slack"}</span>
      </div>

      <div className="shrink-0 border-b p-2">
        <div className="flex items-center gap-2 rounded-sm border border-input px-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Find a conversation…"
            aria-label="Find a conversation"
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">{needle ? "No conversations match." : "No conversations."}</p>
        )}
        {channels.length > 0 && <SectionLabel>Channels</SectionLabel>}
        {channels.map(row)}
        {direct.length > 0 && <SectionLabel>Direct messages</SectionLabel>}
        {direct.map(row)}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="border-b bg-muted px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
