import type { MetricPoint } from "@/components/admin/admin-metrics-chart";

/**
 * Dummy data for /admin/analytics, so the page can be looked at before any
 * event is tracked. Every figure on every tab comes from ONE simulated year
 * of per-member daily activity, so the tabs agree with each other: an org's
 * "last active" on Health is the last day it has a point on Activity, and
 * the Features events add up to the platform's events.
 *
 * Seeded, so a reload shows the same customers with the same numbers. The
 * companies are invented.
 */

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 365;

/** mulberry32: small, fast, and the same sequence for the same seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Trend = "growing" | "steady" | "fading" | "gone";

interface OrgProfile {
  name: string;
  term: "month" | "year";
  mrrUsd: number;
  seats: number;
  /** Chance a typical member works in the app on a weekday. */
  base: number;
  trend: Trend;
  /** Days ago the org signed up; history starts there. */
  age: number;
}

const ORGS: OrgProfile[] = [
  { name: "Caprock Petroleum", term: "year", mrrUsd: 2400, seats: 14, base: 0.72, trend: "steady", age: 365 },
  { name: "Brazos Bend Operating", term: "year", mrrUsd: 1800, seats: 11, base: 0.65, trend: "growing", age: 340 },
  { name: "Llano Uplift Energy", term: "month", mrrUsd: 950, seats: 6, base: 0.6, trend: "fading", age: 300 },
  { name: "Pecos Ridge Oil", term: "month", mrrUsd: 1200, seats: 8, base: 0.7, trend: "steady", age: 280 },
  { name: "Red Fork Resources", term: "year", mrrUsd: 3100, seats: 19, base: 0.68, trend: "growing", age: 365 },
  { name: "Mesquite Draw Operating", term: "month", mrrUsd: 600, seats: 4, base: 0.55, trend: "gone", age: 250 },
  { name: "Comanche Flats Oil Co", term: "month", mrrUsd: 750, seats: 5, base: 0.62, trend: "steady", age: 210 },
  { name: "Caddo Bayou Energy", term: "year", mrrUsd: 1500, seats: 9, base: 0.5, trend: "fading", age: 190 },
  { name: "Big Lake Operating", term: "month", mrrUsd: 450, seats: 3, base: 0.75, trend: "growing", age: 160 },
  { name: "Sabine Flats Production", term: "month", mrrUsd: 900, seats: 7, base: 0.4, trend: "steady", age: 140 },
  { name: "Palo Pinto Petroleum", term: "year", mrrUsd: 2000, seats: 12, base: 0.66, trend: "steady", age: 120 },
  { name: "Wichita Breaks Oil", term: "month", mrrUsd: 500, seats: 4, base: 0.58, trend: "gone", age: 95 },
  { name: "Hondo Creek Operating", term: "month", mrrUsd: 650, seats: 5, base: 0.7, trend: "growing", age: 70 },
  { name: "Lampasas Energy Partners", term: "month", mrrUsd: 800, seats: 6, base: 0.45, trend: "fading", age: 55 },
];

/** Signups still on the way in, for Onboarding: index of the last step each reached. */
const NEW_SIGNUPS: { name: string; daysAgo: number; reached: number }[] = [
  { name: "Hondo Creek Operating", daysAgo: 70, reached: 5 },
  { name: "Lampasas Energy Partners", daysAgo: 55, reached: 5 },
  { name: "Coleman County Oil", daysAgo: 48, reached: 3 },
  { name: "Blanco River Resources", daysAgo: 44, reached: 1 },
  { name: "Shackelford Operating", daysAgo: 39, reached: 4 },
  { name: "Stonewall Petroleum", daysAgo: 33, reached: 2 },
  { name: "Callahan Divide Energy", daysAgo: 29, reached: 0 },
  { name: "Throckmorton Oil & Gas", daysAgo: 24, reached: 3 },
  { name: "Eastland Basin Operating", daysAgo: 20, reached: 5 },
  { name: "Brown County Crude", daysAgo: 17, reached: 1 },
  { name: "San Saba Production", daysAgo: 13, reached: 2 },
  { name: "Mills Creek Energy", daysAgo: 9, reached: 3 },
  { name: "Coryell Ridge Oil", daysAgo: 6, reached: 0 },
  { name: "Hamilton Draw Resources", daysAgo: 3, reached: 1 },
  { name: "Erath Operating", daysAgo: 120, reached: 5 },
  { name: "Bosque Valley Oil", daysAgo: 110, reached: 2 },
  { name: "Somervell Energy", daysAgo: 150, reached: 4 },
  { name: "Comal Springs Petroleum", daysAgo: 170, reached: 1 },
];

