"use client";

import type { ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MONTHS, MONTHS_SHORT, weekDays } from "@/lib/calendar/dates";
import type { CalendarViewMode } from "@/components/calendar/calendar-view";

function weekTitle(cursor: Date): string {
  const days = weekDays(cursor);
  const a = days[0];
  const b = days[6];
  const aMonth = MONTHS_SHORT[a.getMonth()];
  const bMonth = MONTHS_SHORT[b.getMonth()];
  if (a.getFullYear() !== b.getFullYear()) {
    return `${aMonth} ${a.getDate()}, ${a.getFullYear()} – ${bMonth} ${b.getDate()}, ${b.getFullYear()}`;
  }
  if (a.getMonth() !== b.getMonth()) {
    return `${aMonth} ${a.getDate()} – ${bMonth} ${b.getDate()}, ${b.getFullYear()}`;
  }
  return `${aMonth} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`;
}

/**
 * What each view is called on the toggle.
 *
 * "board" stays the stored value — `?view=board` is already in sent
 * notification links (`in-app.ts`) — while the tab reads Tasks, which is what
 * the thing actually is.
 */
const VIEW_LABELS: Record<CalendarViewMode, string> = {
  month: "Month",
  week: "Week",
  board: "Tasks",
};

const ALL_VIEWS: readonly CalendarViewMode[] = ["month", "week", "board"];

function ViewToggle({
  view,
  onView,
  views = ALL_VIEWS,
}: {
  view: CalendarViewMode;
  onView: (view: CalendarViewMode) => void;
  views?: readonly CalendarViewMode[];
}) {
  return (
    <div className="flex h-8 items-center rounded-sm bg-muted p-0.5">
      {views.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onView(value)}
          className={cn(
            "rounded-sm px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
            view === value &&
              "bg-background text-foreground shadow-sm hover:text-foreground"
          )}
        >
          {VIEW_LABELS[value]}
        </button>
      ))}
    </div>
  );
}

export function CalendarToolbar({
  view,
  onView,
  cursor,
  onPrev,
  onNext,
  onNewTask,
  onNewEvent,
  filter,
  views,
}: {
  view: CalendarViewMode;
  onView: (view: CalendarViewMode) => void;
  cursor: Date;
  onPrev: () => void;
  onNext: () => void;
  /** Omit to hide New Task (a calendar with no tasks of its own). */
  onNewTask?: () => void;
  onNewEvent: () => void;
  /**
   * The assignee filter, rendered to the left of New Task. Passed in rather
   * than built here so the toolbar stays presentational and the filter's state
   * sits with the tasks it filters.
   */
  filter?: ReactNode;
  /** The views on the toggle; all three by default. */
  views?: readonly CalendarViewMode[];
}) {
  // The board is not date-scoped: it shows a plain "Tasks" title (no month/week
  // nav). The new-task / new-event buttons stay put across all three views.
  const isBoard = view === "board";
  const title =
    view === "month"
      ? `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`
      : weekTitle(cursor);

  return (
    <div className="grid h-14 shrink-0 grid-cols-3 items-center border-b px-4">
      <div className="flex justify-start">
        <ViewToggle view={view} onView={onView} views={views} />
      </div>

      <div className="flex items-center justify-center gap-2">
        {isBoard ? (
          <h1 className="text-center font-heading text-lg font-semibold tracking-tight">
            Tasks
          </h1>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous"
              onClick={onPrev}
            >
              <ChevronLeftIcon />
            </Button>
            <h1 className="text-center font-heading text-lg font-semibold tracking-tight">
              {title}
            </h1>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next"
              onClick={onNext}
            >
              <ChevronRightIcon />
            </Button>
          </>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {filter}
        {onNewTask && (
          <Button
            size="sm"
            onClick={onNewTask}
            className="h-9 border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100"
          >
            <PlusIcon />
            New Task
          </Button>
        )}
        <Button
          size="sm"
          onClick={onNewEvent}
          className="h-9 bg-black text-white hover:bg-neutral-800"
        >
          <PlusIcon />
          New Event
        </Button>
      </div>
    </div>
  );
}
