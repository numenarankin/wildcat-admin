/**
 * Helpers for presenting the signed-in user. The real identity comes from the
 * Supabase session (see `@/lib/auth/session`); these just derive friendly
 * display strings.
 */

/** A friendly first name from a profile name or, failing that, an email. */
export function displayFirstName(
  profileName?: string | null,
  email?: string | null
): string {
  const fromProfile = profileName?.trim().split(/\s+/)[0];
  if (fromProfile) return fromProfile;
  if (email) {
    const local = email.split("@")[0];
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return "there";
}
