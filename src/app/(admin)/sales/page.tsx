import { requireAdminPage } from "@/lib/auth/platform-admin";
import { getProspects } from "@/lib/admin/prospects";
import { getAdminTasks } from "@/lib/admin/tasks";
import { listPlatformAdmins } from "@/lib/admin/team";
import { SalesWorkspace } from "@/components/admin/sales/sales-workspace";

export const metadata = { title: "Sales" };

export default async function AdminSalesPage() {
  await requireAdminPage("sales");
  const [prospects, tasks, admins] = await Promise.all([
    getProspects(),
    getAdminTasks(),
    listPlatformAdmins(),
  ]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SalesWorkspace
        prospects={prospects}
        tasks={tasks}
        // The admin roster is the assignee list: the desk is the team's.
        assignees={admins.map((a) => a.email)}
      />
    </div>
  );
}
