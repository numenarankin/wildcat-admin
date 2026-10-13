"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker, TimePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LAST_MINUTE_OF_DAY,
  toHHMM,
  toMinutes,
} from "@/lib/time-of-day";
import type { PersonGroup } from "@/lib/people/directory";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";

export interface EventFormValues {
  title: string;
  /** Date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** True for all-day items; `start`/`end` are ignored when true. */
  allDay: boolean;
  /** Start time as a 24-hour `HH:MM` string ("" when all-day). */
  start: string;
  /** End time as a 24-hour `HH:MM` string ("" when all-day). */
  end: string;
  location: string;
  people: string[];
  description: string;
}

type FormState = {
  title: string;
  date: string;
  allDay: boolean;
  start: string;
  end: string;
  location: string;
  people: string[];
  description: string;
};

/**
 * The whole organisation, as a single entry in the people picker.
 *
 * A sentinel in `people` rather than every member's name expanded into the
 * list: "everyone" stays true as the roster changes, where a snapshot of names
 * taken today quietly excludes whoever joins tomorrow. Underscored so it cannot
 * collide with somebody actually called this.
 */
export const WHOLE_ORG = "__whole_org__";

/** Display name for {@link WHOLE_ORG}; every other value renders as itself. */
export function personLabel(value: string): string {
  return value === WHOLE_ORG ? "Whole org" : value;
}

// All-day off by default: most things put on this calendar are a job at a time
// — a workover, a haul, a meeting — and starting all-day ON meant the times
// were disabled until the box was found and unticked.
const EMPTY: FormState = {
  title: "",
  date: "",
  allDay: false,
  start: "",
  end: "",
  location: "",
  people: [],
  description: "",
};

function toFormState(initial?: EventFormValues): FormState {
  if (!initial) {
    return EMPTY;
  }
  return {
    title: initial.title,
    date: initial.date,
    allDay: initial.allDay,
    start: initial.start,
    end: initial.end,
    location: initial.location,
    people: initial.people,
    description: initial.description,
  };
}

