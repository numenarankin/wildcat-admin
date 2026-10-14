import "server-only";
import { createHash } from "node:crypto";
import { listCustomers } from "@/lib/admin/customers";
import type { CustomerRow } from "@/lib/admin/customer-rows";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { getStaffSupportThreads } from "@/lib/support/staff-threads";
import type { StaffSupportThread } from "@/lib/support/types";

/**
 * The facts behind the admin dashboard's brief: what changed in the business
 * that the stat cards do not already say. The cards carry paying users, ARR,
 * ACV, growth, referrals and the 30-day sign-up count, so the brief is left
 * with three things:
 *
 *   1. who signed up in the last 7 days, by name;
 *   2. who is still on a trial (the cards count paying users only);
 *   3. support threads waiting on a reply from us.
 *
 * Pure text in, pure text out: the route hands this block to the model and
 * fingerprints it for the brief cache, so two dashboard opens with the same
 * facts serve the same brief without a second model call.
 */

const SIGNUP_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const MAX_NAMED = 5;

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const dayLabel = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "short",
  day: "numeric",
  timeZone: ADMIN_TIME_ZONE,
});

function term(c: CustomerRow): string {
  if (c.term === "year") return "annual";
  if (c.term === "month") return "monthly";
  return "no plan yet";
}

function signupLine(c: CustomerRow): string {
  return `- ${c.name}: signed up ${dayLabel.format(new Date(c.signedUpAt))}, ${c.status}, ${term(c)}, ${usd(c.revenueUsd)}/yr, ${c.activeWells} active wells`;
}

function trialLine(c: CustomerRow): string {
  return `- ${c.name}: ${term(c)}, ${usd(c.revenueUsd)}/yr once billing starts, ${c.activeWells} active wells`;
}

/** An open thread whose latest message came from the customer: our move. */
function awaitingStaff(t: StaffSupportThread): boolean {
  if (t.status !== "open") return false;
  const last = t.messages[t.messages.length - 1];
  return last != null && last.senderRole === "user";
}

function supportLine(t: StaffSupportThread, nowMs: number): string {
  const days = Math.floor((nowMs - t.lastMessageAt) / DAY_MS);
  const age = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  const last = t.messages[t.messages.length - 1];
  const excerpt = (last?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  return `- ${t.customer.orgName} (${t.customer.name}), "${t.subject}", last message ${age}: "${excerpt}"`;
}

function section(title: string, lines: string[], total = lines.length): string {
  if (total === 0) return `${title}: None`;
  const more = total - lines.length;
  const tail = more > 0 ? `\n- and ${more} more` : "";
  return `${title} (${total}):\n${lines.join("\n")}${tail}`;
}

export interface AdminBriefContext {
  facts: string;
  /** False when every section is empty: the route then serves the greeting alone. */
  hasExceptions: boolean;
}

export async function getAdminBriefContext(nowMs = Date.now()): Promise<AdminBriefContext> {
  const [customers, threads] = await Promise.all([listCustomers(), getStaffSupportThreads()]);

  const since = nowMs - SIGNUP_WINDOW_DAYS * DAY_MS;
  const recent = customers
    .filter((c) => Date.parse(c.signedUpAt) >= since)
    .sort((a, b) => Date.parse(b.signedUpAt) - Date.parse(a.signedUpAt));
  const trials = customers.filter((c) => c.status === "trial");
  const waiting = threads.filter(awaitingStaff).sort((a, b) => a.lastMessageAt - b.lastMessageAt);

  const facts = [
    `Today is ${dayLabel.format(new Date(nowMs))}.`,
    section(`NEW SIGN-UPS, last ${SIGNUP_WINDOW_DAYS} days`, recent.slice(0, MAX_NAMED).map(signupLine), recent.length),
    section("ON TRIAL", trials.slice(0, MAX_NAMED).map(trialLine), trials.length),
    section(
      "SUPPORT THREADS WAITING ON A REPLY FROM US",
      waiting.slice(0, MAX_NAMED).map((t) => supportLine(t, nowMs)),
      waiting.length
    ),
  ].join("\n\n");

  return {
    facts,
    hasExceptions: recent.length > 0 || trials.length > 0 || waiting.length > 0,
  };
}

/**
 * The generated brief, fingerprinted against the exact prompt and facts it was
 * written from (the customer app's `morning-brief.ts` pattern). One business,
 * so one entry; the TTL is a backstop so a brief never outlives its greeting.
 */
const BRIEF_TTL_MS = 10 * 60_000;
let briefCache: { at: number; fingerprint: string; text: string } | null = null;

export function briefFingerprint(system: string, facts: string): string {
  return createHash("sha1").update(system).update("\0").update(facts).digest("hex");
}

export function getCachedBrief(fingerprint: string): string | null {
  if (!briefCache || briefCache.fingerprint !== fingerprint) return null;
  if (Date.now() - briefCache.at >= BRIEF_TTL_MS) return null;
  return briefCache.text;
}

export function setCachedBrief(fingerprint: string, text: string): void {
  briefCache = { at: Date.now(), fingerprint, text };
}
