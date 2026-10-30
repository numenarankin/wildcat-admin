import { getGtmDb, hasGtmDb } from "@/lib/admin/gtm/db";
import { fetchSessionLocation, pendingLocations } from "@/lib/admin/gtm/snitcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Rows retried per run: one API call each, well inside Snitcher's 60 a minute. */
const PER_RUN = 30;
/** A row this old is no longer retried; Snitcher's listing is by date, and it has had its chances. */
const WITHIN_DAYS = 7;

/**
 * Hourly (vercel.json): the Snitcher sessions whose location read failed or
 * found no match when their webhook landed, read again. Verifies
 * `CRON_SECRET` the way the other crons do.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!hasGtmDb()) return Response.json({ error: "GTM database not configured" }, { status: 500 });
  if (!process.env.SNITCHER_API_TOKEN) return Response.json({ error: "SNITCHER_API_TOKEN is not set" }, { status: 500 });

  const db = getGtmDb();
  const pending = await pendingLocations(db, PER_RUN, WITHIN_DAYS);
  const tally: Record<string, number> = {};
  for (const uuid of pending) {
    const result = await fetchSessionLocation(db, uuid);
    tally[result] = (tally[result] ?? 0) + 1;
  }
  return Response.json({ tried: pending.length, ...tally });
}
