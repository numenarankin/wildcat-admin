/**
 * The account labels, client-safe: `accounts.ts` reads with the service role
 * and is server-only, but the customer panel's dropdown needs the list.
 */
export const ACCOUNT_TYPES = ["customer", "demo", "test"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export function isAccountType(v: string): v is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(v);
}
