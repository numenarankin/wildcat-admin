import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { operatorPoints } from "@/lib/admin/targets";
import {
  type ContactSource,
  type EnrichQueueItem,
  type EnrichStatus,
  type TargetContact,
  type TargetResearch,
  type Verification,
  type WebsiteMatches,
} from "@/lib/admin/outreach/types";

/**
 * The Enrich tab's reads: the queue, a target's research and its contacts
 * (`admin_target_research`, `admin_target_contacts`, migration
 * 2026100800400). Request-scoped client; the policy is `is_platform_admin()`.
 */

export interface ResearchRow {
  operator_no: number;
  status: EnrichStatus;
  website: string | null;
  website_matches: WebsiteMatches | null;
  notes: string | null;
  queued_at: string;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  operator_no: number;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  source_url: string | null;
  confidence: number | null;
  generic: boolean;
  verification: string | null;
  decision_maker: boolean;
}

export const RESEARCH_COLS = "operator_no, status, website, website_matches, notes, queued_at, updated_at";
export const CONTACT_COLS =
  "id, operator_no, name, title, email, phone, source, source_url, confidence, generic, verification, decision_maker";

export function mapResearch(r: ResearchRow): TargetResearch {
  return {
    operatorNo: r.operator_no,
    status: r.status,
    website: r.website,
    websiteMatches: r.website_matches ?? {},
    notes: r.notes ?? "",
    queuedAt: r.queued_at,
    updatedAt: r.updated_at,
  };
}

const SOURCES: ContactSource[] = ["p5", "website", "hunter", "guess"];
const VERDICTS: Verification[] = ["deliverable", "risky", "undeliverable", "unknown"];

export function mapContact(r: ContactRow): TargetContact {
  return {
    id: r.id,
    operatorNo: r.operator_no,
    name: r.name,
    title: r.title,
    email: r.email,
    phone: r.phone,
    source: SOURCES.includes(r.source as ContactSource) ? (r.source as ContactSource) : "website",
    sourceUrl: r.source_url,
    confidence: r.confidence,
    generic: r.generic,
    verification: VERDICTS.includes(r.verification as Verification) ? (r.verification as Verification) : null,
    decisionMaker: r.decision_maker,
  };
}

/** Every queued target, oldest first within a status, with its name and size. */
export async function getEnrichQueue(): Promise<EnrichQueueItem[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_target_research")
    .select(`${RESEARCH_COLS}, admin_targets!inner(name, city, state)`)
    .order("queued_at", { ascending: true });
  if (error) throw new Error(`getEnrichQueue: ${error.message}`);
  const points = await operatorPoints();
  return ((data ?? []) as unknown as (ResearchRow & { admin_targets: { name: string; city: string | null; state: string | null } })[]).map(
    (r) => {
      const pt = points.get(r.operator_no);
      return {
        operatorNo: r.operator_no,
        name: r.admin_targets.name,
        city: r.admin_targets.city,
        state: r.admin_targets.state,
        activeWells: pt ? pt.wa ?? pt.w : 0,
        status: r.status,
        website: r.website,
        queuedAt: r.queued_at,
      };
    }
  );
}

export async function getTargetResearch(operatorNo: number): Promise<TargetResearch | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_target_research")
    .select(RESEARCH_COLS)
    .eq("operator_no", operatorNo)
    .maybeSingle<ResearchRow>();
  if (error) throw new Error(`getTargetResearch: ${error.message}`);
  return data ? mapResearch(data) : null;
}

/** A target's contacts: people first, generic mailboxes last, then by confidence. */
export async function getTargetContacts(operatorNo: number): Promise<TargetContact[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_target_contacts")
    .select(CONTACT_COLS)
    .eq("operator_no", operatorNo)
    .order("generic", { ascending: true })
    .order("confidence", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`getTargetContacts: ${error.message}`);
  return ((data ?? []) as ContactRow[]).map(mapContact);
}