export const ONBOARDING_STEPS = [
  "Org created",
  "First lease",
  "First well",
  "First reading",
  "Member invited",
  "Payment added",
] as const;

/** Features, with how often an adopting member uses each (relative weight). */
const FEATURES: { name: string; weight: number; adoption: number }[] = [
  { name: "Readings entered", weight: 10, adoption: 0.95 },
  { name: "Tickets entered", weight: 4, adoption: 0.8 },
  { name: "Orion chat", weight: 3, adoption: 0.7 },
  { name: "Document ingest", weight: 2, adoption: 0.6 },
  { name: "Ingest approved", weight: 1.5, adoption: 0.55 },
  { name: "Reports viewed", weight: 2.5, adoption: 0.75 },
  { name: "Statements posted", weight: 0.8, adoption: 0.4 },
  { name: "Facilities edited", weight: 0.6, adoption: 0.35 },
  { name: "Map opened", weight: 1.2, adoption: 0.5 },
  { name: "Files uploaded", weight: 1, adoption: 0.65 },
  { name: "Messages sent", weight: 1.8, adoption: 0.45 },
  { name: "RRC Form PR filed", weight: 0.2, adoption: 0.3 },
];

/** Pages, with a view weight, typical dwell (seconds) and p75 load (ms). */
const PAGES: { route: string; weight: number; dwell: number; loadMs: number }[] = [
  { route: "/dashboard", weight: 10, dwell: 95, loadMs: 1400 },
  { route: "/leases", weight: 5, dwell: 70, loadMs: 1100 },
  { route: "/leases/[lease]", weight: 7, dwell: 140, loadMs: 1650 },
  { route: "/production/wells/[well]", weight: 6, dwell: 120, loadMs: 1300 },
  { route: "/production", weight: 4, dwell: 85, loadMs: 1900 },
  { route: "/inventory", weight: 3, dwell: 110, loadMs: 900 },
  { route: "/disposal", weight: 1.5, dwell: 75, loadMs: 1250 },
  { route: "/facilities", weight: 1.2, dwell: 160, loadMs: 2600 },
  { route: "/orion", weight: 3.5, dwell: 240, loadMs: 800 },
  { route: "/reports", weight: 2.5, dwell: 130, loadMs: 2100 },
  { route: "/statements", weight: 1.4, dwell: 180, loadMs: 1700 },
  { route: "/revenue", weight: 1.8, dwell: 100, loadMs: 1500 },
  { route: "/files", weight: 1.6, dwell: 60, loadMs: 1000 },
  { route: "/map", weight: 1.1, dwell: 150, loadMs: 3200 },
  { route: "/messages", weight: 2, dwell: 90, loadMs: 700 },
  { route: "/settings", weight: 0.9, dwell: 55, loadMs: 650 },
  { route: "/filings", weight: 0.4, dwell: 200, loadMs: 1200 },
  { route: "/recon", weight: 0.7, dwell: 170, loadMs: 2800 },
];

