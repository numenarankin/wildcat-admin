import { cn } from "@/lib/utils";
import {
  MONTHS_SHORT,
  WEEKDAYS_SHORT,
  monthCells,
  toISO,
} from "@/lib/calendar/dates";
import { EventChip } from "@/components/calendar/event-chip";
import type { CalendarEvent } from "@/lib/calendar/calendar";

/** Max events drawn in a cell before collapsing the rest into "+N more". */
const MAX_VISIBLE = 3;

export function MonthGrid({
  cursor,
  today,
  eventsByDate,
  onEventClick,
  onEventDelete,
}: {
  cursor: Date;
  today: string;
  eventsByDate: Map<string, CalendarEvent[]>;
  onEventClick: (event: CalendarEvent) => void;
  /** Delete an entry from its chip; omit to hide the control. */
  onEventDelete?: (event: CalendarEvent) => void;
}) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const cells = monthCells(year, month);
  const weeks = cells.length / 7;

  return (
    <div className="min-h-0 flex-1 overflow-hidden border-t">
      <div
        className="-mr-px -mb-px grid h-full grid-cols-7"
        style={{ gridTemplateRows: `auto repeat(${weeks}, minmax(0, 1fr))` }}
      >
        {WEEKDAYS_SHORT.map((weekday) => (
          <div
            key={weekday}
            className="border-r border-b bg-muted/50 px-2 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {weekday}
          </div>
        ))}

        {cells.map((cell) => {
          const iso = toISO(cell);
          const inMonth = cell.getMonth() === month;
          const isToday = iso === today;
          const dayEvents = eventsByDate.get(iso) ?? [];
          const visible = dayEvents.slice(0, MAX_VISIBLE);
          const overflow = dayEvents.length - visible.length;

          return (
            <div
              key={iso}
              className={cn(
                "flex min-h-0 min-w-0 flex-col gap-1 border-r border-b px-1.5 py-1.5",
                !inMonth && "bg-muted/20"
              )}
            >
              <div className="flex items-center">
                <span
                  className={cn(
                    "flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-medium",
                    isToday && "bg-foreground text-background",
                    !isToday && !inMonth && "text-muted-foreground/60",
                    !isToday && inMonth && "text-foreground"
                  )}
                >
                  {cell.getDate() === 1
                    ? `${MONTHS_SHORT[cell.getMonth()]} 1`
                    : cell.getDate()}
                </span>
              </div>

              <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
                {visible.map((event) => (
                  <EventChip
                    key={event.id}
                    event={event}
                    dimmed={!inMonth}
                    onClick={() => onEventClick(event)}
                    onDelete={
                      onEventDelete ? () => onEventDelete(event) : undefined
                    }
                  />
                ))}
                {overflow > 0 && (
                  <span className="px-1.5 text-[11px] font-medium text-muted-foreground">
                    +{overflow} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
