"use client";

import * as React from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
} from "lucide-react";
import { addMonths, format, setYear, startOfMonth } from "date-fns";
import { DayPicker } from "react-day-picker";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

const CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_FROM_YEAR = CURRENT_YEAR - 60;
const DEFAULT_TO_YEAR = CURRENT_YEAR + 10;

/** Square ghost cell shared by day and year buttons, so the year grid reads as
 * the same control as the calendar. */
const CELL = cn(
  buttonVariants({ variant: "ghost" }),
  "rounded-[0.15rem] p-0 font-normal tabular-nums"
);
const CELL_SELECTED =
  "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground";
const NAV_BTN = cn(
  buttonVariants({ variant: "outline", size: "icon-sm" }),
  "opacity-70 hover:opacity-100 disabled:opacity-30"
);

/** The month + year grid, styled to match the day grid — opens when the year is
 * clicked, so a user jumps years without paging month by month (and without the
 * browser's native <select>). */
function YearGrid({
  month,
  fromYear,
  toYear,
  onPick,
}: {
  month: Date;
  fromYear: number;
  toYear: number;
  onPick: (year: number) => void;
}) {
  const selected = month.getFullYear();
  const years: number[] = [];
  for (let y = toYear; y >= fromYear; y--) years.push(y);
  return (
    <div className="grid max-h-[13.5rem] grid-cols-4 gap-1 overflow-y-auto py-1">
      {years.map((y) => (
        <button
          key={y}
          type="button"
          onClick={() => onPick(y)}
          className={cn(CELL, "h-8 w-full text-sm", y === selected && CELL_SELECTED)}
        >
          {y}
        </button>
      ))}
    </div>
  );
}

/**
 * Month calendar built on react-day-picker, restyled to this app: square ghost
 * day cells, a mono/uppercase caption, and outline nav buttons. Clicking the year
 * (or the ⌄⌃ toggle beside it) swaps the day grid for an in-app year grid, so
 * back-dating years is one click instead of paging month by month. Used as the
 * foundation for the date and date+time pickers.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  fromYear = DEFAULT_FROM_YEAR,
  toYear = DEFAULT_TO_YEAR,
  ...props
}: CalendarProps) {
  const initial =
    props.selected instanceof Date ? props.selected : props.defaultMonth ?? new Date();
  const [month, setMonth] = React.useState<Date>(startOfMonth(initial));
  const [yearOpen, setYearOpen] = React.useState(false);

  const minMonth = startOfMonth(new Date(fromYear, 0, 1)).getTime();
  const maxMonth = startOfMonth(new Date(toYear, 11, 1)).getTime();
  const atMin = month.getTime() <= minMonth;
  const atMax = month.getTime() >= maxMonth;

  return (
    <div className={cn("w-fit p-3", className)}>
      {/* Caption: prev/next arrows, and a clickable MONTH YEAR label with a
          ⌄⌃ toggle that opens the year grid. */}
      <div className="relative flex items-center justify-center pb-3 pt-1">
        <button
          type="button"
          className={cn(NAV_BTN, "absolute left-1")}
          disabled={atMin || yearOpen}
          aria-label="Previous month"
          onClick={() => setMonth((m) => addMonths(m, -1))}
        >
          <ChevronLeftIcon className="size-4" />
        </button>

        <button
          type="button"
          onClick={() => setYearOpen((o) => !o)}
          aria-label="Choose year"
          className="flex items-center gap-1 rounded-[0.15rem] px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wider hover:bg-accent"
        >
          {format(month, "MMMM yyyy")}
          <ChevronsUpDownIcon className="size-3.5 opacity-70" />
        </button>

        <button
          type="button"
          className={cn(NAV_BTN, "absolute right-1")}
          disabled={atMax || yearOpen}
          aria-label="Next month"
          onClick={() => setMonth((m) => addMonths(m, 1))}
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>

      {yearOpen ? (
        <div className="w-56">
          <YearGrid
            month={month}
            fromYear={fromYear}
            toYear={toYear}
            onPick={(y) => {
              setMonth((m) => setYear(m, y));
              setYearOpen(false);
            }}
          />
        </div>
      ) : (
        <DayPicker
          showOutsideDays={showOutsideDays}
          month={month}
          onMonthChange={setMonth}
          fromYear={fromYear}
          toYear={toYear}
          classNames={{
            months: "flex flex-col gap-2 sm:flex-row",
            month: "flex flex-col",
            caption: "hidden",
            nav: "hidden",
            table: "w-full border-collapse",
            head_row: "flex",
            head_cell: "w-8 text-[0.7rem] font-normal text-muted-foreground",
            row: "mt-1 flex w-full",
            cell: "relative p-0 text-center text-sm",
            day: cn(CELL, "size-8 aria-selected:opacity-100"),
            day_selected: CELL_SELECTED,
            day_today: "border border-border",
            day_outside: "text-muted-foreground/40",
            day_disabled: "text-muted-foreground/30",
            day_hidden: "invisible",
            ...classNames,
          }}
          {...props}
        />
      )}
    </div>
  );
}
