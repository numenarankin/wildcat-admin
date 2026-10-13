import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";

/**
 * Every org with its `account_type`, for /admin/settings > Users. The label
 * decides whether an org counts in the dashboard's figures (`customers.ts`
 * reads 'customer' rows only). Service-role read behind the admin check.
 */

import { isAccountType, type AccountType } from "@/lib/admin/account-types";
export { ACCOUNT_TYPES, isAccountType, type AccountType } from "@/lib/admin/account-types";

export interface AccountRow {
  orgId: string;
  name: string;
  email: string | null;
  accountType: AccountType;
  createdAt: string;
}

export async function listAccounts(): Promise<AccountRow[]> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const admin = getSupabaseAdmin();
  const [orgs, users] = await Promise.all([
    admin
      .from("organizations")
      .select("id, name, owner_uid, account_type, created_at")
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (error) throw new Error(`organizations: ${error.message}`);
        return (data ?? []) as { id: string; name: string; owner_uid: string; account_type: string; created_at: string }[];
      }),
    admin.auth.admin.listUsers({ perPage: 1000 }).then(({ data, error }) => {
      if (error) throw new Error(`auth users: ${error.message}`);
      return new Map(data.users.map((u) => [u.id, u.email ?? null]));
    }),
  ]);
  return orgs.map((o) => ({
    orgId: o.id,
    name: o.name,
    email: users.get(o.owner_uid) ?? null,
    accountType: isAccountType(o.account_type) ? o.account_type : "customer",
    createdAt: o.created_at,
  }));
}
