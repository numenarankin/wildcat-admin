import {
  DOLLARS_PER_CREDIT,
  providerCostUsd,
  ttsCostUsd,
  webSearchCostUsd,
} from "@/lib/billing/tiers";
import type {
  AiSpendGroup,
  CustomerPanelData,
  DailyInputs,
  FacilityKind,
  UsageWindow,
} from "@/lib/admin/customer-panel-types";

/**
 * Pure derivations behind the customer panel's Usage and Members tabs. The
 * reads are in `customer-panel.ts`; everything here is arithmetic over what
 * they return, so the figures can be checked by hand.
 */

/** The long window: charts and "last entry". */
export const LONG_WINDOW_DAYS = 90;
/** The recent window: per-facility and per-person counts. */
export const RECENT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for an instant, in `timeZone`. */
export function civilDate(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** `day` moved by `delta` days, both `YYYY-MM-DD`. */
export function addDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Both windows end today, counted inclusively: a 30-day window is today and
 * the 29 days before it. "Today" is the operator's civil date (readings are
 * dated in the field's zone, not UTC).
 */
export function usageWindow(now: Date, timeZone: string): UsageWindow {
  const today = civilDate(now, timeZone);
  return {
    today,
    since: addDays(today, -(LONG_WINDOW_DAYS - 1)),
    recent: addDays(today, -(RECENT_WINDOW_DAYS - 1)),
  };
}

/** Every day from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Entries per day across the window, zero-filled, optionally for one kind.
 * The chart draws a gap-free line; a day with nothing entered is a real zero.
 */
export function entrySeries(
  daily: DailyInputs[],
  window: UsageWindow,
  kind?: FacilityKind
): { date: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const d of daily) {
    if (kind && d.kind !== kind) continue;
    byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.entries);
  }
  return daysBetween(window.since, window.today).map((date) => ({
    date,
    value: byDay.get(date) ?? 0,
  }));
}

/**
 * What a spend group cost us, in USD: the cost the meter recorded, plus the
 * rows that recorded none priced from their quantities at the vendor rates in
 * `tiers.ts` (the same functions the meter uses). An Anthropic row without a
 * model is priced as the meter's default model. STT is not priced: it records
 * no duration, which is what `unpriced` counts.
 */
export function spendCostUsd(g: AiSpendGroup): number {
  let cost = g.costUsd;
  if (g.provider === "anthropic" && g.kind === "tokens") {
    cost += providerCostUsd(g.model ?? "claude-opus-5", {
      // The meter's `input` includes the cache tiers, which price separately.
      inputTokens: Math.max(0, g.input - g.cacheRead - g.cacheWrite),
      outputTokens: g.output,
      cacheReadTokens: g.cacheRead,
      cacheWriteTokens: g.cacheWrite,
    });
  }
  if (g.kind === "web_search") cost += webSearchCostUsd(g.requests);
  if (g.kind === "tts") cost += ttsCostUsd(g.chars);
  return cost;
}

/** What the credits a group used are worth at the credit price. */
export function spendValueUsd(g: AiSpendGroup): number {
  return g.credits * DOLLARS_PER_CREDIT;
}

/** One value per day across the window, zero-filled, from the spend groups. */
function spendSeries(
  groups: AiSpendGroup[],
  window: UsageWindow,
  value: (g: AiSpendGroup) => number
): { date: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const g of groups) byDay.set(g.day, (byDay.get(g.day) ?? 0) + value(g));
  return daysBetween(window.since, window.today).map((date) => ({
    date,
    value: byDay.get(date) ?? 0,
  }));
}

/** AI credits used per day. */
export function creditSeries(groups: AiSpendGroup[], window: UsageWindow) {
  return spendSeries(groups, window, (g) => g.credits);
}

/** What the AI cost us per day, USD. */
export function costSeries(groups: AiSpendGroup[], window: UsageWindow) {
  return spendSeries(groups, window, spendCostUsd);
}

/** Credit value less vendor cost per day, USD. */
export function profitSeries(groups: AiSpendGroup[], window: UsageWindow) {
  return spendSeries(groups, window, (g) => spendValueUsd(g) - spendCostUsd(g));
}

const LINE_LABEL: Record<string, string> = {
  "anthropic:tokens": "Claude",
  "anthropic:web_search": "Web search",
  "elevenlabs:tts": "Voice (ElevenLabs)",
  "elevenlabs:stt": "Transcription (ElevenLabs)",
  "compute:tokens": "Compute",
};

export interface AiLine {
  label: string;
  calls: number;
  credits: number;
  valueUsd: number;
  /** Null when some of its calls could not be priced. */
  costUsd: number | null;
  profitUsd: number | null;
}

