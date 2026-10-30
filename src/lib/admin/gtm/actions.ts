"use server";

import { assertAdminPage } from "@/lib/auth/platform-admin";
import { readLanding, readMapPoints, readVisitor } from "./read";
import type { GtmRange, LandingData, MapPoint, VisitorDetail } from "./types";

/**
 * The GTM page's reads, behind the page's own access: an admin whose list
 * does not open /gtm cannot reach its data through these either.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Only the page's own range choices; anything else is refused. */
function cleanRange(range: GtmRange): GtmRange {
  if ("days" in range) {
    if (range.days === 7 || range.days === 30 || range.days === 90) return { days: range.days };
  } else if (DATE.test(range.from) && DATE.test(range.to)) {
    return { from: range.from, to: range.to };
  }
  throw new Error("Unknown range.");
}

export async function getLandingData(range: GtmRange): Promise<LandingData> {
  await assertAdminPage("gtm");
  return readLanding(cleanRange(range));
}

export async function getLandingMap(range: GtmRange): Promise<MapPoint[]> {
  await assertAdminPage("gtm");
  return readMapPoints(cleanRange(range));
}

export async function getVisitorDetail(visitorId: string): Promise<VisitorDetail | null> {
  await assertAdminPage("gtm");
  if (!/^[0-9a-f-]{36}$/i.test(visitorId)) return null;
  return readVisitor(visitorId);
}
