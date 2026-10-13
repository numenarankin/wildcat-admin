"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getTaggableTargets } from "@/lib/notes/actions";
import {
  TAG_TYPE_LABEL,
  type NoteTag,
  type NoteTagType,
  type TagTarget,
} from "@/lib/notes/types";

/** Stable key for a tag/target, used for set membership + React keys. */
function keyOf(t: { type: string; id: string }): string {
  return `${t.type}:${t.id}`;
}

/** One dropdown per facility type, in display order. */
const FACILITY_TYPES: NoteTagType[] = [
  "well",
  "tank",
  "meter",
  "battery",
  "lease",
];

/** Dropdown button labels (plural). */
const FACILITY_MENU_LABEL: Record<string, string> = {
  well: "Wells",
  tank: "Tanks",
  meter: "Meters",
  battery: "Batteries",
  lease: "Leases",
};

interface TagPickerProps {
  value: NoteTag[];
  onChange: (tags: NoteTag[]) => void;
  disabled?: boolean;
}

/**
 * The tag chips + per-type add controls shown in a note's header. There is a
 * dropdown for each facility type (Wells, Tanks, …) and one for People; each
 * lists its candidates with search and multi-select. Candidates load once when
 * the picker mounts (the editor only mounts when a note opens). Presentational
 * only — persistence is the editor's job.
 */
export function TagPicker({ value, onChange, disabled = false }: TagPickerProps) {
  const [targets, setTargets] = useState<TagTarget[] | null>(null);

  useEffect(() => {
    let active = true;
    getTaggableTargets()
      .then((t) => {
        if (active) setTargets(t);
      })
      .catch((error) => {
        console.error("Failed to load taggable targets", error);
        if (active) setTargets([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const byType = useMemo(() => {
    const map = new Map<NoteTagType, TagTarget[]>();
    for (const t of targets ?? []) {
      const list = map.get(t.type) ?? [];
      list.push(t);
      map.set(t.type, list);
    }
    const people = (targets ?? []).filter((t) => t.kind === "person");
    const projects = (targets ?? []).filter((t) => t.kind === "project");
    return { map, people, projects };
  }, [targets]);

  const selectedKeys = useMemo(() => new Set(value.map(keyOf)), [value]);

  function toggle(target: TagTarget) {
    const k = keyOf(target);
    if (selectedKeys.has(k)) {
      onChange(value.filter((t) => keyOf(t) !== k));
    } else {
      onChange([
        ...value,
        {
          type: target.type,
          id: target.id,
          label: target.label,
          kind: target.kind,
        },
      ]);
    }
  }

  function remove(tag: NoteTag) {
    onChange(value.filter((t) => keyOf(t) !== keyOf(tag)));
  }

  const loading = targets === null;

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {value.map((tag) => (
            <span
              key={keyOf(tag)}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 py-0.5 pl-2 pr-1 text-xs font-medium text-foreground"
            >
              <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                {TAG_TYPE_LABEL[tag.type]}
              </span>
              <span className="max-w-[12rem] truncate">{tag.label}</span>
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${tag.label}`}
                  onClick={() => remove(tag)}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {!disabled ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {FACILITY_TYPES.map((type) => (
            <TagDropdown
              key={type}
              label={FACILITY_MENU_LABEL[type]}
              targets={byType.map.get(type) ?? []}
              selectedKeys={selectedKeys}
              onToggle={toggle}
              loading={loading}
            />
          ))}
          <TagDropdown
            label="People"
            targets={byType.people}
            selectedKeys={selectedKeys}
            onToggle={toggle}
            loading={loading}
            showType
          />
          <TagDropdown
            label="Projects"
            targets={byType.projects}
            selectedKeys={selectedKeys}
            onToggle={toggle}
            loading={loading}
          />
        </div>
      ) : null}
    </div>
  );
}

function TagDropdown({
  label,
  targets,
  selectedKeys,
  onToggle,
  loading,
  showType = false,
}: {
  label: string;
  targets: TagTarget[];
  selectedKeys: Set<string>;
  onToggle: (t: TagTarget) => void;
  loading: boolean;
  /** Show each row's type on the right (People spans several types). */
  showType?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedCount = targets.reduce(
    (n, t) => (selectedKeys.has(keyOf(t)) ? n + 1 : n),
    0
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        (t.sublabel?.toLowerCase().includes(q) ?? false)
    );
  }, [targets, query]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {label}
        {selectedCount > 0 ? (
          <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.65rem] font-semibold text-primary-foreground">
            {selectedCount}
          </span>
        ) : null}
        <ChevronDownIcon data-icon="inline-end" />
      </Button>

      {open ? (
        <div className="absolute left-0 top-full z-[120] mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <div className="flex items-center gap-2 rounded-sm border border-input px-2">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="mt-2 max-h-72 overflow-y-auto">
            {loading ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                {targets.length === 0 ? `No ${label.toLowerCase()}.` : "No matches."}
              </p>
            ) : (
              filtered.map((t) => {
                const selected = selectedKeys.has(keyOf(t));
                return (
                  <button
                    key={keyOf(t)}
                    type="button"
                    onClick={() => onToggle(t)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                      selected && "bg-muted"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[0.2rem] border",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border"
                      )}
                    >
                      {selected ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t.label}</span>
                    {showType ? (
                      <span className="shrink-0 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                        {TAG_TYPE_LABEL[t.type]}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