function trendFactor(trend: Trend, daysAgo: number): number {
  const t = 1 - daysAgo / HISTORY_DAYS; // 0 a year ago, 1 today
  if (trend === "growing") return 0.55 + 0.6 * t;
  if (trend === "fading") return daysAgo > 21 ? 1 : 0.2 + 0.8 * (daysAgo / 21);
  if (trend === "gone") return daysAgo > 40 ? 1 : daysAgo > 12 ? 0.4 * ((daysAgo - 12) / 28) : 0;
  return 1;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type HealthRisk = "high" | "medium" | "low";

export interface HealthRow {
  orgId: string;
  name: string;
  term: "month" | "year";
  mrrUsd: number;
  /** ISO day of the last day any member was active; null if never. */
  lastActive: string | null;
  daysSinceActive: number | null;
  activeSeats: number;
  seats: number;
  /** Events, last 7 days against the 7 before; null when the prior week was empty. */
  weekOverWeek: number | null;
  risk: HealthRisk;
}

export interface ActivitySeries {
  active: MetricPoint[];
  sessions: MetricPoint[];
  events: MetricPoint[];
}

export interface OnboardingOrg {
  orgId: string;
  name: string;
  signedUpAt: string;
  /** Index into ONBOARDING_STEPS of the last step reached. */
  reached: number;
  daysAgo: number;
}

export interface FeatureRow {
  name: string;
  orgs: number;
  activeOrgs: number;
  users: number;
  events: number;
  trend: number | null;
}

export interface PageRow {
  route: string;
  views: number;
  users: number;
  orgs: number;
  avgSeconds: number;
  p75LoadMs: number;
  trend: number | null;
}

export interface AnalyticsDemo {
  nowMs: number;
  health: HealthRow[];
  orgs: { orgId: string; name: string }[];
  /** Per org, plus "all" for the platform total. */
  activity: Record<string, ActivitySeries>;
  onboarding: OnboardingOrg[];
  features: FeatureRow[];
  pages: PageRow[];
}

/** Today at 00:00 UTC; the simulation's last day is yesterday, a complete day. */
function anchor(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function buildAnalyticsDemo(now: Date = new Date()): AnalyticsDemo {
  const today = anchor(now);
  const rand = rng(20261001);

  const health: HealthRow[] = [];
  const activity: Record<string, ActivitySeries> = {};
  const totals = Array.from({ length: HISTORY_DAYS }, () => ({ active: 0, sessions: 0, events: 0 }));

  // Per org: events in the last 30 days and the 30 before, and members active
  // in the last 30, which the Features and Pages tabs split up.
  const window30: { orgIdx: number; users: number; events: number; prevEvents: number }[] = [];

  ORGS.forEach((org, orgIdx) => {
    const orgId = `demo-${orgIdx + 1}`;
    // Some seats are bought and barely used; that is what Active seats shows.
    const userFactor = Array.from({ length: org.seats }, () => (rand() < 0.2 ? 0.03 : 0.4 + rand() * 0.9));
    const lastSeen = new Array<number>(org.seats).fill(-1);
    const days: { active: number; sessions: number; events: number }[] = [];

    for (let i = HISTORY_DAYS; i >= 1; i--) {
      const dayMs = today - i * DAY_MS;
      if (i > org.age) {
        days.push({ active: 0, sessions: 0, events: 0 });
        continue;
      }
      const dow = new Date(dayMs).getUTCDay();
      const weekend = dow === 0 || dow === 6 ? 0.3 : 1;
      let active = 0;
      let sessions = 0;
      let events = 0;
      for (let u = 0; u < org.seats; u++) {
        const p = Math.min(0.97, org.base * userFactor[u] * weekend * trendFactor(org.trend, i));
        if (rand() < p) {
          active++;
          lastSeen[u] = Math.max(lastSeen[u], HISTORY_DAYS - i);
          const s = 1 + Math.floor(rand() * 3);
          sessions += s;
          events += s * (12 + Math.floor(rand() * 30));
        }
      }
      days.push({ active, sessions, events });
    }

    days.forEach((d, idx) => {
      totals[idx].active += d.active;
      totals[idx].sessions += d.sessions;
      totals[idx].events += d.events;
    });
    activity[orgId] = toSeries(days, today);

    let lastIdx = -1;
    days.forEach((d, idx) => {
      if (d.active > 0) lastIdx = idx;
    });
    const daysSinceActive = lastIdx < 0 ? null : HISTORY_DAYS - lastIdx;
    const sum = (from: number, to: number, key: "events") =>
      days.slice(from, to).reduce((acc, d) => acc + d[key], 0);
    const last7 = sum(HISTORY_DAYS - 7, HISTORY_DAYS, "events");
    const prev7 = sum(HISTORY_DAYS - 14, HISTORY_DAYS - 7, "events");
    const weekOverWeek = prev7 > 0 ? last7 / prev7 - 1 : null;
    const activeSeats = lastSeen.filter((d) => d >= HISTORY_DAYS - 7).length;

    window30.push({
      orgIdx,
      users: lastSeen.filter((d) => d >= HISTORY_DAYS - 30).length,
      events: sum(HISTORY_DAYS - 30, HISTORY_DAYS, "events"),
      prevEvents: sum(HISTORY_DAYS - 60, HISTORY_DAYS - 30, "events"),
    });

    health.push({
      orgId,
      name: org.name,
      term: org.term,
      mrrUsd: org.mrrUsd,
      lastActive: lastIdx < 0 ? null : isoDay(today - (HISTORY_DAYS - lastIdx) * DAY_MS),
      daysSinceActive,
      activeSeats,
      seats: org.seats,
      weekOverWeek,
      risk: riskOf(daysSinceActive, weekOverWeek, activeSeats / org.seats),
    });
  });

  activity.all = toSeries(totals, today);

  const activeOrgs = window30.filter((w) => w.events > 0);
  const totalEvents = activeOrgs.reduce((a, w) => a + w.events, 0);

  // Each org adopts a feature or not; an adopting org's events are split
  // across its features by weight, so the feature rows sum to the platform.
  const featureRand = rng(7);
  const adopts = ORGS.map(() => FEATURES.map((f) => featureRand() < f.adoption));
  const features: FeatureRow[] = FEATURES.map((f, fi) => {
    let orgs = 0;
    let users = 0;
    let events = 0;
    let prevEvents = 0;
    for (const w of activeOrgs) {
      if (!adopts[w.orgIdx][fi]) continue;
      const weights = FEATURES.reduce((a, g, gi) => a + (adopts[w.orgIdx][gi] ? g.weight : 0), 0);
      const share = f.weight / weights;
      orgs++;
      users += Math.max(1, Math.round(w.users * Math.min(1, 0.4 + share * 2)));
      events += Math.round(w.events * share);
      prevEvents += Math.round(w.prevEvents * share);
    }
    return { name: f.name, orgs, activeOrgs: activeOrgs.length, users, events, trend: prevEvents > 0 ? events / prevEvents - 1 : null };
  });

  // Pages: about one view per eight events, split by weight.
  const pageRand = rng(11);
  const pageWeights = PAGES.reduce((a, p) => a + p.weight, 0);
  const totalUsers = activeOrgs.reduce((a, w) => a + w.users, 0);
  const pages: PageRow[] = PAGES.map((p) => {
    const share = p.weight / pageWeights;
    const views = Math.round((totalEvents / 8) * share);
    const reach = Math.min(1, 0.25 + share * 6);
    return {
      route: p.route,
      views,
      users: Math.max(1, Math.round(totalUsers * reach)),
      orgs: Math.max(1, Math.round(activeOrgs.length * Math.min(1, reach + 0.15))),
      avgSeconds: Math.round(p.dwell * (0.85 + pageRand() * 0.3)),
      p75LoadMs: Math.round(p.loadMs * (0.9 + pageRand() * 0.2)),
      trend: (pageRand() - 0.4) * 0.5,
    };
  });

  const onboarding: OnboardingOrg[] = NEW_SIGNUPS.map((s, i) => ({
    orgId: `signup-${i + 1}`,
    name: s.name,
    signedUpAt: new Date(today - s.daysAgo * DAY_MS + 15 * 3_600_000).toISOString(),
    reached: s.reached,
    daysAgo: s.daysAgo,
  }));

  return {
    nowMs: now.getTime(),
    health,
    orgs: health.map((h) => ({ orgId: h.orgId, name: h.name })),
    activity,
    onboarding,
    features,
    pages,
  };
}

function toSeries(days: { active: number; sessions: number; events: number }[], today: number): ActivitySeries {
  const at = (idx: number) => isoDay(today - (HISTORY_DAYS - idx) * DAY_MS);
  return {
    active: days.map((d, i) => ({ date: at(i), value: d.active })),
    sessions: days.map((d, i) => ({ date: at(i), value: d.sessions })),
    events: days.map((d, i) => ({ date: at(i), value: d.events })),
  };
}

/**
 * High: nobody in for a week, or activity halved. Medium: activity down a
 * fifth, or under 40% of seats in use. Otherwise low.
 */
function riskOf(daysSinceActive: number | null, wow: number | null, seatShare: number): HealthRisk {
  if (daysSinceActive === null || daysSinceActive > 7 || (wow !== null && wow <= -0.5)) return "high";
  if ((wow !== null && wow <= -0.2) || seatShare < 0.4) return "medium";
  return "low";
}
