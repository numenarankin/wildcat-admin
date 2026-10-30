import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The landing's relay is the only caller of the booking routes; it sends
 * `Authorization: Bearer <BOOKING_API_SECRET>`. Null secret = not configured.
 */
export function bookingAuth(req: Request): "ok" | "unauthorized" | "unconfigured" {
  const secret = process.env.BOOKING_API_SECRET;
  if (!secret) return "unconfigured";
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return given && timingSafeEqual(a, b) ? "ok" : "unauthorized";
}
