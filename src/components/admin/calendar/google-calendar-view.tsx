"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useServerState } from "@/hooks/use-server-state";
import { fromISO } from "@/lib/calendar/dates";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { MonthGrid } from "@/components/calendar/month-grid";
import { WeekGrid } from "@/components/calendar/week-grid";
import { EventModal, type EventFormValues } from "@/components/calendar/event-modal";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CalendarPicker } from "@/components/admin/calendar/calendar-picker";
import {
  createGoogleEvent,
  deleteGoogleEvent,
  updateGoogleEvent,
} from "@/lib/admin/google/calendar-actions";
import {
  insertBody,
  patchBody,
  stepCursor,
  toFormValues,
  toSegments,
  type AdminCalendarView,
} from "@/lib/admin/google/calendar/mapping";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import type {
  CalendarActionResult,
  GoogleCalendar,
  GoogleEventRef,
  GoogleEventRow,
} from "@/lib/admin/google/calendar/types";
import type { CalendarEvent } from "@/lib/calendar/calendar";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { calendarEventSlice, calendarSlice } from "@/lib/ai/admin/page-slices";

const VIEWS: readonly AdminCalendarView[] = ["month", "week"];

type ModalState = { mode: "create" } | { mode: "edit"; row: GoogleEventRow } | null;

function refOf(row: GoogleEventRow): GoogleEventRef {
  return {
    calendarId: row.calendarId,
    eventId: row.eventId,
    etag: row.etag,
    hasAttendees: row.attendees.length > 0,
  };
}

/** The row as the modal values leave it, drawn until Google's answer lands. */
function applyValues(row: GoogleEventRow, values: EventFormValues): GoogleEventRow {
  const initial = toFormValues(row);
  const moved =
    values.date !== initial.date ||
    values.allDay !== initial.allDay ||
    (!values.allDay && (values.start !== initial.start || values.end !== initial.end));
  return {
    ...row,
    title: values.title || "(No title)",
    location: values.location || undefined,
    description: values.description || undefined,
    attendees: values.people.map(
      (email) => row.attendees.find((a) => a.email.toLowerCase() === email.toLowerCase()) ?? { email }
    ),
    ...(moved
      ? {
          allDay: values.allDay,
          startDate: values.date,
          endDate: values.date,
          start: values.allDay ? undefined : values.start,
          end: values.allDay ? undefined : values.end,
        }
      : {}),
  };
}

/** The calendar a new event goes on: the first writable one shown, else the primary. */
function targetCalendar(calendars: GoogleCalendar[], selected: ReadonlySet<string>): GoogleCalendar | undefined {
  const writable = calendars.filter((c) => c.writable);
  return (
    writable.find((c) => selected.has(c.id)) ?? writable.find((c) => c.primary) ?? writable[0]
  );
}

/**
 * The admin's Google Calendar: the customer agenda (`CalendarView`) with its
 * toolbar, month and week grids and event modal, over Google instead of
 * `calendar_events`. The visible range and the chosen calendars live in the
 * URL, so each step reads Google live (plan D1). A calendar picker takes the
 * assignee filter's slot; there is no Tasks view.
 */
