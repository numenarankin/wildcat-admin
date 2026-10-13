"use client";

import { useCallback, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, ClockIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  LAST_MINUTE_OF_DAY,
  STEP_MINUTES,
  clockLabel,
  durationLabel,
  maskTimeTyping,
  parseTimeInput,
  toHHMM,
  toMinutes,
} from "@/lib/time-of-day";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DatePickerProps {
  value: Date | null;
  onChange: (date: Date | null) => void;
  placeholder?: string;
  /** Extra classes for the trigger button. */
  className?: string;
  /** Disable specific days (react-day-picker matcher). */
  disabled?: (date: Date) => boolean;
}

/** Outline trigger button styled for both pickers. `render`-friendly: base-ui
 *  clones the Button and injects the trigger's click/ref, so it must be a real
 *  Button element (not a wrapper that would swallow those props). */
function triggerButton(
  hasValue: boolean,
  className?: string,
  disabled?: boolean
) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      className={cn(
        "justify-start gap-2 font-normal",
        !hasValue && "text-muted-foreground",
        className
      )}
    />
  );
}

/** Date-only picker: a calendar in a popover, closes on select. */
export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  className,
  disabled,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={triggerButton(value != null, className)}>
        <CalendarIcon className="size-3.5 shrink-0 opacity-70" />
        {value ? format(value, "MMM d, yyyy") : placeholder}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={value ?? undefined}
          onSelect={(d) => {
            onChange(d ?? null);
            setOpen(false);
          }}
          disabled={disabled}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

/** Where an unset time picker opens: 7 AM, the top of the work day. */
const WORKDAY_START = 7 * 60;

/**
 * Time-only picker: one list of times, at {@link STEP_MINUTES} intervals.
 *
 * NOT `<input type="time">`, whose editor belongs to the operating system, so
 * it looks and behaves differently on every phone, tablet and desktop the crew
 * opens the app on. Not three dropdowns either: setting 8:30 should be one
 * motion, not an hour, a minute and an AM/PM.
 *
 * Typing filters the list, and the box punctuates itself as you go: bare digits
 * grow a colon, `a`/`p` becomes AM/PM (see {@link maskTimeTyping}). A time off
 * the quarter-hour is still reachable that way — type `837` and 8:37 AM is
 * offered, though the list never shows it.
 *
 * Speaks 24-hour `HH:MM` strings, with `""` for unset.
 */
