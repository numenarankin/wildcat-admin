/**
 * The figures a Scout dossier states, computed once.
 *
 * These four used to exist twice: in the modal that renders them and again in
 * `@/lib/ai/scout-summary`, which has to say the same numbers in prose. Two
 * copies of a formatting rule is two answers waiting to disagree, and the one
 * place it would show is the one place it must not - a generated sentence
 * sitting directly above the row it describes.
 *
 * Pure and framework-free on purpose: the modals are `"use client"` and the
 * summary module is `"use server"`, so a shared helper cannot live in either
 * without one importing the other.
 *
 * The H-15 and P-5 STATUS tables are deliberately not here. P-5 is below
 * because nothing outside the dossiers reads it; H-15 already has one home in
 * `@/lib/scout/rrc-uic` and the copy this file replaced was wrong (see that
 * file's `H15_STATUS`).
 */

/** P-5 organisation status codes (A 295,540 · X 111,799 · D 28,730 · …). */
export const P5_ORG: Record<string, string> = {
  A: "Active",
  X: "Active (extension)",
  D: "Delinquent",
  H: "Active (hearing)",
  S: "See remarks",
  R: "Revoked",
  I: "Inactive",
};

/** "2 y 4 m" — the RRC's own inactivity clock, not a derived guess. */
export function idleFor(yrs: number | null, mos: number | null): string | null {
  if (yrs == null && mos == null) return null;
  const parts = [];
  if (yrs) parts.push(`${yrs} y`);
  if (mos) parts.push(`${mos} m`);
  return parts.length ? parts.join(" ") : "under a month";
}

/** Great-circle distance in feet, for the lateral length. */
export function lateralFeet(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const R = 20_902_231; // earth radius, feet
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * The stream's average MONTH over the trailing window, which is the unit every
 * single-value figure on Scout reads in. Divided by the months actually summed,
 * not the window width — an unreported month is unpublished, not zero, so a
 * lease with four filed months would otherwise read a third of its true rate.
 */
export function perMonthOf<T extends { reported: boolean }>(
  monthly: T[],
  key: keyof T,
  months = 12
): number {
  const window = monthly.filter((m) => m.reported).slice(-months);
  if (window.length === 0) return 0;
  return window.reduce((a, m) => a + (Number(m[key]) || 0), 0) / window.length;
}
