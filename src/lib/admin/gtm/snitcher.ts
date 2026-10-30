import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Snitcher's webhook into the GTM database (docs/plans/gtm-landing.md,
 * "Snitcher"), and the follow-up read of Snitcher's REST API for the
 * visitor's location, which the webhook does not carry.
 *
 * Configuration:
 *   SNITCHER_WEBHOOK_SECRET  the secret set on the webhook in Snitcher; required,
 *                            an unsigned delivery is refused
 *   SNITCHER_API_TOKEN       a personal access token, for the location read
 *   SNITCHER_WORKSPACE_UUID  optional; the delivery's own workspace id is used first
 */

const API = "https://api.snitcher.com/v1";
/** Our visit and Snitcher's must start this close to be the same visit. */
const SAME_VISIT_MS = 30 * 60_000;

/** HMAC-SHA256 of the raw body with the webhook secret, hex, compared in constant time. */
export function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** The parts of a delivery we store; null when it carries no session (a contacts reveal, say). */
export interface SnitcherDelivery {
  event: string;
  workspaceUuid: string | null;
  company: {
    uuid: string;
    name: string | null;
    domain: string | null;
    industry: string | null;
    employeeRange: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  };
  session: { uuid: string; startedAt: string | null; pagesViewed: number | null; referrer: string | null };
}

export function parseDelivery(body: unknown): SnitcherDelivery | null {
  const root = obj(body);
  const company = obj(root?.company);
  const session = obj(root?.session);
  const companyUuid = str(company?.uuid);
  const sessionUuid = str(session?.uuid);
  if (!root || !companyUuid || !sessionUuid) return null;
  const location = obj(company?.location);
  return {
    event: str(root.event) ?? "unknown",
    workspaceUuid: str(obj(root.workspace)?.uuid),
    company: {
      uuid: companyUuid,
      name: str(company?.name),
      domain: str(company?.domain),
      industry: str(company?.industry),
      employeeRange: str(company?.employee_range),
      city: str(location?.city),
      state: str(location?.region) ?? str(location?.state),
      country: str(location?.country),
    },
    session: {
      uuid: sessionUuid,
      startedAt: str(session?.started_at),
      pagesViewed: int(session?.pages_viewed),
      referrer: str(session?.referrer),
    },
  };
}

/**
 * Store a delivery: the company upserted, the session written once by
 * Snitcher's session id. A retried delivery finds its row and adds nothing.
 */
