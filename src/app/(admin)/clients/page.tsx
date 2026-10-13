import { CustomersTable } from "@/components/admin/customers-table";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { listCustomers } from "@/lib/admin/customers";

export const metadata = { title: "Clients" };

/**
 * Every paying-or-could-be-paying account, one row each: the dashboard's
 * customers table on its own page. `listCustomers()` already leaves out the
 * orgs labelled demo or test in /admin/settings > Users, so this is the same
 * set the revenue figures count.
 */
export default async function AdminClientsPage() {
  await requireAdminPage("clients");
  const customers = await listCustomers();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Clients</h1>
      <CustomersTable rows={customers} />
    </div>
  );
}