export function GoogleCalendarView({
  today,
  view: serverView,
  cursor: serverCursor,
  calendars,
  selected: serverSelected,
  rows: serverRows,
}: {
  today: string;
  view: AdminCalendarView;
  cursor: string;
  calendars: GoogleCalendar[];
  selected: string[];
  rows: GoogleEventRow[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [rows, setRows] = useServerState(serverRows);
  const [view, setView] = useServerState(serverView);
  const [cursorISO, setCursorISO] = useServerState(serverCursor);
  const [selected, setSelected] = useServerState<ReadonlySet<string>>(
    useMemo(() => new Set(serverSelected), [serverSelected])
  );
  const [modal, setModal] = useState<ModalState>(null);
  const [deleting, setDeleting] = useState<GoogleEventRow | null>(null);
  const cursor = useMemo(() => fromISO(cursorISO), [cursorISO]);

  usePageContextSlice(
    "admin-calendar",
    calendarSlice({
      view,
      range:
        view === "month"
          ? cursor.toLocaleString("en-US", { month: "long", year: "numeric" })
          : `the week of ${cursorISO}`,
      calendars: calendars.filter((c) => selected.has(c.id)).map((c) => c.name),
      rows,
    })
  );
  usePageContextSlice("admin-calendar-event", modal?.mode === "edit" ? calendarEventSlice(modal.row) : null);

  const { eventsByDate, rowBySegment } = useMemo(() => {
    const byDate = new Map<string, CalendarEvent[]>();
    const bySegment = new Map<string, GoogleEventRow>();
    for (const row of rows) {
      for (const segment of toSegments(row)) {
        bySegment.set(segment.id, row);
        const list = byDate.get(segment.date) ?? [];
        list.push(segment);
        byDate.set(segment.date, list);
      }
    }
    // The agenda's own order: all-day first, then by start.
    for (const list of byDate.values()) {
      list.sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) || (a.start ?? "").localeCompare(b.start ?? "")
      );
    }
    return { eventsByDate: byDate, rowBySegment: bySegment };
  }, [rows]);

  function go(next: { view?: AdminCalendarView; cursor?: string; selected?: ReadonlySet<string> }) {
    const params = new URLSearchParams();
    params.set("view", next.view ?? view);
    params.set("date", next.cursor ?? cursorISO);
    // Always carried, so a step to the next month keeps the calendars chosen.
    params.set("cal", [...(next.selected ?? selected)].join(","));
    startTransition(() => router.push(`/calendar?${params}`));
  }

  function handleView(next: AdminCalendarView) {
    setView(next);
    go({ view: next });
  }

  function navigate(delta: number) {
    const next = stepCursor(view, cursorISO, delta);
    setCursorISO(next);
    go({ cursor: next });
  }

  function handleSelected(next: ReadonlySet<string>) {
    setSelected(next);
    // Hidden at once; a newly shown calendar's events arrive with the read.
    setRows((prev) => prev.filter((r) => next.has(r.calendarId)));
    go({ selected: next });
  }

  function handleEventClick(event: CalendarEvent) {
    const row = rowBySegment.get(event.id);
    if (row) setModal({ mode: "edit", row });
  }

  /** Persist a write already drawn; tell the admin and restore on failure. */
  function persist(write: () => Promise<CalendarActionResult>, failure: string) {
    startTransition(async () => {
      try {
        const result = await write();
        if (!result.ok) toast.error(result.error);
      } catch (error) {
        console.error(failure, error);
        toast.error(failure);
      }
      // Always: on success it confirms the entry, on a failure or a 412 it
      // draws what Google actually has.
      router.refresh();
    });
  }

  function handleSubmit(values: EventFormValues) {
    if (modal?.mode === "edit") {
      const { row } = modal;
      const body = patchBody(row, values, ADMIN_TIME_ZONE);
      if (!body) return;
      setRows((prev) => prev.map((r) => (r.key === row.key ? applyValues(r, values) : r)));
      persist(() => updateGoogleEvent(refOf(row), body), "Couldn't save the event.");
      return;
    }
    const calendar = targetCalendar(calendars, selected);
    if (!calendar) {
      toast.error("None of your calendars can be written to.");
      return;
    }
    const local: GoogleEventRow = {
      key: `local|${crypto.randomUUID()}`,
      calendarId: calendar.id,
      eventId: "",
      etag: "",
      title: values.title,
      allDay: values.allDay,
      startDate: values.date,
      endDate: values.date,
      start: values.allDay ? undefined : values.start,
      end: values.allDay ? undefined : values.end,
      location: values.location || undefined,
      description: values.description || undefined,
      attendees: values.people.map((email) => ({ email })),
      color: calendar.color,
      // Not editable until Google has given it an id and an etag.
      writable: false,
    };
    setRows((prev) => [...prev, local]);
    persist(
      () => createGoogleEvent(calendar.id, insertBody(values, ADMIN_TIME_ZONE)),
      "Couldn't add the event."
    );
  }

  function handleConfirmDelete() {
    const row = deleting;
    if (!row) return;
    setRows((prev) => prev.filter((r) => r.key !== row.key));
    persist(() => deleteGoogleEvent(refOf(row)), "Couldn't delete the event.");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CalendarToolbar
        view={view}
        onView={(next) => {
          if (next !== "board") handleView(next);
        }}
        views={VIEWS}
        cursor={cursor}
        onPrev={() => navigate(-1)}
        onNext={() => navigate(1)}
        onNewEvent={() => setModal({ mode: "create" })}
        filter={
          <CalendarPicker calendars={calendars} selected={selected} onChange={handleSelected} />
        }
      />
      {view === "month" ? (
        <MonthGrid
          cursor={cursor}
          today={today}
          eventsByDate={eventsByDate}
          onEventClick={handleEventClick}
          onEventDelete={(event) => setDeleting(rowBySegment.get(event.id) ?? null)}
        />
      ) : (
        <WeekGrid
          cursor={cursor}
          today={today}
          eventsByDate={eventsByDate}
          onEventClick={handleEventClick}
          onEventDelete={(event) => setDeleting(rowBySegment.get(event.id) ?? null)}
        />
      )}

      <EventModal
        open={modal !== null}
        mode={modal?.mode ?? "create"}
        people={[]}
        guests
        subtitle={null}
        readOnly={modal?.mode === "edit" && !modal.row.writable}
        initial={
          modal?.mode === "edit"
            ? toFormValues(modal.row)
            : {
                title: "",
                date: cursorISO,
                allDay: false,
                start: "",
                end: "",
                location: "",
                people: [],
                description: "",
              }
        }
        onClose={() => setModal(null)}
        onSubmit={handleSubmit}
        // Close the editor first: the confirm dialog replaces it rather than
        // stacking on top of it.
        onDelete={
          modal?.mode === "edit"
            ? () => {
                const { row } = modal;
                setModal(null);
                setDeleting(row);
              }
            : undefined
        }
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
        title={deleting ? `Delete ${deleting.title}?` : "Delete?"}
        description="This permanently removes the event. This can't be undone."
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
