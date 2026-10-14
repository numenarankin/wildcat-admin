"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { EnrichChat } from "@/components/admin/prospecting/enrich-chat";
import { ResearchCard } from "@/components/admin/prospecting/research-card";
import { clearQueue, dequeueTarget } from "@/lib/admin/outreach/research-actions";
import { loadTargetCard, type TargetCard } from "@/lib/admin/outreach/enrich-chat-actions";
import { ENRICH_STATUS_LABEL, type EnrichQueueItem, type EnrichStatus } from "@/lib/admin/outreach/types";

const GROUPS: EnrichStatus[] = ["queued", "researching", "reviewed", "enrolled"];

/** The card's width is the user's: dragged on its left edge, kept per browser. */
const CARD_MIN_WIDTH = 320;
const CARD_MAX_WIDTH = 960;
const CARD_DEFAULT_WIDTH = 320;
const CARD_WIDTH_KEY = "enrich-card-width";
const clampCard = (w: number) => Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, Math.round(w)));

function readCardWidth(): number {
  if (typeof window === "undefined") return CARD_DEFAULT_WIDTH;
  try {
    const stored = Number(window.localStorage.getItem(CARD_WIDTH_KEY));
    return stored > 0 ? clampCard(stored) : CARD_DEFAULT_WIDTH;
  } catch {
    return CARD_DEFAULT_WIDTH;
  }
}

/**
 * The Enrich tab: the queue of companies on the left, grouped by where their
 * research stands, the picked company's Orion chat in the middle and its
 * card on the right. Enrichment happens only in the chat; the card shows
 * what the chat saved and holds the Add to sequence button.
 */
export function EnrichWorkspace({
  queue,
  firstName,
  onQueueChanged,
}: {
  queue: EnrichQueueItem[];
  firstName: string;
  /** A queue write landed (removed, status moved): the page should refresh. */
  onQueueChanged: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(queue[0]?.operatorNo ?? null);
  // Tagged with its target: a card loaded for the last company is not shown
  // for the next one while its own loads.
  const [card, setCard] = useState<{ no: number; data: TargetCard } | null>(null);
  const [, startTransition] = useTransition();
  // This tab mounts only after a click (never on the server), so the stored
  // width can be the initial state with no hydration mismatch.
  const [cardWidth, setCardWidth] = useState(readCardWidth);
  const [resizingCard, setResizingCard] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!resizingCard) return;
    function onMove(event: PointerEvent) {
      // The card sits on the right edge of the pane, so it grows as the
      // pointer moves left (the Orion drawer's rule).
      const right = cardRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      setCardWidth(clampCard(right - event.clientX));
    }
    function onUp() {
      setResizingCard(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [resizingCard]);
  useEffect(() => {
    if (resizingCard) return;
    try {
      window.localStorage.setItem(CARD_WIDTH_KEY, String(cardWidth));
    } catch {
      // Private window or blocked storage: the width still holds for this visit.
    }
  }, [cardWidth, resizingCard]);
  const item = queue.find((q) => q.operatorNo === selected) ?? null;

  const refreshCard = useCallback(() => {
    if (selected == null) return;
    const no = selected;
    loadTargetCard(no)
      .then((data) => setCard({ no, data }))
      .catch((error) => console.error("Failed to load the card", error));
  }, [selected]);

  useEffect(() => {
    refreshCard();
  }, [refreshCard]);
  const shownCard = card && card.no === selected ? card.data : null;

  // A save from the chat changes the card AND the queue's status column.
  const handleTurn = useCallback(() => {
    refreshCard();
    onQueueChanged();
  }, [refreshCard, onQueueChanged]);

  function handleRemove(no: number) {
    startTransition(async () => {
      try {
        await dequeueTarget(no);
        if (selected === no) setSelected(null);
      } catch (error) {
        console.error("Failed to remove from the queue", error);
        toast.error("Couldn't remove it from the queue.");
      }
      onQueueChanged();
    });
  }

  function handleClear() {
    startTransition(async () => {
      try {
        await clearQueue();
        setSelected(null);
      } catch (error) {
        console.error("Failed to clear the queue", error);
        toast.error("Couldn't clear the queue.");
      }
      onQueueChanged();
    });
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* The queue, a file tree: a folder per status, a row per company. */}
      <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-r bg-background-surface">
        {queue.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing queued. Add companies from the Targets tab.</p>
        ) : (
          <>
            <div className="flex items-center justify-between border-b px-3 py-1.5">
              <span className="text-xs tabular-nums text-muted-foreground">{queue.length} queued</span>
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-destructive"
                onClick={handleClear}
              >
                Clear queue
              </Button>
            </div>
            {GROUPS.map((status) => {
              const rows = queue.filter((q) => q.status === status);
              if (rows.length === 0) return null;
              return (
                <Collapsible key={status} defaultOpen={status !== "enrolled"} className="group/folder">
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
                    <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/folder:rotate-90" />
                    {ENRICH_STATUS_LABEL[status]}
                    <span className="ml-auto tabular-nums">{rows.length}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul>
                      {rows.map((q) => (
                        <li key={q.operatorNo} className="group/row relative">
                          <button
                            type="button"
                            onClick={() => setSelected(q.operatorNo)}
                            className={cn(
                              "flex w-full flex-col items-start px-3 py-1.5 pl-7 pr-8 text-left hover:bg-muted",
                              selected === q.operatorNo && "bg-muted"
                            )}
                          >
                            <span className="w-full truncate text-sm">{q.name}</span>
                            <span className="w-full truncate text-xs text-muted-foreground">
                              {[q.city, q.state].filter(Boolean).join(", ") || "—"} · {q.activeWells.toLocaleString()} wells
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${q.name} from the queue`}
                            onClick={() => handleRemove(q.operatorNo)}
                            className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive group-hover/row:opacity-100 focus-visible:opacity-100"
                          >
                            <XIcon className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </>
        )}
      </aside>


      <div className="flex min-w-0 flex-1 flex-col">
        {item ? (
          <EnrichChat key={item.operatorNo} targetNo={item.operatorNo} firstName={firstName} onTurn={handleTurn} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Pick a company to research it with Orion.
          </div>
        )}
      </div>

      {item && (
        <aside ref={cardRef} style={{ width: cardWidth }} className="relative shrink-0 border-l">
          <div
            onPointerDown={(e) => {
              e.preventDefault();
              setResizingCard(true);
            }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize research card"
            className={cn(
              "absolute top-0 left-0 z-10 h-full w-1.5 cursor-col-resize transition-colors hover:bg-data-accent/40",
              resizingCard && "bg-data-accent/60"
            )}
          />
          <ResearchCard
            key={item.operatorNo}
            item={item}
            research={shownCard?.research ?? null}
            contacts={shownCard?.contacts ?? []}
            onChanged={handleTurn}
          />
        </aside>
      )}
    </div>
  );
}
