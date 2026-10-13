import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import {
  isProspectStage,
  type Prospect,
  type ProspectStage,
} from "@/lib/admin/prospect-types";

/**
 * Sales prospects (`admin_prospects`), for /admin/sales.
 *
 * Request-scoped client: the table's policy is `is_platform_admin()`
 * (migration 2026091600500), so an outsider reads nothing and writes nothing
 * at the database, whatever the route did. The Prospects table and the
 * Pipeline board both render this one list; a prospect's `stage` is the
 * column it sits in.
 */

interface ProspectRow {
  id: string;
  company: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  county: string | null;
  wells: number | null;
  source: string | null;
  stage: string;
  notes: string | null;
  stage_changed_at: string;
  created_at: string;
}

const PROSPECT_COLS =
  "id, company, contact_name, email, phone, county, wells, source, stage, notes, stage_changed_at, created_at";

function mapProspect(r: ProspectRow): Prospect {
  return {
    id: r.id,
    company: r.company,
    contactName: r.contact_name ?? undefined,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    county: r.county ?? undefined,
    wells: r.wells ?? undefined,
    source: r.source ?? undefined,
    stage: isProspectStage(r.stage) ? r.stage : ("queue" as ProspectStage),
    notes: r.notes ?? undefined,
    stageChangedAt: r.stage_changed_at,
    createdAt: r.created_at,
  };
}

/** Every prospect, newest first. */
export async function getProspects(): Promise<Prospect[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_prospects")
    .select(PROSPECT_COLS)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getProspects: ${error.message}`);
  return ((data ?? []) as ProspectRow[]).map(mapProspect);
}
