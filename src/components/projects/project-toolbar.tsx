"use client";

import {
  ChevronDownIcon,
  FolderSearchIcon,
  Loader2Icon,
  PlusIcon,
  UploadIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type ProjectTab = "orion" | "tasks" | "files" | "notes";

const TABS: { value: ProjectTab; label: string }[] = [
  { value: "orion", label: "Orion" },
  { value: "tasks", label: "Tasks" },
  { value: "files", label: "Files" },
  { value: "notes", label: "Notes" },
];

/** Segmented tab switch, the same control the calendar toolbar uses for its views. */
function TabToggle({
  tab,
  onTab,
}: {
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
}) {
  return (
    <div className="flex h-8 items-center rounded-sm bg-muted p-0.5">
      {TABS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          aria-pressed={tab === value}
          onClick={() => onTab(value)}
          className={cn(
            "rounded-sm px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
            tab === value &&
              "bg-background text-foreground shadow-sm hover:text-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Click-to-edit project title. Same interaction as the topbar breadcrumb's
 * `EditableCrumb` (Enter or blur commits, Escape reverts) — the two are the
 * same rename, so they behave the same; only the type scale differs.
 */
function EditableTitle({
  value,
  onRename,
}: {
  value: string;
  onRename?: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onRename?.(trimmed);
  }

  const TITLE_CLASS =
    "truncate text-center font-heading text-lg font-semibold tracking-tight";

  if (!onRename) {
    return <h1 className={TITLE_CLASS}>{value}</h1>;
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn(
          TITLE_CLASS,
          "mx-auto w-full max-w-xs rounded border border-border bg-background px-2 py-0.5 outline-none focus:ring-1 focus:ring-ring"
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      title="Click to rename"
      className={cn(TITLE_CLASS, "mx-auto max-w-full rounded px-2 hover:bg-accent")}
    >
      {value}
    </button>
  );
}

/**
 * The project workspace's top bar, laid out like the agenda toolbar
 * (`CalendarToolbar`): view switch left, title centered, add actions right.
 * The project name sits in the middle; the three actions each create something
 * in this project regardless of which tab is open.
 */
export function ProjectToolbar({
  projectName,
  tab,
  onTab,
  onNewChat,
  onNewTask,
  onSelectFromFiles,
  onUploadFromComputer,
  onNewNote,
  onRename,
  onShare,
  sharedCount = 0,
  uploading = false,
  themed = false,
}: {
  projectName: string;
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
  onNewChat: () => void;
  onNewTask: () => void;
  /**
   * Browse the knowledge base and place existing files in this project. Omit
   * where there is no knowledge base to pick from (the admin side): Add File
   * then uploads straight from the computer.
   */
  onSelectFromFiles?: () => void;
  /** Open the disk picker and upload into this project's folder. */
  onUploadFromComputer: () => void;
  /** Start a note pre-tagged to this project. */
  onNewNote: () => void;
  /** Rename the project; omit to make the title read-only. */
  onRename?: (name: string) => void;
  /** Open the share dialog. Omit to hide Share (every admin already sees every admin project). */
  onShare?: () => void;
  /** How many people this project is shared with, shown on the share control. */
  sharedCount?: number;
  uploading?: boolean;
  /** Theme colours instead of the fixed white/black buttons (the admin side is dark). */
  themed?: boolean;
}) {
  const secondary = themed
    ? "h-9"
    : "h-9 border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100";
  const primary = themed ? "h-9" : "h-9 bg-black text-white hover:bg-neutral-800";
  const secondaryVariant = themed ? ("outline" as const) : undefined;
  return (
    <div className="grid h-14 shrink-0 grid-cols-3 items-center border-b px-4">
      <div className="flex justify-start">
        <TabToggle tab={tab} onTab={onTab} />
      </div>

      <EditableTitle value={projectName} onRename={onRename} />

      <div className="flex justify-end gap-2">
        {onShare && (
          <Button size="sm" variant={secondaryVariant} onClick={onShare} className={secondary}>
            <UsersIcon />
            Share
            {sharedCount > 0 && (
              <span className="ty-caption text-muted-foreground">
                {sharedCount}
              </span>
            )}
          </Button>
        )}
        <Button size="sm" variant={secondaryVariant} onClick={onNewChat} className={secondary}>
          <PlusIcon />
          New Chat
        </Button>
        <Button size="sm" variant={secondaryVariant} onClick={onNewTask} className={secondary}>
          <PlusIcon />
          New Task
        </Button>
        <Button size="sm" variant={secondaryVariant} onClick={onNewNote} className={secondary}>
          <PlusIcon />
          New Note
        </Button>

        {!onSelectFromFiles && (
          <Button
            size="sm"
            disabled={uploading}
            onClick={onUploadFromComputer}
            className={primary}
          >
            {uploading ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
            {uploading ? "Uploading…" : "Add File"}
          </Button>
        )}

        {/* Add File is the one two-way action: an existing knowledge-base file
            can be placed here, or a new one uploaded from disk. Same trigger
            shape and item styling as the Files browser's Add menu. */}
        {onSelectFromFiles && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="sm"
                  disabled={uploading}
                  className={primary}
                />
              }
            >
              {uploading ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <PlusIcon />
              )}
              {uploading ? "Uploading…" : "Add File"}
              <ChevronDownIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={onSelectFromFiles}
              >
                <FolderSearchIcon />
                Select from files
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={onUploadFromComputer}
              >
                <UploadIcon />
                Upload from computer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
