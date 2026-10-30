import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getGtmDb } from "./db";
import { demoRows, landingStats, mapPoints, rangeBounds, visitorRows } from "./derive";
import type {
  CompanyRow,
  DemoViewRow,
  EventRow,
  GtmRange,
  LandingData,
  MapPoint,
  SessionRow,
  SnitcherLocationRow,
  VisitorDetail,
  VisitorRow,
} from "./types";

/**
 * The Landing tab's reads from the GTM database. Callers check access first
 * (`actions.ts`); this file only reads. PostgREST returns at most 1,000 rows a
 * request, so every list is read in pages until it runs out: a busy month is
 * counted whole, never cut at a page.
 */

const PAGE = 1000;
/** Ids per `in (...)` filter, to keep the request URL short. */
const ID_CHUNK = 200;

const SESSION_COLS =
  "id, visitor_id, started_at, last_event_at, entry_path, referrer, source, utm_source, utm_medium, utm_campaign, device, viewport_w, viewport_h, country, state, city, latitude, longitude, engaged_ms, max_scroll_pct";
const VISITOR_COLS = "id, first_seen_at, last_seen_at, visit_count, company_id";
const COMPANY_COLS =
  "id, snitcher_uuid, name, domain, industry, employee_range, hq_city, hq_state, hq_country, first_seen_at, last_seen_at";
const DEMO_COLS = "session_id, path, demo, view_number, started_at, max_progress_pct, completed, watched_ms";
const EVENT_COLS =
  "id, session_id, occurred_at, type, path, scroll_pct, x_pct, y_pct, el_tag, el_id, el_class, el_text, hover_ms";

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function readAll<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function byIds<T>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) out.push(...(await read(unique.slice(i, i + ID_CHUNK))));
  return out;
}

/** Visits that were going on inside [start, end): last activity at or after the start, begun before the end. */
function sessionsIn(db: SupabaseClient, start: number, end: number): Promise<SessionRow[]> {
  return readAll<SessionRow>((from, to) =>
    db
      .from("sessions")
      .select(SESSION_COLS)
      .gte("last_event_at", new Date(start).toISOString())
      .lt("started_at", new Date(end).toISOString())
      .order("started_at", { ascending: true })
      .range(from, to),
  );
}

async function visitorsAndCompanies(db: SupabaseClient, visitorIds: string[]) {
  const visitorRows = await byIds(visitorIds, (chunk) =>
    readAll<VisitorRow>((from, to) => db.from("visitors").select(VISITOR_COLS).in("id", chunk).range(from, to)),
  );
  const companyIds = visitorRows.map((v) => v.company_id).filter((c): c is string => Boolean(c));
  const companyRows = await byIds(companyIds, (chunk) =>
    readAll<CompanyRow>((from, to) => db.from("companies").select(COMPANY_COLS).in("id", chunk).range(from, to)),
  );
  return {
    visitors: new Map(visitorRows.map((v) => [v.id, v])),
    companies: new Map(companyRows.map((c) => [c.id, c])),
  };
}

/** Stats, the Visitors table and the Demos table for the range. */
export async function readLanding(range: GtmRange, nowMs = Date.now()): Promise<LandingData> {
  const db = getGtmDb();
  const { start, end, prevStart } = rangeBounds(range, nowMs);
  const [current, previous, demoViews] = await Promise.all([
    sessionsIn(db, start, end),
    sessionsIn(db, prevStart, start),
    readAll<DemoViewRow>((from, to) =>
      db
        .from("demo_views")
        .select(DEMO_COLS)
        .gte("started_at", new Date(start).toISOString())
        .lt("started_at", new Date(end).toISOString())
        .order("started_at", { ascending: true })
        .range(from, to),
    ),
  ]);
  const { visitors, companies } = await visitorsAndCompanies(db, [
    ...current.map((s) => s.visitor_id),
    ...previous.map((s) => s.visitor_id),
  ]);

  // A play's viewer is its visit's browser; a play whose visit began before
  // the range still has its visit read here.
  const visitorOfSession = new Map(current.map((s) => [s.id, s.visitor_id]));
  const missing = demoViews.map((d) => d.session_id).filter((id) => !visitorOfSession.has(id));
  const extra = await byIds(missing, (chunk) =>
    readAll<{ id: string; visitor_id: string }>((from, to) =>
      db.from("sessions").select("id, visitor_id").in("id", chunk).range(from, to),
    ),
  );
  for (const s of extra) visitorOfSession.set(s.id, s.visitor_id);

  return {
    stats: landingStats(current, previous, visitors),
    visitors: visitorRows(current, visitors, companies, demoViews),
    demos: demoRows(demoViews, visitorOfSession),
  };
}

/** The map's dots for its own range. */
export async function readMapPoints(range: GtmRange, nowMs = Date.now()): Promise<MapPoint[]> {
  const db = getGtmDb();
  const { start, end } = rangeBounds(range, nowMs);
  const sessions = await sessionsIn(db, start, end);
  const { visitors, companies } = await visitorsAndCompanies(db, sessions.map((s) => s.visitor_id));
  const unplaced = sessions.filter((s) => s.latitude == null || s.longitude == null).map((s) => s.id);
  const snitcher = await byIds(unplaced, (chunk) =>
    readAll<SnitcherLocationRow>((from, to) =>
      db
        .from("snitcher_sessions")
        .select("session_id, city, state, country, latitude, longitude")
        .in("session_id", chunk)
        .not("latitude", "is", null)
        .range(from, to),
    ),
  );
  const bySession = new Map(snitcher.filter((s) => s.session_id).map((s) => [s.session_id!, s]));
  return mapPoints(sessions, visitors, companies, bySession);
}

/** Everything held on one visitor, for the visitor panel. */
export async function readVisitor(visitorId: string): Promise<VisitorDetail | null> {
  const db = getGtmDb();
  const { data: visitor, error } = await db.from("visitors").select(VISITOR_COLS).eq("id", visitorId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!visitor) return null;
  const [company, sessions] = await Promise.all([
    visitor.company_id
      ? db.from("companies").select(COMPANY_COLS).eq("id", visitor.company_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    readAll<SessionRow>((from, to) =>
      db
        .from("sessions")
        .select(SESSION_COLS)
        .eq("visitor_id", visitorId)
        .order("started_at", { ascending: false })
        .range(from, to),
    ),
  ]);
  if (company.error) throw new Error(company.error.message);
  const ids = sessions.map((s) => s.id);
  const [events, demoViews] = await Promise.all([
    byIds(ids, (chunk) =>
      readAll<EventRow>((from, to) =>
        db
          .from("events")
          .select(EVENT_COLS)
          .in("session_id", chunk)
          .order("occurred_at", { ascending: true })
          .range(from, to),
      ),
    ),
    byIds(ids, (chunk) =>
      readAll<DemoViewRow>((from, to) =>
        db
          .from("demo_views")
          .select(DEMO_COLS)
          .in("session_id", chunk)
          .order("started_at", { ascending: true })
          .range(from, to),
      ),
    ),
  ]);
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return { visitor: visitor as VisitorRow, company: (company.data as CompanyRow | null) ?? null, sessions, events, demoViews };
}
