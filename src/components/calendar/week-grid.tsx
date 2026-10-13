"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  WEEKDAYS_SHORT,
  hourLabel,
  minutesOf,
  to12Hour,
  toISO,
  weekDays,
} from "@/lib/calendar/dates";
import { FlagIcon } from "lucide-react";
import {
  CATEGORY_DOT_ON_ACCENT,
  EventChip,
} from "@/components/calendar/event-chip";
import { RowDeleteButton } from "@/components/row-delete-button";
import type { CalendarEvent } from "@/lib/calendar/calendar";

const HOUR_HEIGHT = 48; // px per hour
const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface Positioned {
  event: CalendarEvent;
  start: number;
  end: number;
  lane: number;
  lanes: number;
}

/** Greedy lane packing so overlapping events sit side by side. */
function positionDay(events: CalendarEvent[]): Positioned[] {
  const sorted = [...events].sort(
    (a, b) =>
      minutesOf(a.start ?? "00:00") - minutesOf(b.start ?? "00:00") ||
      minutesOf(a.end ?? "00:00") - minutesOf(b.end ?? "00:00")
  );

  const laneEnds: number[] = [];
  const placed = sorted.map((event) => {
    const start = minutesOf(event.start ?? "00:00");
    const end = Math.max(minutesOf(event.end ?? event.start ?? "00:00"), start + 15);
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    return { event, start, end, lane };
  });

  // Lane count for each event = max lanes used by anything overlapping it.
  return placed.map((item) => {
    let maxLane = item.lane;
    for (const other of placed) {
      if (other !== item && other.start < item.end && item.start < other.end) {
        maxLane = Math.max(maxLane, other.lane);
      }
    }
    return { ...item, lanes: maxLane + 1 };
  });
}

function WeekEvent({
  item,
  onClick,
  onDelete,
}: {
  item: Positioned;
  onClick: () => void;
  onDelete?: () => void;
}) {
  const { event } = item;
  const top = (item.start / 60) * HOUR_HEIGHT;
  const height = Math.max(18, ((item.end - item.start) / 60) * HOUR_HEIGHT);
  const width = 100 / item.lanes;
  // Tasks read as light-gray chips so they're visually distinct from the blue
  // scheduled-event blocks.
  const isTask = Boolean(event.taskId);
  // An entry with its own colors (a Google calendar's) wears them instead.
  const color = event.color;

  return (
    // Positioned wrapper so the trash can sit as a sibling of the click target
    // (a button inside a button is invalid) without being clipped by it.
    <div
      className={cn(
        "absolute overflow-hidden rounded-[0.2rem] border shadow-sm transition-colors",
        isTask
          ? "border-neutral-300 bg-neutral-200 text-neutral-800 hover:bg-neutral-300"
          : color
            ? "hover:brightness-95"
            : "border-data-accent bg-data-accent text-white hover:bg-data-accent/90"
      )}
      style={{
        ...(color && !isTask
          ? {
              backgroundColor: color.background,
              borderColor: color.background,
              color: color.foreground,
            }
          : undefined),
        top,
        height,
        left: `calc(${item.lane * width}% + 2px)`,
        width: `calc(${width}% - 4px)`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex size-full flex-col justify-center px-1.5 py-0.5 text-left"
      >
        <div className="flex items-center gap-1">
          {isTask ? (
            <FlagIcon className="size-3 shrink-0 text-neutral-500" />
          ) : (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                color
                  ? "bg-current opacity-60"
                  : CATEGORY_DOT_ON_ACCENT[event.category]
              )}
            />
          )}
          <span className="truncate text-xs font-medium">{event.title}</span>
        </div>
        {height >= 34 && event.start && event.end && (
          <span
            className={cn(
              "text-[10px] tabular-nums",
              isTask
                ? "text-neutral-500"
                : color
                  ? "opacity-70"
                  : "text-white/70"
            )}
          >
            {to12Hour(event.start)} – {to12Hour(event.end)}
          </span>
        )}
      </button>
      {onDelete && !event.readOnly && (
        <RowDeleteButton
          compact
          label={`Delete ${event.title}`}
          onDelete={onDelete}
          // Sits over the block's top-right corner; the title truncates behind
          // it. The dark event blocks need a light icon to stay visible.
          className={cn(
            "absolute right-0.5 top-0.5",
            isTask
              ? "text-neutral-600 hover:bg-neutral-100"
              : color
                ? "text-current opacity-70 hover:bg-black/10"
                : "text-white/70 hover:bg-white/15"
          )}
        />
      )}
    </div>
  );
}