export function TimePicker({
  value,
  onChange,
  after,
  // The empty shape of the answer, not an instruction: a field reading
  // "--:-- --" is visibly waiting for a time, and lines up with the one that
  // replaces it.
  placeholder = "--:-- --",
  className,
  disabled,
}: {
  /** 24-hour `HH:MM`, or `""` when nothing is set yet. */
  value: string;
  onChange: (value: string) => void;
  /**
   * Offer only times after this one, each tagged with the length it would
   * make. For an end time: an event cannot finish before it starts, and the
   * question being asked is really "how long is this", so the answer is on
   * screen next to every option.
   */
  after?: string;
  placeholder?: string;
  /** Extra classes for the trigger button. */
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = toMinutes(value);
  const afterMinutes = toMinutes(after);

  const options = useMemo(() => {
    const first =
      afterMinutes == null
        ? 0
        : Math.floor(afterMinutes / STEP_MINUTES) * STEP_MINUTES + STEP_MINUTES;
    const list: number[] = [];
    for (let m = first; m <= LAST_MINUTE_OF_DAY; m += STEP_MINUTES) list.push(m);
    // A time already set off the quarter-hour belongs in the list, or the
    // picker would silently drop the value it is meant to be showing.
    if (selected != null && !list.includes(selected)) {
      list.push(selected);
      list.sort((a, b) => a - b);
    }
    return list;
  }, [afterMinutes, selected]);

  const filtered = useMemo(() => {
    const typed = query.trim().toLowerCase().replace(/[\s:]/g, "");
    if (!typed) return options;
    const matches = options.filter((m) =>
      clockLabel(m).toLowerCase().replace(/[\s:]/g, "").startsWith(typed)
    );
    if (matches.length) return matches;
    // Nothing on the list matches, but it may still be a real time: "837".
    const parsed = toMinutes(parseTimeInput(query));
    return parsed == null ? [] : [parsed];
  }, [options, query]);

  function pick(minutes: number) {
    onChange(toHHMM(minutes));
    setOpen(false);
  }

  /**
   * Open on the part of the day being asked about rather than at midnight: the
   * time already set, else the start of the work day. A callback ref, because
   * the list only exists once the popover has mounted. `scrollTop` rather than
   * `scrollIntoView`, which would drag the page behind the popover with it.
   */
  const scrollToSelection = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const target =
        node.querySelector<HTMLElement>("[data-selected='true']") ??
        node.querySelector<HTMLElement>("[data-workday-start='true']");
      if (!target) return;
      node.scrollTop = Math.max(
        0,
        target.offsetTop - node.clientHeight / 2 + target.clientHeight / 2
      );
    },
    []
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={triggerButton(selected != null, className, disabled)}
      >
        <ClockIcon className="size-3.5 shrink-0 opacity-70" />
        {selected == null ? placeholder : clockLabel(selected)}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="border-b p-1.5">
          <Input
            autoFocus
            inputMode="numeric"
            value={query}
            onChange={(e) => setQuery(maskTimeTyping(e.target.value))}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // The list is inside a form; Enter here means "take the top
              // match", never "submit the event".
              e.preventDefault();
              if (filtered.length) pick(filtered[0]);
            }}
            placeholder="--:-- --"
            aria-label="Type a time"
            className="h-9 tabular-nums"
          />
        </div>
        <div
          ref={scrollToSelection}
          className="relative max-h-56 overflow-y-auto p-1"
        >
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              Not a time
            </div>
          ) : (
            filtered.map((minutes) => (
              <button
                key={minutes}
                type="button"
                data-selected={minutes === selected}
                data-workday-start={minutes === WORKDAY_START}
                onClick={() => pick(minutes)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  minutes === selected && "bg-accent font-medium"
                )}
              >
                <span className="tabular-nums">{clockLabel(minutes)}</span>
                {afterMinutes != null && minutes > afterMinutes && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {durationLabel(minutes - afterMinutes)}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Date + time picker: the same calendar with an attached time row beneath it
 * (hour · minute · AM/PM). Picking a day keeps the chosen time; the time row is
 * disabled until a day is selected so a bare time is never ambiguous.
 */
export function DateTimePicker({
  value,
  onChange,
  placeholder = "Pick date & time",
  className,
  disabled,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);

  const h24 = value ? value.getHours() : 0;
  const hour12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const minute = value ? value.getMinutes() : 0;
  const ampm: "AM" | "PM" = h24 < 12 ? "AM" : "PM";

  function selectDay(day: Date | undefined) {
    if (!day) {
      onChange(null);
      return;
    }
    const next = new Date(day);
    // Carry the current time onto the newly picked day (midnight if none yet).
    next.setHours(value ? value.getHours() : 0, value ? value.getMinutes() : 0, 0, 0);
    onChange(next);
  }

  function setTime(part: { hour12?: number; minute?: number; ampm?: "AM" | "PM" }) {
    if (!value) return;
    const h = part.hour12 ?? hour12;
    const m = part.minute ?? minute;
    const ap = part.ampm ?? ampm;
    let hours = h % 12;
    if (ap === "PM") hours += 12;
    const next = new Date(value);
    next.setHours(hours, m, 0, 0);
    onChange(next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={triggerButton(value != null, className)}>
        <CalendarIcon className="size-3.5 shrink-0 opacity-70" />
        {value ? format(value, "MMM d, yyyy · h:mm a") : placeholder}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={value ?? undefined}
          onSelect={selectDay}
          disabled={disabled}
          initialFocus
        />
        {/* Time row — attached directly beneath the calendar. */}
        <div className="flex items-center justify-center gap-1.5 border-t p-3">
          <Select
            value={String(hour12)}
            onValueChange={(v) => v && setTime({ hour12: Number(v) })}
            disabled={!value}
          >
            <SelectTrigger size="sm" aria-label="Hour" className="w-16">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-56">
              {HOURS.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">:</span>
          <Select
            value={String(minute)}
            onValueChange={(v) => v && setTime({ minute: Number(v) })}
            disabled={!value}
          >
            <SelectTrigger size="sm" aria-label="Minute" className="w-16">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-56">
              {MINUTES.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {String(m).padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={ampm}
            onValueChange={(v) => v && setTime({ ampm: v as "AM" | "PM" })}
            disabled={!value}
          >
            <SelectTrigger size="sm" aria-label="AM/PM" className="w-16">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AM">AM</SelectItem>
              <SelectItem value="PM">PM</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  );
}
