/**
 * Prospecting outreach: the shapes the Enrich and Sequence tabs share, and
 * the pure rules behind them (cadence dates, schedule times), so each can be
 * checked by hand. Readers and writers live beside this file.
 */

import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";

// ---- Enrichment ------------------------------------------------------------

export type EnrichStatus = "queued" | "researching" | "reviewed" | "enrolled";

export const ENRICH_STATUS_LABEL: Record<EnrichStatus, string> = {
  queued: "Queued",
  researching: "Researching",
  reviewed: "Reviewed",
  enrolled: "Enrolled",
};

/** What on the website agreed with the P-5 record. */
export interface WebsiteMatches {
  phone?: boolean;
  address?: boolean;
  city?: boolean;
  /** Officer names seen on the site. */
  names?: string[];
}

export interface TargetResearch {
  operatorNo: number;
  status: EnrichStatus;
  website: string | null;
  websiteMatches: WebsiteMatches;
  notes: string;
  queuedAt: string;
  updatedAt: string;
}

export type ContactSource = "p5" | "website" | "hunter" | "guess";
export type Verification = "deliverable" | "risky" | "undeliverable" | "unknown";

export interface TargetContact {
  id: string;
  operatorNo: number;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  source: ContactSource;
  sourceUrl: string | null;
  confidence: number | null;
  generic: boolean;
  verification: Verification | null;
  decisionMaker: boolean;
}

/** The Enrich tab's queue entry: the target, where its research stands. */
export interface EnrichQueueItem {
  operatorNo: number;
  name: string;
  city: string | null;
  state: string | null;
  activeWells: number;
  status: EnrichStatus;
  website: string | null;
  queuedAt: string;
}

/** A generic mailbox, not a person: kept, shown as such, never a default contact. */
const GENERIC_LOCAL_PARTS = new Set([
  "info", "office", "contact", "admin", "sales", "support", "hello", "mail", "accounting",
  "ap", "ar", "billing", "hr", "jobs", "careers", "press", "media", "webmaster", "noreply", "no-reply",
]);

export function isGenericEmail(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return GENERIC_LOCAL_PARTS.has(local);
}

// ---- Sequences ---------------------------------------------------------------

export type SequenceAction = "email" | "call";

export interface SequenceStep {
  /** Which week of the cadence, from 0. */
  round: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  action: SequenceAction;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
}

/** Email Tuesday, call Thursday (with a follow-up email), three weeks. */
export const DEFAULT_SEQUENCE_STEPS: SequenceStep[] = [0, 1, 2].flatMap((round) => [
  { round, weekday: 2, action: "email" as const },
  { round, weekday: 4, action: "call" as const },
]);

export type EnrollmentState = "active" | "replied" | "meeting" | "stopped" | "done";

export interface Enrollment {
  id: string;
  operatorNo: number;
  companyName: string;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  /** The target's P-5 phone, the fallback for a call step. */
  companyPhone: string | null;
  sequenceId: string;
  stepIndex: number;
  nextDueOn: string | null;
  state: EnrollmentState;
  enrolledOn: string;
  lastEvent: { action: SequenceAction; outcome: string; happenedAt: string } | null;
}

export type EventOutcome = "sent" | "scheduled" | "outboxed" | "done" | "no_answer" | "replied" | "meeting" | "skipped";

/** `YYYY-MM-DD` arithmetic with no time zone: a calendar date is a calendar date. */
function parseDate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = parseDate(iso);
  const t = Date.UTC(y, m - 1, d + days);
  return new Date(t).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, of a `YYYY-MM-DD`. */
