import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { googleAdminId } from "@/lib/admin/google/guard";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { loadCalendar } from "@/lib/admin/google/calendar/client";
import { visibleRange, wallTime, type AdminCalendarView } from "@/lib/admin/google/calendar/mapping";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { GoogleCalendarView } from "@/components/admin/calendar/google-calendar-view";

export const metadata = { title: "Calendar" };

const CONNECTIONS = "/settings?section=connections";
const NOT_CONNECTED = "Calendar isn't connected. Connect it in Settings > Connections.";
const REAUTH = "Google needs to be reconnected in Settings > Connections.";

/** A page-level message, with "Settings > Connections" linking there. */
function CalendarMessage({ text }: { text: string }) {
  const [before, after] = text.split("Settings > Connections");
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">
        {before}
        {after !== undefined && (
          <>
            <Link href={CONNECTIONS} className="font-medium text-foreground underline underline-offset-4">
              Settings &gt; Connections
            </Link>
            {after}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The admin's own Google Calendar, read live (plan D1) for the visible range:
 * docs/plans/google-integration.md sections 6 and 7.2.
 */
export default async function AdminCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; cal?: string }>;
}) {
  await requireAdminPage("calendar");
  const [settings, userId, params] = await Promise.all([getGoogleSettings(), googleAdminId(), searchParams]);
  if (!userId) return null;
  if (!settings) return <CalendarMessage text="Couldn't read the Google connection." />;
  if (settings.needsReauth) return <CalendarMessage text={REAUTH} />;
  if (!settings.services.includes("calendar")) return <CalendarMessage text={NOT_CONNECTED} />;

  const today = wallTime(new Date(), ADMIN_TIME_ZONE).date;
  const view: AdminCalendarView = params.view === "week" ? "week" : "month";
  const cursor = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? "") ? params.date! : today;
  const selected = params.cal === undefined ? null : params.cal.split(",").filter(Boolean);

  let data: Awaited<ReturnType<typeof loadCalendar>>;
  try {
    data = await loadCalendar(userId, {
      range: visibleRange(view, cursor, ADMIN_TIME_ZONE),
      selected,
      zone: ADMIN_TIME_ZONE,
    });
  } catch (error) {
    console.error("AdminCalendarPage: Google read failed", error);
    return <CalendarMessage text={googleErrorMessage(error, "Calendar")} />;
  }

  return (
    <GoogleCalendarView
      today={today}
      view={view}
      cursor={cursor}
      calendars={data.calendars}
      selected={data.selected}
      rows={data.rows}
    />
  );
}
