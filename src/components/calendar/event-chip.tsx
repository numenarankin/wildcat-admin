import { FlagIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { to12Hour } from "@/lib/calendar/dates";
import { RowDeleteButton } from "@/components/row-delete-button";
import type { CalendarEvent, EventCategory } from "@/lib/calendar/calendar";

/**
 * Category indicators — distinct shades of the one accent.
 *
 * `data-accent` is the blue a message you sent wears in Messages, and an event
 * is the same kind of thing: something someone in the org put there. Black read
 * as chrome, indistinguishable from the grid it sits on.
 */
export const CATEGORY_DOT: Record<EventCategory, string> = {
  production: "bg-data-accent",
  maintenance: "bg-data-accent/60",
  logistics: "bg-data-accent/50",
  compliance: "bg-data-accent/80",
  office: "bg-data-accent/35",
};

/**
 * The same ladder in white, for dots sitting ON a filled accent block (the week
 * grid's timed events). The accent-on-accent version of the map above is
 * invisible.
 */
export const CATEGORY_DOT_ON_ACCENT: Record<EventCategory, string> = {
  production: "bg-white",
  maintenance: "bg-white/60",
  logistics: "bg-white/50",
  compliance: "bg-white/80",
  office: "bg-white/35",
};

/**
 * Compact event pill used in the month grid and the week view's all-day band.
 */
export function EventChip({
  event,
  dimmed,
  onClick,
  onDelete,
}: {
  event: CalendarEvent;
  dimmed?: boolean;
  onClick?: () => void;
  /** Delete this entry; omit to hide the control. */
  onDelete?: () => void;
}) {
  return (
    // A wrapper rather than a single button: the delete control is a button of
    // its own, and nesting buttons is invalid. The wrapper carries the hover
    // background the chip used to own, plus the group the trash reveals on.
    <div
      className={cn(
        "flex w-full items-center gap-1.5 rounded-[0.2rem] pr-1 text-xs transition-colors hover:bg-accent",
        dimmed && "opacity-50"
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-1.5 text-left"
      >
        {event.taskId ? (
          <FlagIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              !event.color && CATEGORY_DOT[event.category]
            )}
            style={
              event.color ? { backgroundColor: event.color.background } : undefined
            }
          />
        )}
        {!event.allDay && event.start && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {to12Hour(event.start)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {event.title}
        </span>
      </button>
      {onDelete && !event.readOnly && (
        <RowDeleteButton
          compact
          label={`Delete ${event.title}`}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}