export function weekdayOf(iso: string): number {
  const { y, m, d } = parseDate(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The date a step falls on, counted from the enrollment date.
 *
 * Round 0 starts on the first day of the FIRST step's weekday on or after
 * enrollment (enrolled on a Tuesday, the first email is that day; enrolled
 * on a Wednesday, next Tuesday). Each later step is its weekday within its
 * round's week, so round 0's Thursday is two days after its Tuesday, and
 * round 1 is a week on. A step whose weekday precedes the first step's
 * (a Monday step in a Tuesday-led cadence) lands the following week.
 */
export function stepDueOn(enrolledOn: string, steps: SequenceStep[], index: number): string | null {
  const step = steps[index];
  const first = steps[0];
  if (!step || !first) return null;
  const toFirst = (first.weekday - weekdayOf(enrolledOn) + 7) % 7;
  const roundZeroStart = addDays(enrolledOn, toFirst);
  const withinWeek = (step.weekday - first.weekday + 7) % 7;
  return addDays(roundZeroStart, step.round * 7 + withinWeek);
}

/**
 * The enrollment after a step is done: the next step and its date, or done
 * when that was the last one.
 */
export function advance(
  e: Pick<Enrollment, "enrolledOn" | "stepIndex">,
  steps: SequenceStep[]
): { stepIndex: number; nextDueOn: string | null; state: EnrollmentState } {
  const next = e.stepIndex + 1;
  if (next >= steps.length) return { stepIndex: next, nextDueOn: null, state: "done" };
  return { stepIndex: next, nextDueOn: stepDueOn(e.enrolledOn, steps, next), state: "active" };
}

/** Today in Wildcat's calendar (Central), as `YYYY-MM-DD`. */
export function todayInAdminZone(now = new Date()): string {
  return zonedParts(now).date;
}

/** Due today or earlier, overdue first, then by company. */
export function compareDue(a: Enrollment, b: Enrollment): number {
  const ad = a.nextDueOn ?? "9999-12-31";
  const bd = b.nextDueOn ?? "9999-12-31";
  return ad.localeCompare(bd) || a.companyName.localeCompare(b.companyName);
}

// ---- Send schedules ----------------------------------------------------------

export interface SendSchedule {
  id: string;
  name: string;
  /** 0 = Sunday … 6 = Saturday; null = every day. */
  weekday: number | null;
  /** `HH:MM`, 24-hour, in `ADMIN_TIME_ZONE`. */
  time: string;
}

export interface ProspectingSettings {
  /** The subject line, with the same placeholders as the body; "" lets Orion write one. */
  subject: string;
  template: string;
  schedules: SendSchedule[];
}

export const DEFAULT_SUBJECT = "{{company}} and WildcatIQ";

/** The template is the editor's HTML (paragraphs, bold, links); `templateHtml` upgrades a plain-text one. */
export const DEFAULT_TEMPLATE =
  "<p>Hi {{first_name}},</p><p></p>" +
  "<p>I run WildcatIQ, software that gives small operators the tools the majors have: production tracking, reconciliation against the RRC, and revenue reporting, without the headcount.</p><p></p>" +
  "<p>I noticed {{company}} runs {{wells}} wells in {{county}} County. Would a 15-minute call this week be worth your time?</p>";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A stored template as HTML: one saved before the editor (plain text) becomes paragraphs. */
export function templateHtml(template: string): string {
  if (/<[a-z][^>]*>/i.test(template)) return template;
  return template
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .filter((para) => para.trim())
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("<p></p>");
}

export const DEFAULT_SETTINGS: ProspectingSettings = { subject: DEFAULT_SUBJECT, template: DEFAULT_TEMPLATE, schedules: [] };

/**
 * Words a person drops when they say a company's name: legal suffixes and
 * the trade descriptors that trail the real name ("Fair Oil Corporation"
 * is "Fair"; "Maximus Operating LLC" is "Maximus").
 */
const DROPPED_TRAILERS = new Set([
  "llc", "l.l.c", "inc", "incorporated", "co", "company", "corp", "corporation", "ltd", "limited", "lp", "l.p",
  "llp", "plc", "partners", "partnership", "holdings", "group", "operating", "operations", "operator", "operators",
  "oil", "gas", "o&g", "o", "g", "petroleum", "energy", "resources", "exploration", "production", "producing",
  "development", "minerals", "royalty", "royalties", "properties", "management", "services", "enterprises",
  "investments", "ventures", "and", "&", "of", "the",
]);
const ROMAN_OR_NUMBER = /^(?:[ivxl]+|\d+)$/i;

function nameWord(w: string): string {
  // Initialisms stay as they are: "JMH", "BBL", "R.K.".
  if (w.length <= 3 || /\./.test(w) || !/[aeiouy]/i.test(w)) return w.toUpperCase();
  return w.split(/(-)/).map((part) => (part === "-" ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())).join("");
}

/** How a person says the company's name: trailing descriptors and suffixes gone, the rest title-cased. */
export function humanCompanyName(name: string): string {
  const words = name.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  // "INC." and "L.P." match their entries; "R." in a person's name keeps its period.
  const bare = (w: string) => w.toLowerCase().replace(/\.+$/, "");
  const dropped = (w: string) => DROPPED_TRAILERS.has(bare(w)) || ROMAN_OR_NUMBER.test(bare(w));
  const core = [...words];
  while (core.length > 1 && dropped(core[core.length - 1])) core.pop();
  const kept = core.length && !dropped(core[core.length - 1]) ? core : words;
  return kept.map(nameWord).join(" ");
}

/** A moment's date and clock in the admin zone. */
function zonedParts(at: Date, timeZone = ADMIN_TIME_ZONE): { date: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday,
  };
}

/**
 * The instant a zone's wall-clock time is. Found by guessing UTC and
 * correcting by the zone's offset at that guess (twice, for a guess that
 * lands on the other side of a DST change).
 */
export function zonedTimeToUtc(date: string, time: string, timeZone = ADMIN_TIME_ZONE): Date {
  const { y, m, d } = parseDate(date);
  const [hh, mm] = time.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const { y: gy, m: gm, d: gd } = parseDate(p.date);
    const asIf = Date.UTC(gy, gm - 1, gd, p.hour, p.minute);
    guess += Date.UTC(y, m - 1, d, hh, mm) - asIf;
  }
  return new Date(guess);
}

/**
 * The next time a schedule fires after `now`: the next day matching its
 * weekday (any day when null) whose time has not yet passed, in the admin
 * zone.
 */
export function nextOccurrence(schedule: SendSchedule, now = new Date()): Date {
  const today = zonedParts(now);
  for (let offset = 0; offset < 8; offset++) {
    const date = addDays(today.date, offset);
    if (schedule.weekday != null && weekdayOf(date) !== schedule.weekday) continue;
    const at = zonedTimeToUtc(date, schedule.time);
    if (at.getTime() > now.getTime()) return at;
  }
  // Unreachable for a valid schedule (a weekday recurs within 7 days).
  return zonedTimeToUtc(addDays(today.date, 7), schedule.time);
}

export function isSendSchedule(v: unknown): v is SendSchedule {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    (s.weekday === null || (typeof s.weekday === "number" && s.weekday >= 0 && s.weekday <= 6)) &&
    typeof s.time === "string" &&
    /^\d{2}:\d{2}$/.test(s.time)
  );
}

// ---- Template ----------------------------------------------------------------

/** The placeholders the template may use, and what fills them. */
export interface TemplateFields {
  first_name: string;
  company: string;
  wells: string;
  county: string;
}

/** `{{name}}` → value; unknown placeholders are left as typed. */
export function fillTemplate(template: string, fields: TemplateFields): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
    key in fields ? fields[key as keyof TemplateFields] : whole
  );
}
