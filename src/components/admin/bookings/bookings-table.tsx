"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SortableTable, type SortColumn } from "@/components/admin/analytics/sortable-table";
import { cancelBookingAction } from "@/lib/admin/booking/actions";
import type { BookingListRow } from "@/lib/admin/booking/read";

/** Demos are on-site in Central time, so they read in Central whatever the viewer's zone. */
const centralTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function BookingsTable({ bookings }: { bookings: BookingListRow[] }) {
  const [cancelling, setCancelling] = useState<BookingListRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const columns: SortColumn<BookingListRow>[] = [
    { key: "when", label: "When (Central)", numeric: false, sortValue: (r) => r.startsAt, cell: (r) => centralTime.format(new Date(r.startsAt)), className: "font-medium" },
    { key: "company", label: "Company", numeric: false, sortValue: (r) => r.company, cell: (r) => r.company },
    { key: "contact", label: "Contact", numeric: false, sortValue: (r) => r.name, cell: (r) => `${r.name} · ${r.email}`, className: "text-muted-foreground" },
    { key: "office", label: "Office", numeric: false, sortValue: (r) => r.address, cell: (r) => r.address, className: "text-muted-foreground" },
    {
      key: "calendar",
      label: "Calendar",
      numeric: false,
      sortValue: (r) => (r.onCalendar ? 1 : 0),
      cell: (r) => (r.onCalendar ? "On calendar" : <span className="text-destructive">Not on calendar</span>),
    },
    { key: "notes", label: "Notes", numeric: false, sortValue: (r) => r.notes ?? "", cell: (r) => r.notes ?? "", className: "max-w-64 truncate text-muted-foreground" },
    {
      key: "actions",
      label: "",
      numeric: true,
      sortValue: () => null,
      cell: (r) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setCancelling(r)}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          Cancel
        </Button>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <SortableTable rows={bookings} columns={columns} rowKey={(r) => r.id} defaultSort="when" defaultDirection="asc" empty="No demos booked." />
      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel this demo?"
        description={
          cancelling
            ? `${cancelling.company}, ${centralTime.format(new Date(cancelling.startsAt))}. ${cancelling.name} is emailed and the slot opens again.`
            : undefined
        }
        confirmLabel="Cancel demo"
        cancelLabel="Keep"
        destructive
        onConfirm={() => {
          const target = cancelling;
          if (!target) return;
          startTransition(async () => {
            try {
              const { calendar, email } = await cancelBookingAction(target.id);
              const misses = [
                !email && `the cancellation email to ${target.email} did not send`,
                !calendar && "the Google event could not be deleted",
              ].filter(Boolean);
              setError(misses.length ? `Cancelled, but ${misses.join(" and ")}.` : null);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not cancel that booking.");
            }
          });
        }}
      />
    </div>
  );
}
