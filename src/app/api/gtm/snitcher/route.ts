import { after } from "next/server";
import { getGtmDb, hasGtmDb } from "@/lib/admin/gtm/db";
import { fetchSessionLocation, parseDelivery, storeDelivery, verifySignature } from "@/lib/admin/gtm/snitcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bodies over this size are not kept (Snitcher's payloads are a few KB). */
const MAX_BODY_CHARS = 64_000;

/**
 * Snitcher's webhook (Settings > Integrations > Webhooks in Snitcher, pointed
 * here). Public: the proxy passes /api/* through.
 *
 * Every request is first kept raw in `snitcher_deliveries`, signed or not,
 * with what was made of it, so a delivery whose shape or signature we do not
 * handle yet is there to inspect rather than lost. Only a correctly signed
 * delivery with a company and a session becomes rows in `companies` and
 * `snitcher_sessions`; the location read from Snitcher's API runs after the
 * response. A database error answers 500 so Snitcher retries, and a retry
 * stores no session twice.
 */
export async function POST(req: Request): Promise<Response> {
  if (!hasGtmDb()) {
    console.error("[gtm/snitcher] not configured: set GTM_SUPABASE_URL and GTM_SUPABASE_SECRET_KEY");
    return new Response("Not configured", { status: 503 });
  }
  const db = getGtmDb();
  const raw = (await req.text()).slice(0, MAX_BODY_CHARS);
  const secret = process.env.SNITCHER_WEBHOOK_SECRET;
  const signed = Boolean(secret) && verifySignature(raw, req.headers.get("signature"), secret!);

  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Kept as text below.
  }
  const delivery = signed && body !== null ? parseDelivery(body) : null;
  const outcome = !signed ? "bad_signature" : body === null ? "bad_json" : !delivery ? "no_session" : "stored";

  const event = body && typeof body === "object" && "event" in body ? String((body as { event: unknown }).event) : null;
  const { data: kept, error: keepErr } = await db
    .from("snitcher_deliveries")
    .insert({ signature_valid: signed, event, payload: body, body_text: body === null ? raw : null, outcome })
    .select("id")
    .single();
  if (keepErr) console.error("[gtm/snitcher] could not keep the delivery", keepErr.message);

  if (!signed) return new Response("Bad signature", { status: 401 });
  if (body === null) return new Response("Bad JSON", { status: 400 });
  // A delivery with no session (a contacts reveal, a test of another shape) is kept above and stops here.
  if (!delivery) return Response.json({ stored: false, kept: kept?.id ?? null });

  try {
    await storeDelivery(db, delivery, body);
  } catch (err) {
    console.error("[gtm/snitcher] store failed", err);
    if (kept) await db.from("snitcher_deliveries").update({ outcome: "store_failed" }).eq("id", kept.id);
    return new Response("Store failed", { status: 500 });
  }
  after(async () => {
    const result = await fetchSessionLocation(db, delivery.session.uuid);
    if (result !== "located") console.warn(`[gtm/snitcher] location ${result} for ${delivery.session.uuid}`);
  });
  return Response.json({ stored: true, kept: kept?.id ?? null });
}