/** Horizontal "now" line across today's column, refreshed every minute. Starts
 * null so SSR and the first client render match (no hydration mismatch), then
 * fills in on mount. */
function NowIndicator() {
  const [minutes, setMinutes] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setMinutes(now.getHours() * 60 + now.getMinutes());
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  if (minutes === null) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20"
      style={{ top: (minutes / 60) * HOUR_HEIGHT }}
    >
      <div className="border-t-[2.5px] border-[#e03e00]" />
      <span className="absolute -top-[3.75px] -left-[5px] size-2.5 rounded-full bg-[#e03e00]" />
    </div>
  );
}

export function WeekGrid({
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
  /** Delete an entry from its chip or block; omit to hide the control. */
  onEventDelete?: (event: CalendarEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const days = weekDays(cursor);

  // Open scrolled to the start of the work day.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 6 * HOUR_HEIGHT;
    }
  }, []);

  const gridCols = "4rem repeat(7, minmax(0, 1fr))";
  const hasAllDay = days.some((d) =>
    (eventsByDate.get(toISO(d)) ?? []).some((e) => e.allDay)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t">
      {/* One scroll container for headers + time grid so the vertical scrollbar
          shrinks the header row and the day columns by the SAME width — keeping
          the grid lines aligned under the day headers. The header band stays
          pinned with `sticky`. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {/* Pinned head: day headers + all-day band */}
        <div className="sticky top-0 z-20 bg-background">
          {/* Day headers */}
          <div
            className="grid shrink-0 border-b"
            style={{ gridTemplateColumns: gridCols }}
          >
            <div className="border-r" />
            {days.map((day) => {
              const iso = toISO(day);
              const isToday = iso === today;
              return (
                <div
                  key={iso}
                  className="flex flex-col items-center gap-0.5 border-r py-1.5"
                >
                  <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                    {WEEKDAYS_SHORT[day.getDay()]}
                  </span>
                  <span
                    className={cn(
                      "flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-sm font-semibold",
                      isToday ? "bg-foreground text-background" : "text-foreground"
                    )}
                  >
                    {day.getDate()}
                  </span>
                </div>
              );
            })}
          </div>

          {/* All-day band */}
          {hasAllDay && (
            <div
              className="grid shrink-0 border-b"
              style={{ gridTemplateColumns: gridCols }}
            >
              <div className="flex items-start justify-end border-r px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                All day
              </div>
              {days.map((day) => {
                const iso = toISO(day);
                const allDay = (eventsByDate.get(iso) ?? []).filter(
                  (e) => e.allDay
                );
                return (
                  <div key={iso} className="flex flex-col gap-0.5 border-r p-1">
                    {allDay.map((event) => (
                      <EventChip
                        key={event.id}
                        event={event}
                        onClick={() => onEventClick(event)}
                        onDelete={
                          onEventDelete
                            ? () => onEventDelete(event)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Time grid */}
        <div className="grid" style={{ gridTemplateColumns: gridCols }}>
          {/* Hour labels */}
          <div
            className="relative border-r"
            style={{ height: 24 * HOUR_HEIGHT }}
          >
            {HOURS.map(
              (hour) =>
                hour > 0 && (
                  <div
                    key={hour}
                    className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                    style={{ top: hour * HOUR_HEIGHT }}
                  >
                    {hourLabel(hour)}
                  </div>
                )
            )}
          </div>

          {/* Day columns */}
          {days.map((day) => {
            const iso = toISO(day);
            const isToday = iso === today;
            const timed = (eventsByDate.get(iso) ?? []).filter((e) => !e.allDay);
            const positioned = positionDay(timed);
            return (
              <div
                key={iso}
                className="relative border-r"
                style={{ height: 24 * HOUR_HEIGHT }}
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="absolute inset-x-0 border-t border-border/70"
                    style={{ top: hour * HOUR_HEIGHT }}
                  />
                ))}
                {isToday && <NowIndicator />}
                {positioned.map((item) => (
                  <WeekEvent
                    key={item.event.id}
                    item={item}
                    onClick={() => onEventClick(item.event)}
                    onDelete={
                      onEventDelete
                        ? () => onEventDelete(item.event)
                        : undefined
                    }
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
