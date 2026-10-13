import { requireAdminPage } from "@/lib/auth/platform-admin";

export const metadata = { title: "Finance" };

/** Blank for now; the chrome comes from the root layout. */
export default async function AdminFinancePage() {
  await requireAdminPage("finance");
  return null;
}
