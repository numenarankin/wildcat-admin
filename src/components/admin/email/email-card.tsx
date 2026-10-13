"use client";

import { useState } from "react";
import { ChevronsUpDownIcon, Maximize2Icon, Minimize2Icon, MinusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * How a card sits: open at its own size, minimized to a tab, maximized to
 * the whole container, or (compose only) tall: full height at its own width.
 */
export type CardMode = "open" | "min" | "max" | "tall";

export interface CardSpec {
  key: string;
  kind: "read" | "compose";
  title: string;
  mode: CardMode;
  node: React.ReactNode;
}

/**
 * Card sizes. Widths are plain lengths capped by the viewport, never by a
 * parent (a percentage of a parent sized by the card is a cycle the browser
 * resolves to the content's size). Heights are plain lengths or `h-full` of
 * a holder pinned top and bottom, which is always definite.
 */
const SIZE: Record<CardSpec["kind"], Record<Exclude<CardMode, "min">, string>> = {
  read: {
    open: "h-full w-[910px] max-w-[calc(100vw-6rem)]",
    tall: "h-full w-[910px] max-w-[calc(100vw-6rem)]",
    max: "h-full w-full",
  },
  compose: {
    open: "h-[34rem] max-h-full w-[48rem] max-w-[calc(100vw-6rem)]",
    tall: "h-full w-[48rem] max-w-[calc(100vw-6rem)]",
    max: "h-full w-full",
  },
};

/**
 * The email cards, inside the Email page under its toolbar (never over the
 * sidebar or the top bar). Drafts stand at the bottom left, open emails at
 * the bottom right, both resting on a strip of tabs along the bottom right
 * for whatever is minimized, so any card can be reached while others are
 * open. Where cards overlap, clicking one brings it to the top. A maximized
 * card takes the whole area and the others wait behind it, still mounted
 * (a draft keeps its text). No backdrop: the page stays readable.
 */
export function EmailCardLayer({
  cards,
  onMode,
  onClose,
}: {
  cards: CardSpec[];
  onMode: (key: string, mode: CardMode) => void;
  onClose: (key: string) => void;
}) {
  // Click order: the last card touched is on top where cards overlap.
  const [raised, setRaised] = useState<string[]>([]);
  const zOf = (key: string, i: number) => {
    const at = raised.indexOf(key);
    // A card never clicked yet goes above the clicked ones, newest highest.
    return at < 0 ? raised.length + 1 + i : at + 1;
  };
  const raise = (key: string) => setRaised((prev) => (prev[prev.length - 1] === key ? prev : [...prev.filter((k) => k !== key), key]));

  if (cards.length === 0) return null;
  const maxed = cards.find((c) => c.mode === "max");
  const tabs = cards.filter((c) => c.mode === "min");
  const shown = (c: CardSpec) => c.mode !== "min" && (maxed === undefined || maxed.key === c.key);
  const card = (c: CardSpec) => (
    <div
      key={c.key}
      style={{ zIndex: zOf(c.key, cards.indexOf(c)) }}
      onPointerDownCapture={() => raise(c.key)}
      className={cn(
        "pointer-events-auto flex shrink-0 flex-col overflow-hidden rounded-lg bg-card text-card-foreground shadow-xl ring-1 ring-foreground/10",
        shown(c) ? SIZE[c.kind][c.mode === "min" ? "open" : c.mode] : "hidden"
      )}
    >
      <CardTitleBar
        title={c.title}
        mode={c.mode}
        canTall={c.kind === "compose"}
        onMode={(m) => onMode(c.key, m)}
        onClose={() => onClose(c.key)}
      />
      {c.node}
    </div>
  );
  // Newest nearest its corner, on each side.
  const drafts = cards.filter((c) => c.kind === "compose").reverse();
  const reads = cards.filter((c) => c.kind === "read").reverse();

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 bottom-0 z-20 flex flex-col">
      {/* The cards' area: each holder is pinned to its corner, top and bottom
          set, so a card's h-full is this area's height and nothing can reach
          the tabs below. */}
      <div className="relative min-h-0 flex-1">
        {maxed ? (
          <div className={cn("absolute inset-x-3 top-3 flex", tabs.length === 0 ? "bottom-3" : "bottom-0")}>{card(maxed)}</div>
        ) : (
          <>
            <div className={cn("absolute top-3 left-3 flex items-end gap-3", tabs.length === 0 ? "bottom-3" : "bottom-0")}>
              {drafts.map(card)}
            </div>
            <div className={cn("absolute top-3 right-3 flex flex-row-reverse items-end gap-3", tabs.length === 0 ? "bottom-3" : "bottom-0")}>
              {reads.map(card)}
            </div>
          </>
        )}
        {maxed && cards.filter((c) => c.key !== maxed.key).map(card)}
      </div>
      {tabs.length > 0 && (
        <div className="pointer-events-auto flex flex-row-reverse flex-wrap gap-1.5 px-3 pt-1.5 pb-1.5">
          {[...tabs].reverse().map((c) => (
            <div
              key={c.key}
              className="flex h-8 w-56 items-center gap-1 rounded-md bg-card pl-3 pr-0.5 text-sm shadow-md ring-1 ring-foreground/10"
            >
              <button type="button" onClick={() => onMode(c.key, "open")} className="min-w-0 flex-1 truncate text-left font-medium">
                {c.title}
              </button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={() => onClose(c.key)}>
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CardTitleBar({
  title,
  mode,
  canTall,
  onMode,
  onClose,
}: {
  title: string;
  mode: CardMode;
  canTall: boolean;
  onMode: (mode: CardMode) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 bg-muted pl-4 pr-1.5">
      <h2 className="truncate text-sm font-medium">{title}</h2>
      <div className="flex shrink-0 items-center">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Minimize" onClick={() => onMode("min")}>
          <MinusIcon />
        </Button>
        {canTall && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={mode === "tall" ? "Normal height" : "Full height"}
            onClick={() => onMode(mode === "tall" ? "open" : "tall")}
          >
            <ChevronsUpDownIcon />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={mode === "max" ? "Restore" : "Expand"}
          onClick={() => onMode(mode === "max" ? "open" : "max")}
        >
          {mode === "max" ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
