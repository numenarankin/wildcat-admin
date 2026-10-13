/**
 * Picking the price a commodity traded at 24 hours ago, out of a series of
 * intraday bars. Lives apart from `feed.ts` so it is testable without the
 * server-only fetch layer around it.
 */

/** A day, in the epoch seconds Yahoo's chart endpoint speaks. */
export const DAY_SECONDS = 24 * 60 * 60;

/**
 * The last close at or before `cutoff`, or null when the series never reaches
 * back that far.
 *
 * `timestamps` is ascending epoch seconds and `closes` is its parallel array,
 * with nulls where a bar had no trades. An exact bar on the 24h mark usually
 * does not exist — futures halt for an hour a day and all weekend — so the bar
 * taken is the most recent one at or before the mark: the price that WAS in
 * force 24 hours ago. Across a closed weekend that is Friday's last print, so
 * the change correctly reads as no movement rather than as a jump.
 */
export function closeAtOrBefore(
  timestamps: number[],
  closes: (number | null | undefined)[],
  cutoff: number
): number | null {
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] > cutoff) continue;
    const close = closes[i];
    if (typeof close === "number") return close;
  }
  return null;
}
