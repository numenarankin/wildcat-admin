import { z } from "zod";
import { bookingAuth } from "@/lib/admin/booking/auth";
import { handleNewBooking } from "@/lib/admin/booking/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const input = z.object({ bookingId: z.uuid() });

/**
 * A booking the landing just wrote: puts it on the owner's calendar and sends
 * the visitor's confirmation from the owner's Gmail. Shared secret only.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = bookingAuth(req);
  if (auth === "unconfigured") return new Response("Not configured", { status: 503 });
  if (auth === "unauthorized") return new Response("Unauthorized", { status: 401 });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "input" }, { status: 400 });
  try {
    return Response.json(await handleNewBooking(parsed.data.bookingId));
  } catch (err) {
    console.error("[booking] new booking failed", err);
    return Response.json({ error: "unavailable" }, { status: 502 });
  }
}
