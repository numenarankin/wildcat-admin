import { after } from "next/server";
import { getGtmDb, hasGtmDb } from "@/lib/admin/gtm/db";
import { fetchSessionLocation, parseDelivery, storeDelivery, verifySignature } from "@/lib/admin/gtm/snitcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Snitcher's webhook (Settings > Integrations > Webhooks in Snitcher, pointed
 * here). Public: the proxy passes /api/* through, and the signature is the
 * only gate, so an unsigned or mis-signed delivery is refused and nothing is
 * written. A stored delivery answers 200 at once; the location read from
 * Snitcher's API runs after the response. A database error answers 500 so
 * Snitcher retries, and the retry stores nothing twice.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.SNITCHER_WEBHOOK_SECRET;
  if (!secret || !hasGtmDb()) {
    console.error("[gtm/snitcher] not configured: set SNITCHER_WEBHOOK_SECRET, GTM_SUPABASE_URL and GTM_SUPABASE_SECRET_KEY");
    return new Response("Not configured", { status: 503 });
  }

  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("signature"), secret)) {
    return new Response("Bad signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const delivery = parseDelivery(body);
  // A delivery with no session (a contacts reveal) has nothing for this table.
  if (!delivery) return Response.json({ stored: false });

  const db = getGtmDb();
  try {
    await storeDelivery(db, delivery, body);
  } catch (err) {
    console.error("[gtm/snitcher] store failed", err);
    return new Response("Store failed", { status: 500 });
  }
  after(async () => {
    const result = await fetchSessionLocation(db, delivery.session.uuid);
    if (result !== "located") console.warn(`[gtm/snitcher] location ${result} for ${delivery.session.uuid}`);
  });
  return Response.json({ stored: true });
}
