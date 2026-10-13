/**
 * Server-only read access to the caller's organization row (the org they own or
 * are an active member of, resolved by RLS via `current_org_id()`). Kept apart
 * from `./org` (pure types) so client bundles don't drag in the server client.
 */

import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { uniqueReferralCode } from "@/lib/auth/referral";

export interface OrgInfo {
  id: string;
  name: string;
  referralCode: string | null;
  companyAddress: string | null;
  employeeCount: number | null;
  wellCount: number | null;
  recommendedTier: string | null;
  onboardingCompleted: boolean;
  /**
   * Whether the owner clicked the sign-up verification link. Onboarding is held
   * until they do; orgs created before that gate existed were backfilled true.
   */
  emailVerified: boolean;
  /** Org master toggle for proactive ingest ("scan uploaded documents"). */
  aiScanUploads: boolean;
}

interface OrgRow {
  id: string;
  name: string | null;
  referral_code: string | null;
  company_address: string | null;
  employee_count: number | null;
  well_count: number | null;
  recommended_tier: string | null;
  onboarding_completed_at: string | null;
  ai_scan_uploads: boolean | null;
  email_verified_at: string | null;
}

function mapOrg(r: OrgRow): OrgInfo {
  return {
    id: r.id,
    name: r.name ?? "",
    referralCode: r.referral_code,
    companyAddress: r.company_address,
    employeeCount: r.employee_count,
    wellCount: r.well_count,
    recommendedTier: r.recommended_tier,
    onboardingCompleted: r.onboarding_completed_at !== null,
    emailVerified: r.email_verified_at !== null,
    aiScanUploads: r.ai_scan_uploads ?? true,
  };
}

/**
 * The caller's org referral code, generating + persisting one if the row has
 * none yet (older orgs predate auto-generation at sign-up). Uses the admin
 * client because writing `organizations` is owner-only under RLS and the read
 * needs to see the freshly written value. Returns null only when billing isn't
 * configured or the org can't be resolved.
 */
export async function ensureReferralCode(): Promise<string | null> {
  if (!hasSupabase()) return null;
  try {
    const sb = await getSupabaseServer();
    const { data: orgId, error: orgErr } = await sb.rpc("current_org_id");
    if (orgErr || !orgId) return null;

    const admin = getSupabaseAdmin();
    const { data: org } = await admin
      .from("organizations")
      .select("referral_code")
      .eq("id", orgId)
      .maybeSingle<{ referral_code: string | null }>();
    if (org?.referral_code) return org.referral_code;

    const code = await uniqueReferralCode(admin);
    const { error: updErr } = await admin
      .from("organizations")
      .update({ referral_code: code })
      .eq("id", orgId);
    if (updErr) {
      console.error("ensureReferralCode update failed", updErr.message);
      return null;
    }
    return code;
  } catch (error) {
    console.error("ensureReferralCode failed", error);
    return null;
  }
}

/** The caller's org, or null when unavailable (unconfigured / no membership). */
export async function getOrgInfo(): Promise<OrgInfo | null> {
  if (!hasSupabase()) return null;
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb
      .from("organizations")
      .select(
        "id, name, referral_code, company_address, employee_count, well_count, recommended_tier, onboarding_completed_at, ai_scan_uploads, email_verified_at"
      )
      .maybeSingle();
    if (error) throw error;
    return data ? mapOrg(data as OrgRow) : null;
  } catch (error) {
    console.error("getOrgInfo failed", error);
    return null;
  }
}
