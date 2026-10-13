import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasBrevo, sendBrevoEmail } from "@/lib/email/brevo";
import { buildNotificationEmail } from "@/lib/notifications/email";

/**
 * Email a customer that staff replied to their thread.
 *
 * The mirror of `ae-alert.ts` (user -> staff) for the other direction, sent
 * inline for the same reason that one is: the notification dispatch webhook
 * is a no-op until `notification_config.notify_url` is set, so the DB
 * trigger's row is in-app only (migration 2026072001000). The in-app bell
 * still comes from that trigger; this is only the email half.
 *
 * Gated on the owner's own `support_reply` email preference (default on).
 * Best effort: a send failure is logged, never thrown, so a reply is never
 * lost because the mail was.
 */
export async function notifyThreadOwnerOfReply(
  admin: SupabaseClient,
  input: { ownerId: string; ownerEmail: string | null; subject: string; body: string }
): Promise<void> {
  if (!input.ownerEmail) return;
  if (!hasBrevo()) {
    console.warn("notifyThreadOwnerOfReply: Brevo is not configured; skipping");
    return;
  }
  const { data: pref } = await admin
    .from("notification_preferences")
    .select("email_enabled")
    .eq("user_id", input.ownerId)
    .eq("type", "support_reply")
    .maybeSingle<{ email_enabled: boolean }>();
  if (pref && !pref.email_enabled) return;

  const built = buildNotificationEmail("support_reply", {
    subject: input.subject,
    body: input.body,
  });
  if (!built) return;
  const { subject, htmlContent, textContent } = built;
  try {
    await sendBrevoEmail({ to: [{ email: input.ownerEmail }], subject, htmlContent, textContent });
  } catch (err) {
    console.error("notifyThreadOwnerOfReply: send failed", err instanceof Error ? err.message : err);
  }
}