export function EventModal({
  open,
  mode,
  initial,
  people,
  onClose,
  onSubmit,
  onDelete,
  subtitle,
  guests = false,
  readOnly = false,
}: {
  open: boolean;
  mode: "create" | "edit";
  initial?: EventFormValues;
  /**
   * Who can be picked, in labelled sections: members, employees, contractors,
   * service providers, royalty owners, gatherers. Not just org members — most
   * people on a job never have a login.
   */
  people: PersonGroup[];
  onClose: () => void;
  onSubmit: (values: EventFormValues) => void;
  /**
   * Delete the event being edited. Ignored when creating; omit to hide the
   * control. The host owns the confirmation.
   */
  onDelete?: () => void;
  /** The line under the title; null hides it. Unset, the agenda's own copy. */
  subtitle?: string | null;
  /**
   * People are typed in as email addresses (a Google event's guests) rather
   * than picked from the directory.
   */
  guests?: boolean;
  /** Show the event without letting it be changed or deleted. */
  readOnly?: boolean;
}) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [guestText, setGuestText] = useState("");
  const [wasOpen, setWasOpen] = useState(false);

  // Seed the form from the event being edited (or a clean form) when the modal
  // opens. Adjusting state during render on the open transition avoids an
  // effect + cascading render.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(toFormState(initial));
      setGuestText((initial?.people ?? []).join(", "));
    }
  }

  function handleField(
    key: Exclude<keyof FormState, "allDay" | "people">,
    value: string
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Move the start, and carry the end along with it.
   *
   * Dragging the start of a 2-hour job from 8 to 9 means the job now runs 9 to
   * 11, not 9 to 10. Leaving the end where it was silently shortens the event,
   * and moving the start PAST the end would leave a saved interval that runs
   * backwards. The length the user set is the thing worth preserving.
   */
  function handleStart(next: string) {
    setForm((prev) => {
      const from = toMinutes(prev.start);
      const to = toMinutes(prev.end);
      const moved = toMinutes(next);
      if (from == null || to == null || moved == null || to <= from) {
        return { ...prev, start: next };
      }
      const end = Math.min(moved + (to - from), LAST_MINUTE_OF_DAY);
      return { ...prev, start: next, end: toHHMM(end) };
    });
  }

  function togglePerson(name: string, checked: boolean) {
    setForm((prev) => {
      if (!checked) {
        return { ...prev, people: prev.people.filter((p) => p !== name) };
      }
      // Whole org and named people are mutually exclusive: an event for
      // everyone plus three names is the same event, listed twice over.
      if (name === WHOLE_ORG) return { ...prev, people: [WHOLE_ORG] };
      return {
        ...prev,
        people: [...prev.people.filter((p) => p !== WHOLE_ORG), name],
      };
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave || readOnly) return;
    onSubmit({
      title: form.title.trim(),
      date: form.date,
      allDay: form.allDay,
      start: form.allDay ? "" : form.start,
      end: form.allDay ? "" : form.end,
      location: form.location.trim(),
      people: guests
        ? guestText.split(/[\s,;]+/).filter((email) => email !== "")
        : form.people,
      description: form.description.trim(),
    });
    onClose();
  }

  const isEdit = mode === "edit";
  const canDelete = isEdit && onDelete != null && !readOnly;
  // A timed event needs an actual interval: both ends, and the end after the
  // start. Without this an event that is neither all-day nor timed saves as a
  // bare date and lands nowhere in the week grid, which positions blocks off
  // start/end.
  const start = toMinutes(form.start);
  const end = toMinutes(form.end);
  const canSave =
    form.title.trim() !== "" &&
    form.date !== "" &&
    (form.allDay || (start != null && end != null && end > start));

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      title={readOnly ? "Event" : isEdit ? "Edit Event" : "New Event"}
      description={
        subtitle !== undefined
          ? (subtitle ?? undefined)
          : isEdit
            ? "Update this event, then save."
            : "Add an event to the operations calendar."
      }
      className="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Title</span>
            <Input
              className="h-11"
              required
              autoFocus={!readOnly}
              disabled={readOnly}
              value={form.title}
              onChange={(e) => handleField("title", e.target.value)}
            />
          </label>

          {/* Date, Start, End, and All day on a single row. */}
          <div className="flex items-end gap-4">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-sm font-medium">Date</span>
              <DatePicker
                value={form.date ? parseISO(form.date) : null}
                onChange={(d) => handleField("date", d ? format(d, "yyyy-MM-dd") : "")}
                disabled={readOnly ? () => true : undefined}
                className="h-11 w-full"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-sm font-medium">Start</span>
              <TimePicker
                value={form.start}
                onChange={handleStart}
                disabled={form.allDay || readOnly}
                className="h-11 w-full"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-sm font-medium">End</span>
              <TimePicker
                value={form.end}
                onChange={(v) => handleField("end", v)}
                after={form.start}
                disabled={form.allDay || readOnly}
                className="h-11 w-full"
              />
            </label>
            <label className="flex h-11 shrink-0 items-center gap-2">
              <Checkbox
                checked={form.allDay}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({ ...prev, allDay: checked }))
                }
              />
              <span className="text-sm font-medium">All day</span>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Location</span>
              <Input
                className="h-11"
                disabled={readOnly}
                value={form.location}
                onChange={(e) => handleField("location", e.target.value)}
              />
            </label>
            {guests ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Guests</span>
                <Input
                  className="h-11"
                  type="text"
                  inputMode="email"
                  disabled={readOnly}
                  value={guestText}
                  onChange={(e) => setGuestText(e.target.value)}
                />
              </label>
            ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">People</span>
              <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="flex h-11 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                  />
                }
              >
                <span
                  className={
                    form.people.length ? "truncate" : "text-muted-foreground"
                  }
                >
                  {form.people.length
                    ? form.people.map(personLabel).join(", ")
                    : "Select people"}
                </span>
                <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64">
                {/* Offered whether or not anyone is on file: an org always has
                    members, even before the directory is filled in. */}
                <DropdownMenuCheckboxItem
                  checked={form.people.includes(WHOLE_ORG)}
                  onCheckedChange={(checked) =>
                    togglePerson(WHOLE_ORG, checked)
                  }
                >
                  {personLabel(WHOLE_ORG)}
                </DropdownMenuCheckboxItem>
                {people.length === 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      Nobody on file yet. Add people under People.
                    </div>
                  </>
                ) : (
                  people.map((group) => (
                    <DropdownMenuGroup key={group.label}>
                      <DropdownMenuSeparator />
                      {/*
                        Headed sections, because the list spans people with
                        logins, staff, contractors and counterparties — and two
                        different people can share a name across them.
                      */}
                      <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                      {group.names.map((person) => (
                        <DropdownMenuCheckboxItem
                          key={person}
                          checked={form.people.includes(person)}
                          onCheckedChange={(checked) =>
                            togglePerson(person, checked)
                          }
                        >
                          {person}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuGroup>
                  ))
                )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            )}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Description</span>
            <textarea
              rows={4}
              disabled={readOnly}
              className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={form.description}
              onChange={(e) => handleField("description", e.target.value)}
            />
          </label>
        </div>

        <div
          className={cn(
            "flex items-center gap-2 border-t px-5 py-4",
            canDelete ? "justify-between" : "justify-end"
          )}
        >
          {canDelete && (
            <Button
              type="button"
              variant="destructive"
              size="lg"
              onClick={onDelete}
            >
              <Trash2Icon className="size-4" />
              Delete
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button type="submit" size="lg" disabled={!canSave}>
                {isEdit ? "Save" : "Add Event"}
              </Button>
            )}
          </div>
        </div>
      </form>
    </SwipeUpModal>
  );
}
