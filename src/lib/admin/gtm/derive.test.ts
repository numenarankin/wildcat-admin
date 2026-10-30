import { describe, expect, it } from "vitest";
import { demoRows, landingStats, mapPoints, placeLabel, rangeBounds, visitorRows } from "./derive";
import type { CompanyRow, DemoViewRow, SessionRow, SnitcherLocationRow, VisitorRow } from "./types";

/*
 * A week of landing traffic, worked by hand. Four visits in the range:
 *   s1  A (Acme)      Graham, TX       placed   60 s engaged, 80% scroll
 *   s2  A (Acme)      Fort Worth, TX   unplaced (Snitcher has its spot), 30 s, 50%
 *   s3  B (no company) Oklahoma City   placed   10 s, 100%
 *   s4  C (Bend Oil)  Graham, TX       unplaced, no Snitcher row, 0 s, 10%
 * Two the week before: A again and D (Acme, a second browser).
 */

const session = (id: string, visitor: string, last: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id,
  visitor_id: visitor,
  started_at: last,
  last_event_at: last,
  entry_path: "/",
  referrer: null,
  source: "direct",
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  device: "desktop",
  viewport_w: 1440,
  viewport_h: 900,
  country: "US",
  state: null,
  city: null,
  latitude: null,
  longitude: null,
  engaged_ms: 0,
  max_scroll_pct: 0,
  ...extra,
});

const current: SessionRow[] = [
  session("s1", "A", "2026-10-29T15:00:00Z", { city: "Graham", state: "Texas", latitude: 33.107, longitude: -98.589, engaged_ms: 60_000, max_scroll_pct: 80 }),
  session("s2", "A", "2026-10-30T09:00:00Z", { city: "Fort Worth", state: "Texas", engaged_ms: 30_000, max_scroll_pct: 50 }),
  session("s3", "B", "2026-10-28T10:00:00Z", { city: "Oklahoma City", state: "Oklahoma", latitude: 35.467, longitude: -97.516, engaged_ms: 10_000, max_scroll_pct: 100 }),
  session("s4", "C", "2026-10-27T18:00:00Z", { city: "Graham", state: "Texas", max_scroll_pct: 10 }),
];
const previous: SessionRow[] = [
  session("p1", "A", "2026-10-20T15:00:00Z", { state: "Texas" }),
  session("p2", "D", "2026-10-21T15:00:00Z", { state: "Texas" }),
];

const visitor = (id: string, company: string | null): VisitorRow => ({
  id,
  first_seen_at: "2026-10-01T00:00:00Z",
  last_seen_at: "2026-10-30T09:00:00Z",
  visit_count: 1,
  company_id: company,
});
const visitors = new Map(
  [visitor("A", "acme"), visitor("B", null), visitor("C", "bend"), visitor("D", "acme")].map((v) => [v.id, v]),
);
const company = (id: string, name: string): CompanyRow => ({
  id,
  snitcher_uuid: `sn-${id}`,
  name,
  domain: null,
  industry: "Oil & Energy",
  employee_range: "1-10",
  hq_city: null,
  hq_state: null,
  hq_country: "US",
  first_seen_at: "2026-10-01T00:00:00Z",
  last_seen_at: "2026-10-30T00:00:00Z",
});
const companies = new Map([company("acme", "Acme Operating"), company("bend", "Bend Oil")].map((c) => [c.id, c]));

const play = (session_id: string, path: string, demo: string, view_number: number, pct: number | null, completed: boolean, watched_ms: number): DemoViewRow => ({
  session_id,
  path,
  demo,
  view_number,
  started_at: "2026-10-29T15:00:00Z",
  max_progress_pct: pct,
  completed,
  watched_ms,
});
const plays: DemoViewRow[] = [
  play("s1", "/", "orion", 1, 100, true, 20_000),
  play("s1", "/", "orion", 2, 40, false, 8_000),
  play("s2", "/product/orion", "orion", 1, 60, false, 6_000),
  play("s3", "/", "recon", 1, 100, true, 30_000),
  // A still screen: no steps, so no progress.
  play("s3", "/", "reports", 1, null, false, 4_000),
];

describe("landingStats", () => {
  const stats = landingStats(current, previous, visitors);

  it("counts visits, browsers and companies in the range", () => {
    expect(stats.visits).toBe(4);
    expect(stats.uniqueVisitors).toBe(3);
    // A is Acme, C is Bend Oil; B is unidentified.
    expect(stats.identifiedCompanies).toBe(2);
  });

  it("takes the Texas share of visits and the busiest city", () => {
    expect(stats.texasShare).toBe(0.75);
    expect(stats.topCity).toEqual({ city: "Graham", state: "Texas", visits: 2 });
  });

  it("compares against the period before", () => {
    // 4 vs 2 visits, 3 vs 2 browsers, 2 vs 1 company (A and D are both Acme).
    expect(stats.change).toEqual({ visits: 1, uniqueVisitors: 0.5, identifiedCompanies: 1 });
  });

  it("has nothing to say about an empty range", () => {
    const empty = landingStats([], [], visitors);
    expect(empty.texasShare).toBeNull();
    expect(empty.topCity).toBeNull();
    expect(empty.change.visits).toBeNull();
  });
});

