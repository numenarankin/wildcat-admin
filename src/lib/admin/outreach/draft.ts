"use server";

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getTarget } from "@/lib/admin/targets";
import { getTargetContacts, getTargetResearch } from "@/lib/admin/outreach/research";
import { getProspectingSettings } from "@/lib/admin/outreach/settings";
import { fillTemplate } from "@/lib/admin/outreach/types";
import { bodyToHtml } from "@/lib/admin/google/gmail/draft-spec";
import { getCommodityQuotes } from "@/lib/pricing/feed";
import { FALLBACK_PRICES } from "@/lib/scout/revenue";

/**
 * Orion drafts one outreach email for an enrollment: the page template with
 * its placeholders filled, rewritten around what the research found. A
 * DRAFT: it comes back as data for the compose card, where only the user's
 * own click sends (or schedules) it. Nothing here touches Gmail.
 */

const MODEL = "claude-opus-5";
const SUBJECT_MAX = 200;
const BODY_MAX = 6_000;

export interface OutreachDraft {
  enrollmentId: string;
  to: string;
  subject: string;
  /** Plain text, blank lines between paragraphs. */
  body: string;
  /** The same as the composer's HTML. */
  html: string;
}

interface EnrollmentRow {
  id: string;
  operator_no: number;
  step_index: number;
  admin_target_contacts: { name: string | null; title: string | null; email: string | null } | null;
}

/** "Subject: …" on the first line, the body after a blank line. */
export async function parseDraft(text: string): Promise<{ subject: string; body: string }> {
  const m = text.match(/^\s*subject\s*:\s*(.+?)\s*\n+([\s\S]*)$/i);
  if (!m) return { subject: "", body: text.trim().slice(0, BODY_MAX) };
  return { subject: m[1].trim().slice(0, SUBJECT_MAX), body: m[2].trim().slice(0, BODY_MAX) };
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
  const [target, research, contacts, settings] = await Promise.all([
    getTarget(e.operator_no, prices),
    getTargetResearch(e.operator_no),
    getTargetContacts(e.operator_no),
    getProspectingSettings(),
  ]);
  if (!target) throw new Error("The target is no longer on the list.");

  const contact = e.admin_target_contacts;
  const firstName = (contact?.name ?? "").trim().split(/\s+/)[0] || "there";
  const companyName = target.name
    .replace(/\b(L\.?L\.?C\.?|INC\.?|CO\.?|CORP\.?|LTD\.?|L\.?P\.?)\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const filled = fillTemplate(settings.template, {
    first_name: firstName,
    company: companyName || target.name,
    wells: target.activeWells.toLocaleString(),
    county: target.counties[0] ?? "your",
  });

  const context = [
    `Company: ${target.name}; ${target.activeWells} active wells; counties: ${target.counties.join(", ") || "unknown"}.`,
    `Recipient: ${contact?.name ?? "unknown"}${contact?.title ? `, ${contact.title}` : ""}.`,
    research?.website ? `Website: ${research.website}.` : "Website: none found.",
    research?.notes ? `Research notes: ${research.notes}` : "",
    contacts.length ? `People on file: ${contacts.map((c) => [c.name, c.title].filter(Boolean).join(", ")).filter(Boolean).join("; ")}.` : "",
    `This is email number ${Math.floor(e.step_index / 2) + 1} of the sequence${e.step_index > 0 ? " (a follow-up; refer lightly to the earlier note, never apologize for following up)" : ""}.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { text } = await generateText({
    model: anthropic(MODEL),
    system:
      "You write short sales emails for WildcatIQ, software for small oil and gas operators. Rewrite the TEMPLATE for this recipient using the CONTEXT: keep its message, length and tone, make it specific to the company where the context allows, and never invent a fact that is not in the context. " +
      "Plain text, blank lines between paragraphs, no markdown, no sign-off (a signature is added automatically). Output exactly: a first line 'Subject: <subject>', a blank line, then the body.",
    prompt: `TEMPLATE (placeholders already filled):\n${filled}\n\nCONTEXT:\n${context}`,
    // A rewrite of a short template: no thinking phase to speak of.
    providerOptions: { anthropic: { effort: "low" } },
    maxOutputTokens: 1_200,
  });
  const { subject, body } = await parseDraft(text);
  return {
    enrollmentId,
    to: contact?.email ? (contact.name ? `${contact.name} <${contact.email}>` : contact.email) : "",
    subject: subject || `WildcatIQ for ${companyName || target.name}`,
    body,
    html: bodyToHtml(body),
  };
}
