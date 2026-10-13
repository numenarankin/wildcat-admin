import "server-only";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import {
  DEFAULT_EMAIL_SETTINGS,
  isEmailFont,
  isEmailSize,
  type EmailSettings,
} from "@/lib/admin/google/gmail/email-style";

/**
 * The session admin's email settings (`admin_email_settings`, migration
 * 2026100800100), read through RLS. Defaults when there is no row yet, and
 * when the table isn't there yet (before the migration is pushed), so /email
 * and Send keep working either way.
 */
export async function getEmailSettings(): Promise<EmailSettings> {
  const user = await getSessionUser();
  if (!user) return DEFAULT_EMAIL_SETTINGS;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_email_settings")
    .select("font_family, font_size, signature_html")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("getEmailSettings failed", error.message);
    return DEFAULT_EMAIL_SETTINGS;
  }
  if (!data) return DEFAULT_EMAIL_SETTINGS;
  return {
    fontFamily: isEmailFont(data.font_family) ? data.font_family : DEFAULT_EMAIL_SETTINGS.fontFamily,
    fontSize: isEmailSize(data.font_size) ? data.font_size : DEFAULT_EMAIL_SETTINGS.fontSize,
    signatureHtml: data.signature_html ?? "",
  };
}