describe("visitorRows", () => {
  const rows = visitorRows(current, visitors, companies, plays);

  it("is one row per visitor, newest first", () => {
    expect(rows.map((r) => r.visitorId)).toEqual(["A", "B", "C"]);
  });

  it("sums the visits and places the visitor at their latest one", () => {
    expect(rows[0]).toEqual({
      visitorId: "A",
      company: "Acme Operating",
      location: "Fort Worth, Texas",
      visits: 2,
      engagedMs: 90_000,
      maxScrollPct: 80,
      // The home page's Orion (twice) and the Orion page's: two demos.
      demosWatched: 2,
      lastSeenAt: "2026-10-30T09:00:00Z",
    });
    expect(rows[1].company).toBeNull();
    expect(rows[1].demosWatched).toBe(2);
    expect(rows[2].demosWatched).toBe(0);
  });
});

describe("demoRows", () => {
  const rows = demoRows(plays, new Map(current.map((s) => [s.id, s.visitor_id])));
  const byKey = new Map(rows.map((r) => [r.key, r]));

  it("puts the most played first", () => {
    expect(rows[0].key).toBe("/|orion");
    expect(rows).toHaveLength(4);
  });

  it("averages progress, completion and watch time over the plays", () => {
    expect(byKey.get("/|orion")).toEqual({
      key: "/|orion",
      demo: "orion",
      path: "/",
      plays: 2,
      uniqueViewers: 1,
      avgProgressPct: 70,
      completionRate: 0.5,
      avgWatchedMs: 14_000,
    });
    expect(byKey.get("/product/orion|orion")?.avgProgressPct).toBe(60);
  });

  it("leaves progress empty for a demo with no steps", () => {
    const still = byKey.get("/|reports")!;
    expect(still.avgProgressPct).toBeNull();
    expect(still.completionRate).toBeNull();
    expect(still.avgWatchedMs).toBe(4_000);
  });
});

describe("mapPoints", () => {
  const snitcher = new Map<string, SnitcherLocationRow>([
    ["s2", { session_id: "s2", city: "Fort Worth", state: "Texas", country: "US", latitude: 32.755, longitude: -97.331 }],
  ]);
  const points = mapPoints(current, visitors, companies, snitcher);
  const byVisitor = new Map(points.map((p) => [p.visitorId, p]));

  it("places each visitor once, at their latest placed visit", () => {
    // A's latest visit had no coordinates of its own; Snitcher's session for it does.
    expect(byVisitor.get("A")).toEqual({
      visitorId: "A",
      lng: -97.331,
      lat: 32.755,
      company: "Acme Operating",
      location: "Fort Worth, Texas",
      visits: 2,
      lastSeenAt: "2026-10-30T09:00:00Z",
    });
    expect(byVisitor.get("B")?.lat).toBe(35.467);
  });

  it("leaves off a visitor with no location anywhere", () => {
    expect(byVisitor.has("C")).toBe(false);
    expect(points).toHaveLength(2);
  });
});

describe("rangeBounds", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");

  it("runs the last N days back from now, with the same length before", () => {
    const b = rangeBounds({ days: 7 }, now);
    expect(new Date(b.start).toISOString()).toBe("2026-10-23T12:00:00.000Z");
    expect(new Date(b.end).toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(new Date(b.prevStart).toISOString()).toBe("2026-10-16T12:00:00.000Z");
  });

  it("takes custom dates as whole Central days, both ends included", () => {
    // October is CDT, UTC-5: Oct 1 00:00 Central is 05:00 UTC; the range ends at Oct 8 00:00 Central.
    const b = rangeBounds({ from: "2026-10-01", to: "2026-10-07" }, now);
    expect(new Date(b.start).toISOString()).toBe("2026-10-01T05:00:00.000Z");
    expect(new Date(b.end).toISOString()).toBe("2026-10-08T05:00:00.000Z");
    expect(new Date(b.prevStart).toISOString()).toBe("2026-09-24T05:00:00.000Z");
  });

  it("gives the day DST ends its 25 hours", () => {
    // Nov 1 2026: midnight is CDT (05:00 UTC), the next midnight CST (06:00 UTC).
    const b = rangeBounds({ from: "2026-11-01", to: "2026-11-01" }, now);
    expect(new Date(b.start).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(new Date(b.end).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });

  it("accepts the dates either way round", () => {
    expect(rangeBounds({ from: "2026-10-07", to: "2026-10-01" }, now)).toEqual(
      rangeBounds({ from: "2026-10-01", to: "2026-10-07" }, now),
    );
  });
});

describe("placeLabel", () => {
  it("names the city and state, and the country outside the US", () => {
    expect(placeLabel("Graham", "Texas", "US")).toBe("Graham, Texas");
    expect(placeLabel("Calgary", "Alberta", "CA")).toBe("Calgary, Alberta, CA");
    expect(placeLabel(null, null, "MX")).toBe("MX");
    expect(placeLabel(null, null, "US")).toBeNull();
  });
});
