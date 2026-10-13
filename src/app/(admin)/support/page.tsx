import { requireAdminPage } from "@/lib/auth/platform-admin";
import { getStaffSupportThreads } from "@/lib/support/staff-threads";
import { StaffSupportWorkspace } from "@/components/admin/support/staff-support-workspace";

export const metadata = { title: "Support" };

/** The staff desk: every customer's support threads, answered from here. */
export default async function AdminSupportPage() {
  await requireAdminPage("support");
  const threads = await getStaffSupportThreads();
  return <StaffSupportWorkspace initialThreads={threads} />;
}
