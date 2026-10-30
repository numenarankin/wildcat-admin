import { requireAdminPage } from "@/lib/auth/platform-admin";
import { hasGtmDb } from "@/lib/admin/gtm/db";
import { readBookings } from "@/lib/admin/booking/read";
import { BookingsTable } from "@/components/admin/bookings/bookings-table";

export const metadata = { title: "Bookings" };
export const dynamic = "force-dynamic";

/**
 * On-site demos booked from the landing's /book (docs/plans/demo-booking.md),
 * from the GTM database. Hovering a row reveals Cancel.
 */
export default async function AdminBookingsPage() {
  await requireAdminPage("bookings");
  if (!hasGtmDb()) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        Set GTM_SUPABASE_URL and GTM_SUPABASE_SECRET_KEY to show bookings.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 px-1 pb-2">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Bookings</h1>
      <BookingsTable bookings={await readBookings()} />
    </div>
  );
}
