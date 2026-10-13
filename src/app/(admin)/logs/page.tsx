import { requireAdminPage } from "@/lib/auth/platform-admin";
import { isMissingTable, searchLogs } from "@/lib/admin/logs";
import { PAGE_SIZE, parseLogParams, toLogFilter } from "@/lib/admin/log-params";
import { LogsWorkspace } from "@/components/admin/logs/logs-workspace";

export const metadata = { title: "Logs" };

/**
 * The app's server logs (Vercel's drained lines plus our own uncaught-error rows, see
 * `lib/logs/`), newest first and filtered by the URL. Kept 30 days.
 */
export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage("logs");
  const params = parseLogParams(await searchParams);
  const now = new Date();
  // The one failure worth naming: the table is not in this database yet.
  const lines = await searchLogs(toLogFilter(params, now.getTime())).catch((err: unknown) => {
    if (isMissingTable(err)) return null;
    throw err;
  });
  return (
    <LogsWorkspace
      params={params}
      lines={lines ?? []}
      hasMore={lines?.length === PAGE_SIZE}
      missingTable={lines === null}
    />
  );
}
