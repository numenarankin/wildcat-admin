/**
 * Pure helpers and shared types for account recovery — input normalization, the
 * throttle decision, and the shapes the browser sees. Separated from
 * `./account-recovery` because that file is a `"use server"` module (every
 * runtime export must be an async action) and because these are the parts worth
 * testing without a database.
 */

/** What the browser learns about one matched account. */
export interface RecoveryMatch {
  /** `ra***n@gmail.com` — enough to recognize, not enough to use. */
  maskedEmail: string;
  /**
   * The org whose name matched, shown so an operator with logins at more than
   * one company can tell which workspace this one belongs to. Null when the
   * member has no org.
   */
  company: string | null;
  /** Opaque handle standing in for the real address, good for 15 minutes. */
  token: string;
}

export interface RecoveryResult {
  matches: RecoveryMatch[];
  /**
   * True when the IP has spent its attempts. `matches` is then empty and says
   * nothing about whether an account exists — the limit is per caller, not per
   * account.
   */
  throttled: boolean;
}

/**
 * How many attempts one IP gets per window, by kind.
 *
 * `lookup` is the looser of the two: it is a search, and an operator who cannot
 * remember their email will legitimately try "wildcat", then "wildcat energy",
 * then their phone. `reset` is tighter because each one sends mail to a real
 * inbox, so the cost of abuse lands on a third party.
 */
export const RECOVERY_LIMITS = {
  lookup: 10,
  reset: 5,
} as const;

export type RecoveryKind = keyof typeof RECOVERY_LIMITS;

/** The rolling window both limits are measured over. */
export const RECOVERY_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long a recovery handle stands in for an address. Short: it exists only to
 * bridge the seconds between "here is a masked address" and the click on "send
 * the link there", and it is the one object in this flow that maps back to a
 * real email.
 */
export const RECOVERY_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Minimum characters before a company query is worth running. */
export const MIN_COMPANY_QUERY = 2;

/**
 * Minimum password length for any NEWLY set password (sign-up, reset, change).
 * Supabase enforces its own project-level floor; this is the app's, applied at
 * every place a password is chosen so the three flows cannot drift apart.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Digits only, then the last 10. Operators enter "(432) 555-0134",
 * "432-555-0134", and "+1 432 555 0134" for the same phone, and the number they
 * gave us at signup was typed just as freely — comparing the last 10 digits
 * makes every one of those match without a phone-parsing dependency.
 *
 * Returns "" when fewer than 10 digits are present, which reads as "no usable
 * phone query" to callers rather than as a prefix to match loosely on.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/** A trimmed company query, or "" when it is too short to search on. */
export function normalizeCompany(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length >= MIN_COMPANY_QUERY ? trimmed : "";
}

/**
 * Whether a recovery request carries anything worth looking up. A blank form
 * must not reach the database: with both fields empty the lookup would match on
 * nothing, but it would still cost an attempt and a query.
 */
export function hasUsableQuery(company: string, phone: string): boolean {
  return normalizeCompany(company) !== "" || normalizePhone(phone) !== "";
}

/** Whether an attempt count already recorded in the window exhausts the limit. */
export function isThrottled(kind: RecoveryKind, attemptsInWindow: number): boolean {
  return attemptsInWindow >= RECOVERY_LIMITS[kind];
}

/**
 * Complaint about a proposed password, or null when it is acceptable.
 * Shared by the reset page and the Settings change-password card so both refuse
 * the same inputs with the same words.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
