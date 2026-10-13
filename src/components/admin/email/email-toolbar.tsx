"use client";

import { ColumnsIcon, PlusIcon, RowsIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GMAIL_FILTERS, type GmailFilter } from "@/lib/admin/google/gmail/types";

const TAB =
  "rounded-sm px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground";
const TAB_ON = "bg-background text-foreground shadow-sm hover:text-foreground";

/**
 * Segmented folder switch, the same control the agenda and sales toolbars
 * use, with Settings after the folders.
 */
function FolderToggle({
  filter,
  onFilter,
  settings,
  onSettings,
}: {
  filter: GmailFilter;
  onFilter: (filter: GmailFilter) => void;
  settings: boolean;
  onSettings: () => void;
}) {
  return (
    <div className="flex h-8 items-center rounded-sm bg-muted p-0.5">
      {GMAIL_FILTERS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={!settings && filter === id}
          onClick={() => onFilter(id)}
          className={cn(TAB, !settings && filter === id && TAB_ON)}
        >
          {label}
        </button>
      ))}
      <button type="button" aria-pressed={settings} onClick={onSettings} className={cn(TAB, settings && TAB_ON)}>
        Settings
      </button>
    </div>
  );
}

/**
 * The email page's top bar, laid out like the agenda's (`CalendarToolbar` in
 * wildcat): folder switch left, title centered, search and New Message right
 * (styled as the agenda's New Event).
 */
export function EmailToolbar({
  filter,
  onFilter,
  query,
  onQueryChange,
  onSearch,
  onNewMessage,
  settings,
  onSettings,
  split,
  onSplit,
}: {
  filter: GmailFilter;
  onFilter: (filter: GmailFilter) => void;
  query: string;
  onQueryChange: (q: string) => void;
  onSearch: () => void;
  onNewMessage: () => void;
  settings: boolean;
  onSettings: () => void;
  /** Table (rows) or the split view; the toggle sits left of the folders. */
  split: boolean;
  onSplit: (split: boolean) => void;
}) {
  return (
    <div className="grid h-14 shrink-0 grid-cols-3 items-center border-b px-4">
      <div className="flex items-center justify-start gap-2">
        <div className="flex h-8 items-center rounded-sm bg-muted p-0.5">
          <button
            type="button"
            aria-label="Table view"
            aria-pressed={!split}
            onClick={() => onSplit(false)}
            className={cn("flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground", !split && TAB_ON)}
          >
            <RowsIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Split view"
            aria-pressed={split}
            onClick={() => onSplit(true)}
            className={cn("flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground", split && TAB_ON)}
          >
            <ColumnsIcon className="size-3.5" />
          </button>
        </div>
        <FolderToggle filter={filter} onFilter={onFilter} settings={settings} onSettings={onSettings} />
      </div>

      <h1 className="text-center font-heading text-lg font-semibold tracking-tight">
        Email
      </h1>

      <div className="flex justify-end gap-2">
        <form
          className="flex h-9 w-64 items-center gap-2 rounded-sm border border-input px-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch();
          }}
        >
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search mail…"
            aria-label="Search mail"
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </form>
        <Button size="sm" onClick={onNewMessage} className="h-9 bg-black text-white hover:bg-neutral-800">
          <PlusIcon />
          New Message
        </Button>
      </div>
    </div>
  );
}
