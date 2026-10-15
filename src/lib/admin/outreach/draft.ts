"use server";

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getTarget } from "@/lib/admin/targets";
import { getProspectingSettings } from "@/lib/admin/outreach/settings";
import { fillTemplate, humanCompanyName, templateHtml } from "@/lib/admin/outreach/types";
import { cleanSignature } from "@/lib/admin/google/gmail/email-style";
import { htmlToText } from "@/lib/admin/outreach/page-fetch";
import { getCommodityQuotes } from "@/lib/pricing/feed";
import { FALLBACK_PRICES } from "@/lib/scout/revenue";

/**
 * The outreach email for an enrollment: the settings' subject and template
 * with their placeholders filled, word for word. The model's only job is the
 * {{company}} placeholder: how a person says the registered name. What the
 * user wrote in Settings is what goes out. A DRAFT: it comes back as data
 * for the compose card, where only the user's own click sends (or
 * schedules) it. Nothing here touches Gmail.
 */

const MODEL = "claude-opus-5";
const NAME_MAX = 60;

/**
 * The company's everyday name from the model ("MAXIMUS OPERATING, LTD." is
 * "Maximus"), with `humanCompanyName` as the answer when the model fails or
 * returns something that is not a name.
 */
async function shortCompanyName(registered: string): Promise<string> {
  const fallback = humanCompanyName(registered);
  try {
    const { text } = await generateText({
      model: anthropic(MODEL),
      system:
        "You are given an oil and gas operator's registered name as the Texas Railroad Commission prints it. Reply with only the name a person would use for it in a sentence, in normal casing: " +
        "drop legal suffixes (LLC, Inc, Corp, LP, Ltd) and trailing trade words (Operating, Oil, Gas, Energy, Resources, Exploration, Production, Petroleum, Company, roman numerals), keep what identifies them. " +
        "Initialisms stay capitals. Examples: 'MAXIMUS OPERATING, LTD.' -> 'Maximus'; 'FAIR OIL CORPORATION' -> 'Fair'; 'JMH PRODUCTION, LLC' -> 'JMH'; 'MARSHALL R. YOUNG OPERATING, LLC' -> 'Marshall R. Young'; " +
        "'CROSS TIMBERS ENERGY, LLC' -> 'Cross Timbers'; 'ENERGY RESOURCES INC' -> 'Energy Resources'. No quotes, no explanation.",
      prompt: registered,
      providerOptions: { anthropic: { effort: "low" } },
      maxOutputTokens: 40,
    });
    const name = text.trim().replace(/^["']|["']$/g, "").trim();
    if (!name || name.length > NAME_MAX || /\n/.test(name)) return fallback;
    return name;
  } catch (error) {
    console.error("shortCompanyName failed", error instanceof Error ? error.message : error);
    return fallback;
  }
}

export interface OutreachDraft {
  enrollmentId: string;
  to: string;
  subject: string;
  /** The HTML as text, for the page context and anything that cannot show markup. */
  body: string;
  /** The composer's HTML: the template's formatting kept, rewritten for the recipient. */
  html: string;
}

interface EnrollmentRow {
  id: string;
  operator_no: number;
  step_index: number;
  admin_target_contacts: { name: string | null; title: string | null; email: string | null } | null;
}

export async function draftOutreachEmail(enrollmentId: string): Promise<OutreachDraft> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const sb = await getSupabaseServer();
  const { data: e, error } = await sb
    .from("admin_sequence_enrollments")
    .select("id, operator_no, step_index, admin_target_contacts(name, title, email)")
    .eq("id", enrollmentId)
    .maybeSingle<EnrollmentRow>();
  if (error) throw new Error(`draftOutreachEmail: ${error.message}`);
  if (!e) throw new Error("No such enrollment.");

  const quotes = await getCommodityQuotes().catch(() => []);
  const prices = {
    oilPerBbl: quotes.find((q) => q.label === "WTI")?.price ?? FALLBACK_PRICES.oilPerBbl,
    gasPerMcf: quotes.find((q) => q.label === "Nat Gas")?.price ?? FALLBACK_PRICES.gasPerMcf,
  };
  const [target, settings] = await Promise.all([getTarget(e.operator_no, prices), getProspectingSettings()]);
  if (!target) throw new Error("The target is no longer on the list.");

  const contact = e.admin_target_contacts;
  const firstName = (contact?.name ?? "").trim().split(/\s+/)[0] || "there";
  const companyName = await shortCompanyName(target.name);
  const fields = {
    first_name: firstName,
    company: companyName,
    wells: target.activeWells.toLocaleString(),
    county: target.counties[0] ?? "your",
  };
  const filled = fillTemplate(templateHtml(settings.template), fields);
  const fixedSubject = fillTemplate(settings.subject, fields).trim();

  const html = cleanSignature(filled);
  return {
    enrollmentId,
    to: contact?.email ? (contact.name ? `${contact.name} <${contact.email}>` : contact.email) : "",
    subject: fixedSubject || `WildcatIQ for ${companyName}`,
    body: htmlToText(html),
    html,
  };
}
