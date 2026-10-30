import { z } from "zod";
import { bookingAuth } from "@/lib/admin/booking/auth";
import { readBusy } from "@/lib/admin/booking/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const input = z.object({ timeMin: z.iso.datetime(), timeMax: z.iso.datetime() });

/** The owner's busy Google events in a range, for the landing's slot check. Shared secret only. */
export async function POST(req: Request): Promise<Response> {
  const auth = bookingAuth(req);
  if (auth === "unconfigured") return new Response("Not configured", { status: 503 });
  if (auth === "unauthorized") return new Response("Unauthorized", { status: 401 });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "input" }, { status: 400 });
  try {
    return Response.json({ events: await readBusy(parsed.data.timeMin, parsed.data.timeMax) });
  } catch (err) {
    console.error("[booking] busy read failed", err);
    return Response.json({ error: "unavailable" }, { status: 502 });
  }
}
