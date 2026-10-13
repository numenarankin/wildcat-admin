/**
 * Masking for the "recover my email" flow.
 *
 * The point of the flow is to jog a memory, not to answer "does this person have
 * an account". So the local part is reduced to a hint and the domain is shown in
 * full — `rankinpoage@gmail.com` becomes `ra***n@gmail.com`. The domain is not
 * sensitive (there are a handful of them in practice) and it is the part that
 * actually resolves the "was it my Gmail or my work address?" question this flow
 * exists to answer.
 *
 * The mask is a fixed three stars regardless of how much was hidden, so the
 * result does not disclose the length of the address.
 *
 * Pure and dependency-free so it can be unit-tested against hand-written
 * expectations; nothing here touches the database or the network.
 */

/** The fixed-width elision. Deliberately not sized to the hidden text. */
const STARS = "***";

/**
 * Mask the local part of an email, keeping the domain intact.
 *
 * How much of the local part survives depends on how much there is to spend —
 * a two-character local part has no leading and trailing characters to give away
 * without giving away the whole thing:
 *
 * | local length | shown            | example                        |
 * |--------------|------------------|--------------------------------|
 * | >= 5         | first 2 + last 1 | `rankinpoage` -> `ra***e`      |
 * | 4            | first 1 + last 1 | `jane`        -> `j***e`       |
 * | 3            | first 1          | `bob`         -> `b***`        |
 * | <= 2         | nothing          | `jd`          -> `***`         |
 *
 * Input that is not a single `local@domain` pair is returned fully masked rather
 * than passed through, so a malformed row can never leak an address by falling
 * out of the bottom of this function.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  // No domain to preserve, or an empty local part — nothing safe to show.
  if (at <= 0 || at === trimmed.length - 1) return STARS;

  // Lowercased for display: Supabase stores addresses folded already, and a
  // preserved capital would be one more character of the original given away.
  const local = trimmed.slice(0, at).toLowerCase();
  const domain = trimmed.slice(at + 1).toLowerCase();

  if (local.length <= 2) return `${STARS}@${domain}`;
  if (local.length === 3) return `${local.slice(0, 1)}${STARS}@${domain}`;

  const lead = local.length >= 5 ? local.slice(0, 2) : local.slice(0, 1);
  return `${lead}${STARS}${local.slice(-1)}@${domain}`;
}
