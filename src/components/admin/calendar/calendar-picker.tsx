"use client";

import { CalendarIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GoogleCalendar } from "@/lib/admin/google/calendar/types";

/**
 * Which Google calendars the admin calendar shows. The agenda's assignee
 * filter (`AssigneeFilter`), in its slot and with its classes, over Google's
 * calendar list and colors.
 */
export function CalendarPicker({
  calendars,
  selected,
  onChange,
}: {
  calendars: GoogleCalendar[];
  selected: ReadonlySet<string>;
  onChange: (selected: ReadonlySet<string>) => void;
}) {
  const shown = calendars.filter((c) => selected.has(c.id));
  const allShown = shown.length === calendars.length;

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(next);
  }

  const label = allShown
    ? "All calendars"
    : shown.length === 0
      ? "No calendars"
      : shown.length === 1
        ? shown[0].name
        : `${shown.length} calendars`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-2 font-normal"
            aria-label="Choose calendars"
          />
        }
      >
        <CalendarIcon className="size-4 text-muted-foreground" />
        {label}
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56">
        {calendars.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            No calendars
          </div>
        ) : (
          <>
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={allShown}
              onClick={() => onChange(new Set(calendars.map((c) => c.id)))}
            >
              Show all
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {calendars.map((calendar) => (
              <DropdownMenuCheckboxItem
                key={calendar.id}
                checked={selected.has(calendar.id)}
                onCheckedChange={(checked) => toggle(calendar.id, checked)}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: calendar.color.background }}
                />
                <span className="truncate">{calendar.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
