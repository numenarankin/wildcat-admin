"use client";

import type { Ref } from "react";
import { useDrag } from "react-dnd";
import { CalendarClockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { RowDeleteButton } from "@/components/row-delete-button";
import { descriptionPreview } from "@/lib/tasks/tasks";
import type { Prospect } from "@/lib/admin/prospect-types";

/** Drag item type shared between prospect cards and pipeline columns. */
export const PROSPECT_DND_TYPE = "prospect";

export interface ProspectDragItem {
  id: string;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/** "Jane Hale · Reeves" for the card's second line; either half may be missing. */
export function prospectSubline(p: Prospect): string {
  return [p.contactName, p.county].filter(Boolean).join(" · ");
}

/**
 * A prospect on the pipeline board: the task card with a company for a title.
 * The second line is who and where; the footer is the operator's size and the
 * date the card entered its column, so a stale Trial reads as stale.
 */
export function ProspectCard({
  prospect,
  onOpen,
  onDelete,
}: {
  prospect: Prospect;
  onOpen?: (prospect: Prospect) => void;
  /** Delete this prospect; omit to hide the control. */
  onDelete?: (prospect: Prospect) => void;
}) {
  const [{ isDragging }, dragRef] = useDrag<
    ProspectDragItem,
    unknown,
    { isDragging: boolean }
  >(() => ({
    type: PROSPECT_DND_TYPE,
    item: { id: prospect.id },
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  }), [prospect.id]);

  const subline = prospectSubline(prospect) || descriptionPreview(prospect.notes);

  return (
    <div
      ref={dragRef as unknown as Ref<HTMLDivElement>}
      onClick={() => onOpen?.(prospect)}
      className={cn(
        "group/card cursor-pointer rounded-[0.15rem] border bg-card p-3 shadow-sm transition-colors hover:border-foreground/20",
        isDragging && "opacity-40"
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
          {prospect.company}
        </p>
        {onDelete && (
          <RowDeleteButton
            label={`Delete ${prospect.company}`}
            onDelete={() => onDelete(prospect)}
            // Same reveal-on-hover treatment as the task card (see its note).
            className="-mr-1 -mt-1 opacity-0 transition-[color,background-color,opacity] focus-visible:opacity-100 group-hover/card:opacity-100"
          />
        )}
      </div>
      {subline && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {subline}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-current" />
          {prospect.wells != null ? `${prospect.wells.toLocaleString("en-US")} wells` : "Size unknown"}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <CalendarClockIcon className="size-3.5" />
            <span className="tabular-nums">
              {dateFormatter.format(new Date(prospect.stageChangedAt))}
            </span>
          </span>
          {prospect.source && (
            <span className="truncate text-xs text-muted-foreground">
              {prospect.source}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