export async function storeDelivery(db: SupabaseClient, d: SnitcherDelivery, raw: unknown): Promise<void> {
  const seen = new Date().toISOString();
  const { data: company, error: companyErr } = await db
    .from("companies")
    .upsert(
      {
        snitcher_uuid: d.company.uuid,
        name: d.company.name,
        domain: d.company.domain,
        industry: d.company.industry,
        employee_range: d.company.employeeRange,
        hq_city: d.company.city,
        hq_state: d.company.state,
        hq_country: d.company.country,
        last_seen_at: seen,
        raw: obj(raw)?.company ?? null,
      },
      { onConflict: "snitcher_uuid" },
    )
    .select("id")
    .single();
  if (companyErr) throw new Error(companyErr.message);

  const { error } = await db.from("snitcher_sessions").upsert(
    {
      snitcher_session_uuid: d.session.uuid,
      company_id: company.id,
      event: d.event,
      started_at: d.session.startedAt,
      pages_viewed: d.session.pagesViewed,
      referrer: d.session.referrer,
      raw,
    },
    { onConflict: "snitcher_session_uuid", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}

interface ApiSession {
  uuid?: string;
  visitor_uuid?: string;
  started_at?: string;
  location?: { country?: string; state?: string; city?: string; latitude?: number; longitude?: number };
}

const day = (iso: string, deltaDays: number) =>
  new Date(Date.parse(iso) + deltaDays * 86_400_000).toISOString().slice(0, 10);

export type LocationResult = "located" | "no-token" | "not-found" | "failed";

/**
 * Snitcher's session location and visitor id, from its REST API. There is no
 * single-session endpoint, so the company's sessions around the session's
 * date are listed and matched by id. On a match the row gets the location
 * and `location_fetched_at`; Snitcher's visitor id, which our tracker keeps on
 * the visitor row, links the company to our visitor and the Snitcher session
 * to our visit. Without a match the row is left for the sweep to try again.
 */
export async function fetchSessionLocation(db: SupabaseClient, sessionUuid: string): Promise<LocationResult> {
  const token = process.env.SNITCHER_API_TOKEN;
  if (!token) return "no-token";

  const { data: row, error } = await db
    .from("snitcher_sessions")
    .select("snitcher_session_uuid, company_id, started_at, received_at, raw, companies(snitcher_uuid)")
    .eq("snitcher_session_uuid", sessionUuid)
    .maybeSingle();
  if (error || !row) return "failed";
  const raw = obj(row.raw);
  const workspace = str(obj(raw?.workspace)?.uuid) ?? process.env.SNITCHER_WORKSPACE_UUID ?? null;
  const org = str(obj(row.companies as unknown)?.snitcher_uuid);
  if (!workspace || !org) return "failed";

  const at = (row.started_at as string | null) ?? (row.received_at as string);
  const url = new URL(`${API}/workspaces/${workspace}/organisations/${org}/sessions`);
  url.searchParams.set("date_from", day(at, -1));
  url.searchParams.set("date_to", day(at, 1));
  url.searchParams.set("size", "1000");
  let sessions: ApiSession[];
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!res.ok) {
      console.error(`[gtm/snitcher] sessions read failed (${res.status}) for ${sessionUuid}`);
      return "failed";
    }
    sessions = ((await res.json()) as { data?: ApiSession[] }).data ?? [];
  } catch (err) {
    console.error("[gtm/snitcher] sessions read failed", err);
    return "failed";
  }
  const match = sessions.find((s) => s.uuid === sessionUuid);
  if (!match) return "not-found";

  const loc = match.location ?? {};
  const update: Record<string, unknown> = {
    city: loc.city ?? null,
    state: loc.state ?? null,
    country: loc.country ?? null,
    latitude: typeof loc.latitude === "number" ? loc.latitude : null,
    longitude: typeof loc.longitude === "number" ? loc.longitude : null,
    location_fetched_at: new Date().toISOString(),
  };

  // Snitcher's visitor id, which our tracker reads off the page and keeps on
  // our visitor row (`snitcher_visitor_id`) wherever both scripts ran.
  if (match.visitor_uuid) {
    const { data: visitor } = await db
      .from("visitors")
      .select("id")
      .eq("snitcher_visitor_id", match.visitor_uuid)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (visitor) {
      await db.from("visitors").update({ company_id: row.company_id }).eq("id", visitor.id);
      const started = Date.parse(match.started_at ?? at);
      const { data: ours } = await db
        .from("sessions")
        .select("id, started_at")
        .eq("visitor_id", visitor.id)
        .gte("started_at", new Date(started - SAME_VISIT_MS).toISOString())
        .lte("started_at", new Date(started + SAME_VISIT_MS).toISOString());
      const nearest = (ours ?? []).sort(
        (a, b) => Math.abs(Date.parse(a.started_at) - started) - Math.abs(Date.parse(b.started_at) - started),
      )[0];
      if (nearest) update.session_id = nearest.id;
    }
  }

  const { error: updateErr } = await db.from("snitcher_sessions").update(update).eq("snitcher_session_uuid", sessionUuid);
  return updateErr ? "failed" : "located";
}

/** Rows whose location read has not landed yet, newest first, for the sweep. */
export async function pendingLocations(db: SupabaseClient, limit: number, withinDays: number): Promise<string[]> {
  const { data, error } = await db
    .from("snitcher_sessions")
    .select("snitcher_session_uuid")
    .is("location_fetched_at", null)
    .gte("received_at", new Date(Date.now() - withinDays * 86_400_000).toISOString())
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.snitcher_session_uuid as string);
}
