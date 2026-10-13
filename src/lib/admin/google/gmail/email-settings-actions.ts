"use server";

import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { cleanSignature, isEmailFont, isEmailSize, type EmailSettings } from "@/lib/admin/google/gmail/email-style";

/** Save the session admin's email settings. RLS limits the row to their own. */
export async function saveEmailSettings(input: EmailSettings): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return { ok: false, error: "Not found." };
  if (!isEmailFont(input?.fontFamily) || !isEmailSize(input?.fontSize)) return { ok: false, error: "Unknown font or size." };
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_email_settings").upsert(
    {
      user_id: user.id,
      font_family: input.fontFamily,
      font_size: input.fontSize,
      signature_html: cleanSignature(String(input.signatureHtml ?? "")),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    console.error("saveEmailSettings failed", error.message);
    // The table isn't on this database yet (Postgres 42P01, PostgREST PGRST205).
    const missing = error.code === "42P01" || error.code === "PGRST205";
    return { ok: false, error: missing ? "Email settings need a database update first." : "Couldn't save." };
  }
  return { ok: true };
}
