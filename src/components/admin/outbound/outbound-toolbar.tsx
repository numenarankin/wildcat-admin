"use client";

import { cn } from "@/lib/utils";

export type OutboundTab = "queue";

const TABS: { value: OutboundTab; label: string }[] = [{ value: "queue", label: "Queue" }];

/** Segmented tab switch, the same control the prospecting toolbar uses. */
function TabToggle({ tab, onTab }: { tab: OutboundTab; onTab: (tab: OutboundTab) => void }) {
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
            tab === value && "bg-background text-foreground shadow-sm hover:text-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The outbound desk's top bar: the view switch left and the open tab's own
 * controls filling the right. No title: the topbar's page label already
 * names the page.
 */
export function OutboundToolbar({
  tab,
  onTab,
  actions,
}: {
  tab: OutboundTab;
  onTab: (tab: OutboundTab) => void;
  /** The right side: the open tab's own controls. */
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4 py-2">
      <div className="flex shrink-0 justify-start">
        <TabToggle tab={tab} onTab={onTab} />
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
    </div>
  );
}