export interface AiEconomics {
  credits: number;
  valueUsd: number;
  costUsd: number;
  profitUsd: number;
  /** Calls left out of cost and profit because nothing prices them. */
  unpricedCalls: number;
  lines: AiLine[];
}

/**
 * Credits used, what they are worth, what they cost us and the difference,
 * from `fromDay` on, in total and per provider line. A line with unpriced
 * calls shows no cost or profit, and the total profit leaves that line out
 * (its value as well as its cost), so it is never flattered by a call that
 * only looks free because nothing recorded what it cost.
 */
export function aiEconomics(groups: AiSpendGroup[], fromDay: string): AiEconomics {
  const lines = new Map<string, AiLine & { unpriced: number }>();
  for (const g of groups) {
    if (g.day < fromDay) continue;
    const key = `${g.provider}:${g.kind}`;
    const line = lines.get(key) ?? {
      label: LINE_LABEL[key] ?? `${g.provider} ${g.kind}`,
      calls: 0,
      credits: 0,
      valueUsd: 0,
      costUsd: 0,
      profitUsd: 0,
      unpriced: 0,
    };
    line.calls += g.calls;
    line.credits += g.credits;
    line.valueUsd += spendValueUsd(g);
    line.costUsd = (line.costUsd ?? 0) + spendCostUsd(g);
    line.unpriced += g.unpriced;
    lines.set(key, line);
  }
  const out: AiLine[] = [];
  let credits = 0;
  let valueUsd = 0;
  let costUsd = 0;
  let pricedValueUsd = 0;
  let unpricedCalls = 0;
  for (const l of lines.values()) {
    credits += l.credits;
    unpricedCalls += l.unpriced;
    const priced = l.unpriced === 0;
    valueUsd += l.valueUsd;
    if (priced) {
      pricedValueUsd += l.valueUsd;
      costUsd += l.costUsd ?? 0;
    }
    out.push({
      label: l.label,
      calls: l.calls,
      credits: l.credits,
      valueUsd: l.valueUsd,
      costUsd: priced ? l.costUsd : null,
      profitUsd: priced ? l.valueUsd - (l.costUsd ?? 0) : null,
    });
  }
  out.sort((a, b) => b.credits - a.credits);
  return { credits, valueUsd, costUsd, profitUsd: pricedValueUsd - costUsd, unpricedCalls, lines: out };
}

export interface UsageTotals {
  /** Live facilities by kind, and all of them. */
  facilities: Record<FacilityKind, number> & { total: number };
  /** Entries in the recent window, all facilities. */
  entriesRecent: number;
  /** Facilities that CAN take entries (not batteries), and how many did recently. */
  enterable: number;
  withData: number;
  /** AI credits used in the recent window. */
  creditsRecent: number;
  /** People with an account: active members, and invites still pending. */
  activeMembers: number;
  invitedMembers: number;
  /** Active members whose phone synced in the recent window. */
  phoneUsersRecent: number;
}

export function usageTotals(data: CustomerPanelData): UsageTotals {
  const facilities = { well: 0, tank: 0, meter: 0, battery: 0, total: 0 };
  let entriesRecent = 0;
  let enterable = 0;
  let withData = 0;
  for (const f of data.facilities) {
    facilities[f.kind] += 1;
    facilities.total += 1;
    entriesRecent += f.entries;
    if (f.kind !== "battery") {
      enterable += 1;
      if (f.entries > 0) withData += 1;
    }
  }
  const recentStartMs = Date.parse(`${data.window.recent}T00:00:00Z`);
  const active = data.members.filter((m) => m.status === "active");
  return {
    facilities,
    entriesRecent,
    enterable,
    withData,
    creditsRecent: data.aiSpend
      .filter((c) => c.day >= data.window.recent)
      .reduce((sum, c) => sum + c.credits, 0),
    activeMembers: active.length,
    invitedMembers: data.members.filter((m) => m.status === "invited").length,
    phoneUsersRecent: active.filter(
      (m) => m.phoneLastSeenAt && Date.parse(m.phoneLastSeenAt) >= recentStartMs
    ).length,
  };
}

/**
 * Entries in the recent window that no listed member made: rows with no
 * author recorded (imports, system writes) and rows by someone who is not on
 * this org's roster. Shown as its own line so the Members tab adds up to the
 * same total as the Usage tab.
 */
export function unlistedEntries(data: CustomerPanelData): number {
  const listed = new Set(data.members.map((m) => m.authUserId).filter(Boolean));
  return data.authors
    .filter((a) => !a.userId || !listed.has(a.userId))
    .reduce((sum, a) => sum + a.entries, 0);
}
