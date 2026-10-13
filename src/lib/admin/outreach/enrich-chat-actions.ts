"use server";

import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getEnrichConversation } from "@/lib/ai/admin/conversations";
import { getTargetContacts, getTargetResearch } from "@/lib/admin/outreach/research";
import type { Conversation } from "@/lib/ai/conversations";
import type { TargetContact, TargetResearch } from "@/lib/admin/outreach/types";

/**
 * What the Enrich tab fetches when a company is picked: its chat so far and
 * its card. Reads only; the tab's writes are in `research-actions.ts`.
 */

async function requireAdmin() {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

export async function loadEnrichConversation(targetNo: number): Promise<Conversation | null> {
  await requireAdmin();
  return getEnrichConversation(targetNo);
}

export interface TargetCard {
  research: TargetResearch | null;
  contacts: TargetContact[];
}

export async function loadTargetCard(targetNo: number): Promise<TargetCard> {
  await requireAdmin();
  const [research, contacts] = await Promise.all([getTargetResearch(targetNo), getTargetContacts(targetNo)]);
  return { research, contacts };
}
