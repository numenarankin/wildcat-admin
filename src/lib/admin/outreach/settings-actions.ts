"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { isSendSchedule, type ProspectingSettings } from "@/lib/admin/outreach/types";

const TEMPLATE_MAX = 20_000;

/** Save the page's template and schedules; the row is the caller's own. */
export async function saveProspectingSettings(
  input: ProspectingSettings
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isPlatformAdmin())) return { ok: false, error: "Not found." };
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in required." };
  const template = String(input.template ?? "");
  if (template.length > TEMPLATE_MAX) return { ok: false, error: "The template is too long." };
  const schedules = Array.isArray(input.schedules) ? input.schedules.filter(isSendSchedule) : [];
  if (schedules.some((s) => !s.name.trim())) return { ok: false, error: "Every schedule needs a name." };
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("admin_prospecting_settings")
    .upsert({ user_id: user.id, template, schedules }, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  for (const p of ["/prospecting", "/outbound"]) revalidatePath(p);
  return { ok: true };
}
