import { requireAdminPage } from "@/lib/auth/platform-admin";
import { hasGtmDb } from "@/lib/admin/gtm/db";
import { readLanding } from "@/lib/admin/gtm/read";
import { readBookings } from "@/lib/admin/booking/read";
import { GtmWorkspace } from "@/components/admin/gtm/gtm-workspace";

export const metadata = { title: "GTM" };

/**
 * GTM: who comes to wildcatiq.ai and what they do there
 * (docs/plans/gtm-landing.md). Reads the GTM database, its own Supabase
 * project, through its secret key, so this page's gate and its actions' gate
 * are the only authorization on the path.
 */
export default async function AdminGtmPage() {
  await requireAdminPage("gtm");
  if (!hasGtmDb()) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        Set GTM_SUPABASE_URL and GTM_SUPABASE_SECRET_KEY to show the GTM data.
      </div>
    );
  }
  const [initial, bookings] = await Promise.all([readLanding({ days: 30 }), readBookings()]);
  return <GtmWorkspace initial={initial} bookings={bookings} />;
}
