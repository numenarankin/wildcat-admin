import { evenSplitPercents } from "@/lib/tanks/allocation";

/**
 * The battery split rule, pure, so the server (`addBatteryMembers` and
 * `setBatteryMembers` in `./allocations`) and the facilities lab's sandbox
 * apply the same one.
 *
 * A battery's split starts EVEN, and stays even as wells join or leave, for as
 * long as it is still the even split: one well 100%, two 50 / 50, three
 * 33.34 / 33.33 / 33.33. Once the operator has set other shares, a well joining
 * lands at 0% and one leaving takes only its own row, so the shares they set
 * are never rewritten.
 */

export interface Share {
  wellId: string;
  straightPct: number;
}

/** True when these shares are the even split across their wells (or empty). */
export function isEvenShares(rows: Share[]): boolean {
  if (rows.length === 0) return true;
  if (new Set(rows.map((r) => r.wellId)).size !== rows.length) return false;
  const want = evenSplitPercents(rows.length).map(Number).sort((a, b) => a - b);
  const have = rows.map((r) => Number(r.straightPct)).sort((a, b) => a - b);
  return want.every((w, i) => Math.abs(w - have[i]) < 0.005);
}

/** Shares for exactly `wellIds`, evenly, in that order. */
export function evenShares(wellIds: string[]): Share[] {
  const pcts = evenSplitPercents(wellIds.length);
  return wellIds.map((wellId, i) => ({ wellId, straightPct: Number(pcts[i]) }));
}

/**
 * A battery's shares after its members become exactly `wanted`: respread
 * evenly when `current` is even, else the current shares kept, wells gone
 * dropped, newcomers at 0%. Members already there keep their order, so the
 * hundredth an uneven split hands out goes to the same wells as before.
 */
export function membersAfter(current: Share[], wanted: string[]): Share[] {
  const ids = [...new Set(wanted.filter(Boolean))];
  const order = [
    ...current.map((r) => r.wellId).filter((w) => ids.includes(w)),
    ...ids.filter((w) => !current.some((r) => r.wellId === w)),
  ];
  if (isEvenShares(current)) return evenShares([...new Set(order)]);
  return [
    ...current.filter((r) => ids.includes(r.wellId)),
    ...ids
      .filter((w) => !current.some((r) => r.wellId === w))
      .map((wellId) => ({ wellId, straightPct: 0 })),
  ];
}
