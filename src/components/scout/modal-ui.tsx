"use client";

import { cn } from "@/lib/utils";

/*
 * ===========================================================================
 * MODAL UI — shared furniture for Scout's detail modals.
 * ===========================================================================
 *
 * Presentational only; no data, nothing to wire. Reach for these instead of
 * re-styling: Stat (the app's tile + a caveat sub-line), Panel (titled pane that
 * scrolls its own body), ModalTabs (the app's workspace tab bar), TabPane,
 * TableBox + THead + Th (a table that scrolls under a sticky header), Row,
 * Empty.
 *
 * Layout contract inside a modal: SwipeUpModal gives a fixed-height flex column,
 * so ModalTabs is `shrink-0` and TabPane is the `flex-1` that owns scrolling.
 * A table wants TableBox (it has a min-height so a chart sharing the pane cannot
 * squeeze it to a sliver).
 */

/**
 * The shared furniture for Scout's detail modals (operator, well, lease).
 *
 * Lifted out of `operator-modal.tsx` when the well and lease modals arrived:
 * three surfaces rendering the same tab bar and the same stat tile from three
 * copies is how they drift. The stat tile is the app's own
 * (`analytics/summary-stats.tsx`); the tab bar is the app's workspace tab bar
 * (`wells/well-workspace.tsx`).
 */

export function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between gap-6 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("text-right font-medium", mono && "font-mono text-xs")}>
        {value}
      </span>
    </div>
  );
}

/**
 * The app's stat tile, plus a muted sub-line: every figure in Scout rests on an
 * assumption (a price, a sample, a lagged cycle) that has to travel with the
 * number instead of sitting in a paragraph underneath the row.
 */
export function Stat({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex flex-col gap-1 rounded-[0.15rem] border px-4 py-3"
    >
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && (
        <span className="text-xs tabular-nums text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}

/** A titled pane that fills its grid cell and scrolls its own body. */
export function Panel({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        // shrink-0: a panel is as tall as what it holds. Left growable inside a
        // column that also holds a fixed-height chart, the two competed for the
        // pane and drew over each other.
        "flex min-h-0 shrink-0 flex-col rounded-[0.15rem] border",
        className
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export interface ModalTab<T extends string> {
  key: T;
  label: string;
  /** Omitted while the payload is still loading — "Leases 0" is worse than none. */
  count?: number;
}

export function ModalTabs<T extends string>({
  tabs,
  value,
  onChange,
  showCounts = true,
}: {
  tabs: ModalTab<T>[];
  value: T;
  onChange: (t: T) => void;
  showCounts?: boolean;
}) {
  return (
    <div
      role="tablist"
      className="flex shrink-0 flex-wrap items-center gap-6 border-b px-5 pt-2"
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-1 pb-3 text-lg font-semibold transition-colors",
            value === t.key
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {t.label}
          {showCounts && t.count !== undefined && (
            <span className="ml-1.5 text-sm font-medium tabular-nums text-muted-foreground">
              {t.count.toLocaleString()}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Standard pane wrapper. The map tab wants the bare box; every other tab is a
 * flex column that owns its own scrolling so table headers can stick.
 */
export function TabPane({
  bare = false,
  children,
}: {
  bare?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        bare
          ? "min-h-0 flex-1"
          : // Scrolls, not clips. Its children are fixed-height (a chart is a
            // header, a pixel-height plot and a footer, none of them shrinkable),
            // so a pane shorter than their sum has to give somewhere: hidden cut
            // the bottom off, and no overflow rule at all let them draw over
            // whatever came next.
            "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5"
      }
    >
      {children}
    </div>
  );
}


/**
 * A bordered box that scrolls a table under a sticky header.
 *
 * `min-h-48` matters: in a pane that also holds a chart, flex-1 alone will
 * squeeze the table to a two-row sliver on a short viewport. The floor makes
 * the pane scroll instead.
 */
/**
 * Sized to its rows, scrolling SIDEWAYS only.
 *
 * It used to be `flex-1 overflow-auto`, which made every table a scroll region
 * competing with the chart above it for the pane's height: the table squeezed to
 * nothing and the chart's footer drew on top of it. The pane scrolls now, so a
 * long table simply makes the pane longer, which is what a reader expects.
 */
export function TableBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full shrink-0 overflow-x-auto rounded-[0.15rem] border">
      {children}
    </div>
  );
}

export function Th({
  children,
  right = false,
}: {
  children: React.ReactNode;
  right?: boolean;
}) {
  return (
    <th
      className={cn("px-3 py-2 font-medium", right ? "text-right" : "text-left")}
    >
      {children}
    </th>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="sticky top-0 z-10">
      <tr className="border-b bg-muted text-xs text-muted-foreground">{children}</tr>
    </thead>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 rounded-[0.15rem] border p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
