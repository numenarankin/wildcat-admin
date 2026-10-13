"use client";

import { cn } from "@/lib/utils";

export type ProspectingTab = "recon" | "targets" | "map" | "enrich" | "sequence";

const TABS: { value: ProspectingTab; label: string }[] = [
  { value: "recon", label: "Recon" },
  { value: "targets", label: "Targets" },
  { value: "map", label: "Map" },
  { value: "enrich", label: "Enrich" },
  { value: "sequence", label: "Sequence" },
];

/** Segmented tab switch, the same control the sales toolbar uses. */
function TabToggle({
  tab,
  onTab,
}: {
  tab: ProspectingTab;
  onTab: (tab: ProspectingTab) => void;
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
 * The prospecting desk's top bar: the view switch left and the open tab's
 * own controls (the Targets stats, search and filters) filling the right.
 * No title: the topbar's page label already names the page, and the Targets
 * controls need the room.
 */
export function ProspectingToolbar({
  tab,
  onTab,
  actions,
  actionsRef,
}: {
  tab: ProspectingTab;
  onTab: (tab: ProspectingTab) => void;
  /** The right side: the open tab's own controls. */
  actions?: React.ReactNode;
  /** The right side's element, for a tab that portals its controls in (Recon). */
  actionsRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4 py-2">
      <div className="flex shrink-0 justify-start">
        <TabToggle tab={tab} onTab={onTab} />
      </div>
      <div ref={actionsRef} className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {actions}
      </div>
    </div>
  );
}
