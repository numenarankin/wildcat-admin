"use client";

import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SalesTab = "prospects" | "pipeline" | "tasks";

const TABS: { value: SalesTab; label: string }[] = [
  { value: "prospects", label: "Prospects" },
  { value: "pipeline", label: "Pipeline" },
  { value: "tasks", label: "Tasks" },
];

/** Segmented tab switch, the same control the project and calendar toolbars use. */
function TabToggle({
  tab,
  onTab,
}: {
  tab: SalesTab;
  onTab: (tab: SalesTab) => void;
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
 * The sales desk's top bar, laid out like the project workspace's
 * (`ProjectToolbar`): view switch left, title centered, add actions right.
 * The two actions each create something on this desk regardless of which
 * tab is open. Token-coloured buttons, not the project toolbar's fixed
 * black/white pair, because the admin side is dark.
 */
export function SalesToolbar({
  tab,
  onTab,
  onNewProspect,
  onNewTask,
}: {
  tab: SalesTab;
  onTab: (tab: SalesTab) => void;
  onNewProspect: () => void;
  onNewTask: () => void;
}) {
  return (
    <div className="grid h-14 shrink-0 grid-cols-3 items-center border-b px-4">
      <div className="flex justify-start">
        <TabToggle tab={tab} onTab={onTab} />
      </div>

      <h1 className="truncate text-center font-heading text-lg font-semibold tracking-tight">
        Sales
      </h1>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" className="h-9" onClick={onNewTask}>
          <PlusIcon />
          New Task
        </Button>
        <Button size="sm" className="h-9" onClick={onNewProspect}>
          <PlusIcon />
          New Prospect
        </Button>
      </div>
    </div>
  );
}
