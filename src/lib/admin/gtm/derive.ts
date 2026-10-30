/**
 * The Landing tab's figures, from the GTM rows. Pure, so every number has a
 * hand oracle (`derive.test.ts`). The stats, the Visitors table and the map
 * all count from the same visits, so a visitor in the table is a dot on the
 * map and a company in the stats is a company in the table.
 */
import { changePct } from "@/lib/admin/metrics";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import type {
  CompanyRow,
  DemoTableRow,
  DemoViewRow,
  GtmRange,
  LandingStats,
  MapPoint,
  SessionRow,
  SnitcherLocationRow,
  VisitorRow,
  VisitorTableRow,
} from "./types";

const DAY_MS = 86_400_000;

/** Minutes the zone sits from UTC at an instant (Central: -300 or -360). */
function zoneOffsetMin(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** The UTC instant of a calendar date's midnight in the zone. */
export function zonedMidnight(date: string, timeZone = ADMIN_TIME_ZONE): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - zoneOffsetMin(guess, timeZone) * 60_000;
}

/**
 * The range as instants: [start, end), and the period of the same length
 * just before it (for the stats' change). Custom dates are whole days in
 * Wildcat's zone, both ends included.
 */
export function rangeBounds(range: GtmRange, nowMs: number): { start: number; end: number; prevStart: number } {
  if ("days" in range) {
    const end = nowMs;
    const start = end - range.days * DAY_MS;
    return { start, end, prevStart: start - range.days * DAY_MS };
  }
  const [a, b] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from];
  const start = zonedMidnight(a);
  const [y, m, d] = b.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = zonedMidnight(next);
  return { start, end, prevStart: start - (end - start) };
}

/** "Graham, Texas"; a city alone, a state alone, or null. */
export function placeLabel(city: string | null, state: string | null, country?: string | null): string | null {
  const parts = [city, state].filter(Boolean);
  if (parts.length === 0 && country && country !== "US") return country;
  if (parts.length && country && country !== "US") parts.push(country);
  return parts.length ? parts.join(", ") : null;
}

function companyOf(
  visitorId: string,
  visitors: ReadonlyMap<string, VisitorRow>,
  companies: ReadonlyMap<string, CompanyRow>,
): CompanyRow | null {
  const companyId = visitors.get(visitorId)?.company_id;
  return companyId ? (companies.get(companyId) ?? null) : null;
}

function identifiedCount(sessions: SessionRow[], visitors: ReadonlyMap<string, VisitorRow>): number {
  const ids = new Set<string>();
  for (const s of sessions) {
    const c = visitors.get(s.visitor_id)?.company_id;
    if (c) ids.add(c);
  }
  return ids.size;
}

/** The headline row. `current` and `previous` are the visits in the range and in the period before it. */
export function landingStats(
  current: SessionRow[],
  previous: SessionRow[],
  visitors: ReadonlyMap<string, VisitorRow>,
): LandingStats {
  const visits = current.length;
  const uniqueVisitors = new Set(current.map((s) => s.visitor_id)).size;
  const identifiedCompanies = identifiedCount(current, visitors);
  const texas = current.filter((s) => s.state === "Texas").length;

  const byCity = new Map<string, { city: string; state: string | null; visits: number }>();
  for (const s of current) {
    if (!s.city) continue;
    const key = `${s.city}|${s.state ?? ""}`;
    const entry = byCity.get(key) ?? { city: s.city, state: s.state, visits: 0 };
    entry.visits++;
    byCity.set(key, entry);
  }
  // Most visits; a tie goes to the name first in the alphabet, so the card never flickers.
  const topCity =
    [...byCity.values()].sort((a, b) => b.visits - a.visits || a.city.localeCompare(b.city))[0] ?? null;

  return {
    visits,
    uniqueVisitors,
    identifiedCompanies,
    texasShare: visits ? texas / visits : null,
    topCity,
    change: {
      visits: changePct(visits, previous.length),
      uniqueVisitors: changePct(uniqueVisitors, new Set(previous.map((s) => s.visitor_id)).size),
      identifiedCompanies: changePct(identifiedCompanies, identifiedCount(previous, visitors)),
    },
  };
}

