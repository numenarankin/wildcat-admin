"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { CONTACT_COLS, mapContact, type ContactRow } from "@/lib/admin/outreach/research";
import {
  isGenericEmail,
  type ContactSource,
  type EnrichStatus,
  type TargetContact,
  type Verification,
  type WebsiteMatches,
} from "@/lib/admin/outreach/types";

/**
 * Writes for the Enrich tab. The user's clicks and Orion's save tools both
 * land here; the request-scoped client and the `is_platform_admin()` policy
 * are the boundary. Nothing here sends anything anywhere.
 */

const PATH = "/prospecting";

async function requireAdmin() {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

/** Put a target on the Enrich queue. Already queued: left as it is. */
export async function queueTarget(operatorNo: number): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("admin_target_research")
    .upsert({ operator_no: operatorNo }, { onConflict: "operator_no", ignoreDuplicates: true });
  if (error) throw new Error(`queueTarget: ${error.message}`);
  revalidatePath(PATH);
}

/** Take a target off the queue: its research and contacts go with it. */
export async function dequeueTarget(operatorNo: number): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_target_research").delete().eq("operator_no", operatorNo);
  if (error) throw new Error(`dequeueTarget: ${error.message}`);
  revalidatePath(PATH);
}

/** Empty the Enrich queue: every target's research row goes, whatever its status. */
export async function clearQueue(): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_target_research").delete().gte("operator_no", 0);
  if (error) throw new Error(`clearQueue: ${error.message}`);
  revalidatePath(PATH);
}

export async function setResearchStatus(operatorNo: number, status: EnrichStatus): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_target_research").update({ status }).eq("operator_no", operatorNo);
  if (error) throw new Error(`setResearchStatus: ${error.message}`);
  revalidatePath(PATH);
}

/** The website Orion proposed (or the user corrected), with what it matched. */
export async function saveWebsite(
  operatorNo: number,
  website: string | null,
  matches: WebsiteMatches
): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("admin_target_research")
    .upsert(
      { operator_no: operatorNo, website, website_matches: matches, status: "researching" },
      { onConflict: "operator_no" }
    );
  if (error) throw new Error(`saveWebsite: ${error.message}`);
  revalidatePath(PATH);
}

export async function saveResearchNotes(operatorNo: number, notes: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("admin_target_research")
    .update({ notes: notes.slice(0, 20_000) })
    .eq("operator_no", operatorNo);
  if (error) throw new Error(`saveResearchNotes: ${error.message}`);
  revalidatePath(PATH);
}

export interface ContactInput {
  name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  source: ContactSource;
  sourceUrl?: string | null;
  confidence?: number | null;
  verification?: Verification | null;
  decisionMaker?: boolean;
}

/**
 * Add contacts for a target. An address already on file is updated in place
 * (name, title, source and score refreshed), so a second pass does not
 * duplicate it. Rows without an email are always new.
 */
export async function upsertContacts(operatorNo: number, inputs: ContactInput[]): Promise<TargetContact[]> {
  await requireAdmin();
  if (inputs.length === 0) return [];
  const sb = await getSupabaseServer();
  const out: TargetContact[] = [];
  for (const c of inputs) {
    const email = c.email?.trim().toLowerCase() || null;
    const row = {
      operator_no: operatorNo,
      name: c.name?.trim() || null,
      title: c.title?.trim() || null,
      email,
      phone: c.phone?.trim() || null,
      source: c.source,
      source_url: c.sourceUrl?.trim() || null,
      confidence: c.confidence == null ? null : Math.max(0, Math.min(100, Math.round(c.confidence))),
      generic: email ? isGenericEmail(email) : false,
      verification: c.verification ?? null,
      ...(c.decisionMaker === undefined ? {} : { decision_maker: c.decisionMaker }),
    };
    let existing: { id: string } | null = null;
    if (email) {
      const { data } = await sb
        .from("admin_target_contacts")
        .select("id")
        .eq("operator_no", operatorNo)
        .ilike("email", email)
        .maybeSingle<{ id: string }>();
      existing = data;
    }
    const q = existing
      ? sb.from("admin_target_contacts").update(row).eq("id", existing.id)
      : sb.from("admin_target_contacts").insert(row);
    const { data, error } = await q.select(CONTACT_COLS).single<ContactRow>();
    if (error) throw new Error(`upsertContacts: ${error.message}`);
    out.push(mapContact(data));
  }
  revalidatePath(PATH);
  return out;
}

export async function setDecisionMaker(contactId: string, decisionMaker: boolean): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_target_contacts").update({ decision_maker: decisionMaker }).eq("id", contactId);
  if (error) throw new Error(`setDecisionMaker: ${error.message}`);
  revalidatePath(PATH);
}

export async function deleteContact(contactId: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_target_contacts").delete().eq("id", contactId);
  if (error) throw new Error(`deleteContact: ${error.message}`);
  revalidatePath(PATH);
}
