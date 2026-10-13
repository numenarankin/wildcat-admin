import { requireAdminPage } from "@/lib/auth/platform-admin";
import { buildAnalyticsDemo } from "@/lib/admin/analytics-demo";
import { AnalyticsWorkspace } from "@/components/admin/analytics/analytics-workspace";

export const metadata = { title: "Analytics" };

/** How customers use the app. Dummy data until events are tracked. */
export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  await requireAdminPage("analytics");
  const { section } = await searchParams;
  return <AnalyticsWorkspace data={buildAnalyticsDemo()} initialSection={section} />;
}