/** One row per visitor with a visit in the range; figures are over those visits. */
export function visitorRows(
  sessions: SessionRow[],
  visitors: ReadonlyMap<string, VisitorRow>,
  companies: ReadonlyMap<string, CompanyRow>,
  demoViews: DemoViewRow[],
): VisitorTableRow[] {
  const visitorOfSession = new Map(sessions.map((s) => [s.id, s.visitor_id]));
  const demosByVisitor = new Map<string, Set<string>>();
  for (const d of demoViews) {
    const v = visitorOfSession.get(d.session_id);
    if (!v) continue;
    const set = demosByVisitor.get(v) ?? new Set<string>();
    set.add(`${d.path}|${d.demo}`);
    demosByVisitor.set(v, set);
  }

  const rows = new Map<string, VisitorTableRow & { latest: number }>();
  for (const s of sessions) {
    const t = Date.parse(s.last_event_at);
    const row = rows.get(s.visitor_id) ?? {
      visitorId: s.visitor_id,
      company: companyOf(s.visitor_id, visitors, companies)?.name ?? null,
      location: null,
      visits: 0,
      engagedMs: 0,
      maxScrollPct: 0,
      demosWatched: demosByVisitor.get(s.visitor_id)?.size ?? 0,
      lastSeenAt: s.last_event_at,
      latest: -Infinity,
    };
    row.visits++;
    row.engagedMs += s.engaged_ms;
    row.maxScrollPct = Math.max(row.maxScrollPct, s.max_scroll_pct);
    if (t > row.latest) {
      row.latest = t;
      row.lastSeenAt = s.last_event_at;
      // Where they were on their latest visit, as the map places them.
      row.location = placeLabel(s.city, s.state, s.country);
    }
    rows.set(s.visitor_id, row);
  }
  return [...rows.values()]
    .map(
      (r): VisitorTableRow => ({
        visitorId: r.visitorId,
        company: r.company,
        location: r.location,
        visits: r.visits,
        engagedMs: r.engagedMs,
        maxScrollPct: r.maxScrollPct,
        demosWatched: r.demosWatched,
        lastSeenAt: r.lastSeenAt,
      }),
    )
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** One row per demo per page, over the plays that started in the range. */
export function demoRows(demoViews: DemoViewRow[], visitorOfSession: ReadonlyMap<string, string>): DemoTableRow[] {
  const groups = new Map<string, DemoViewRow[]>();
  for (const d of demoViews) {
    const key = `${d.path}|${d.demo}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, plays]) => {
      const stepped = plays.filter((p) => p.max_progress_pct != null);
      const viewers = new Set(plays.map((p) => visitorOfSession.get(p.session_id) ?? p.session_id));
      return {
        key,
        demo: plays[0].demo,
        path: plays[0].path,
        plays: plays.length,
        uniqueViewers: viewers.size,
        avgProgressPct: stepped.length
          ? stepped.reduce((a, p) => a + (p.max_progress_pct ?? 0), 0) / stepped.length
          : null,
        completionRate: stepped.length ? stepped.filter((p) => p.completed).length / stepped.length : null,
        avgWatchedMs: plays.reduce((a, p) => a + p.watched_ms, 0) / plays.length,
      };
    })
    .sort((a, b) => b.plays - a.plays || a.key.localeCompare(b.key));
}

/**
 * One dot per visitor with a visit in the range, at that visitor's latest
 * placed visit in it. A visit of ours with no coordinates borrows the
 * Snitcher session joined to it, when that has some.
 */
export function mapPoints(
  sessions: SessionRow[],
  visitors: ReadonlyMap<string, VisitorRow>,
  companies: ReadonlyMap<string, CompanyRow>,
  snitcherBySession: ReadonlyMap<string, SnitcherLocationRow>,
): MapPoint[] {
  const visits = new Map<string, number>();
  for (const s of sessions) visits.set(s.visitor_id, (visits.get(s.visitor_id) ?? 0) + 1);

  const best = new Map<string, { t: number; point: MapPoint }>();
  for (const s of sessions) {
    let lat = s.latitude;
    let lng = s.longitude;
    let city = s.city;
    let state = s.state;
    let country = s.country;
    if (lat == null || lng == null) {
      const sn = snitcherBySession.get(s.id);
      if (sn?.latitude == null || sn.longitude == null) continue;
      ({ latitude: lat, longitude: lng, city, state, country } = sn);
    }
    const t = Date.parse(s.last_event_at);
    const prior = best.get(s.visitor_id);
    if (prior && prior.t >= t) continue;
    best.set(s.visitor_id, {
      t,
      point: {
        visitorId: s.visitor_id,
        lng: lng!,
        lat: lat!,
        company: companyOf(s.visitor_id, visitors, companies)?.name ?? null,
        location: placeLabel(city, state, country),
        visits: visits.get(s.visitor_id) ?? 1,
        lastSeenAt: s.last_event_at,
      },
    });
  }
  return [...best.values()].map((b) => b.point);
}
