import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";

/** One booking on the GTM page's Bookings tab. */
export interface BookingListRow {
  id: string;
  name: string;
  email: string;
  company: string;
  address: string;
  startsAt: string;
  notes: string | null;
  /** False when the Google event was never created: add it by hand. */
  onCalendar: boolean;
  createdAt: string;
}

/** Confirmed bookings from 30 days back onward. */
export async function readBookings(): Promise<BookingListRow[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await getGtmDb()
    .from("demo_bookings")
    .select("id, name, email, company, office_address, starts_at, notes, google_event_id, created_at")
    .eq("status", "confirmed")
    .gte("starts_at", since)
    .order("starts_at");
  if (error) throw new Error(`Bookings read failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    company: r.company,
    address: r.office_address,
    startsAt: r.starts_at,
    notes: r.notes,
    onCalendar: Boolean(r.google_event_id),
    createdAt: r.created_at,
  }));
}
