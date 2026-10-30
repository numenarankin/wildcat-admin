import { bookingAuth } from "@/lib/admin/booking/auth";
import { confirmBooking } from "@/lib/admin/booking/confirm";
import { confirmInput } from "@/lib/admin/booking/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Books a demo slot (docs/plans/demo-booking.md). Called only by the landing's
 * /api/book/confirm with the shared secret. A slot that is no longer open
 * answers `{ ok: false, reason: "taken" }`.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = bookingAuth(req);
  if (auth === "unconfigured") return new Response("Not configured", { status: 503 });
  if (auth === "unauthorized") return new Response("Unauthorized", { status: 401 });

  const parsed = confirmInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "input" }, { status: 400 });

  try {
    return Response.json(await confirmBooking(parsed.data));
  } catch (err) {
    console.error("[booking] confirm failed", err);
    return Response.json({ error: "unavailable" }, { status: 502 });
  }
}
