/** Rows of the GTM database as the admin reads them, and the shapes the Landing tab draws. Client-safe. */

export interface SessionRow {
  id: string;
  visitor_id: string;
  started_at: string;
  last_event_at: string;
  entry_path: string;
  referrer: string | null;
  source: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  device: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  country: string | null;
  state: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  engaged_ms: number;
  max_scroll_pct: number;
}

export interface VisitorRow {
  id: string;
  first_seen_at: string;
  last_seen_at: string;
  visit_count: number;
  company_id: string | null;
}

export interface CompanyRow {
  id: string;
  snitcher_uuid: string;
  name: string | null;
  domain: string | null;
  industry: string | null;
  employee_range: string | null;
  hq_city: string | null;
  hq_state: string | null;
  hq_country: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DemoViewRow {
  session_id: string;
  path: string;
  demo: string;
  view_number: number;
  started_at: string;
  max_progress_pct: number | null;
  completed: boolean;
  watched_ms: number;
}

export interface EventRow {
  id: string;
  session_id: string;
  occurred_at: string;
  type: "pageview" | "scroll_milestone" | "click" | "rage_click" | "dead_click" | "hover";
  path: string;
  scroll_pct: number | null;
  x_pct: number | null;
  y_pct: number | null;
  el_tag: string | null;
  el_id: string | null;
  el_class: string | null;
  el_text: string | null;
  hover_ms: number | null;
}

/** A Snitcher session's visitor location, for a visit of ours that has none. */
export interface SnitcherLocationRow {
  session_id: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** The page's range: the last N days, or two calendar dates in Wildcat's zone (inclusive). */
export type GtmRange = { days: 7 | 30 | 90 } | { from: string; to: string };

export interface LandingStats {
  visits: number;
  uniqueVisitors: number;
  identifiedCompanies: number;
  /** Share of visits from Texas, 0..1; null with no visits. */
  texasShare: number | null;
  topCity: { city: string; state: string | null; visits: number } | null;
  /** Each count against the period of the same length just before. */
  change: { visits: number | null; uniqueVisitors: number | null; identifiedCompanies: number | null };
}

export interface VisitorTableRow {
  visitorId: string;
  company: string | null;
  location: string | null;
  visits: number;
  engagedMs: number;
  maxScrollPct: number;
  demosWatched: number;
  lastSeenAt: string;
}

export interface DemoTableRow {
  /** `path|demo`, unique per row. */
  key: string;
  demo: string;
  path: string;
  plays: number;
  uniqueViewers: number;
  /** Mean furthest point over plays with steps; null for a demo with none. */
  avgProgressPct: number | null;
  /** Completed plays over plays with steps; null for a demo with none. */
  completionRate: number | null;
  avgWatchedMs: number;
}

export interface MapPoint {
  visitorId: string;
  lng: number;
  lat: number;
  company: string | null;
  location: string | null;
  visits: number;
  lastSeenAt: string;
}

export interface LandingData {
  stats: LandingStats;
  visitors: VisitorTableRow[];
  demos: DemoTableRow[];
}

export interface VisitorDetail {
  visitor: VisitorRow;
  company: CompanyRow | null;
  /** Newest first. */
  sessions: SessionRow[];
  /** Oldest first. */
  events: EventRow[];
  demoViews: DemoViewRow[];
}
