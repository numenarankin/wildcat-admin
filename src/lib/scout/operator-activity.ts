/**
 * The operator dossier's Activity feed: one merged, reverse-chronological list
 * of what an operator DID, out of the dated records the mirror already carries.
 *
 * Pure. Everything here works on the payload `getOperatorProfile` already
 * returns, which is the point: the feed is a second reading of the same rows
 * the Permits tab and the well buckets render, so the two views of a number
 * cannot disagree. If the permit slice is capped at 200, this feed's permit
 * rows are capped with it rather than being fetched again and quietly covering
 * a different set.
 *
 * FIVE EVENTS, FROM FOUR RECORDS:
 *
 *   permit filed    `rrc.permit.filed_date`     one permit row
 *   permit issued   `rrc.permit.issued_date`    THE SAME permit row
 *   completed       `rrc.wellbore.completion_date`
 *   plugged         `rrc.wellbore.plug_date`
 *   P-5 renewed     `rrc.operators.last_p5_date`
 *
 * ONE ROW PER EVENT, NOT PER RECORD. A permit that was filed in March and
 * granted in June is two rows months apart, because that is what happened; a
 * feed that emitted one row per permit would be a permit list with a date on it
 * and would answer a different question.
 *
 * A NULL OR MALFORMED DATE IS DROPPED. The mirror stores wellbore dates as
 * `YYYYMMDD` TEXT and zero-fills what it does not know ('19750000'), so a date
 * has to be validated rather than parsed: an event nobody can place in time is
 * not evidence of anything, and rendering it as 1970 or as January 1st invents
 * a fact. `isoDate` is the one gate every source passes through.
 */
import { COUNTY_NAMES } from "./counties";
import { api8, fmtDate8, titleCase } from "./format";
import { leaseKeyFromWellbore, type PdqLeaseKey } from "./lease-key";
import type { OperatorPermit, OperatorWellEvent } from "./types";

export type ActivityKind =
  | "permit-filed"
  | "permit-issued"
  | "completed"
  | "plugged"
  | "p5-renewed";

/** What each event is called in the feed. Past tense: this already happened. */
export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  "permit-filed": "Permit filed",
  "permit-issued": "Permit issued",
  completed: "Well completed",
  plugged: "Well plugged",
  "p5-renewed": "P-5 renewed",
};

/**
 * Tie-break order for events sharing a date, so a same-day filing and grant
 * read in the order they must have happened rather than in payload order.
 * Applied only within one date; the feed is chronological first.
 */
const KIND_RANK: Record<ActivityKind, number> = {
  "permit-filed": 0,
  "permit-issued": 1,
  completed: 2,
  plugged: 3,
  "p5-renewed": 4,
};

export interface ActivityEvent {
  /** Stable React key. Unique because kind + record identity is unique. */
  id: string;
  kind: ActivityKind;
  /** `YYYY-MM-DD`, always valid — an unparseable date never becomes an event. */
  date: string;
  /** What the row names: the well, the permit, or the operator. */
  name: string;
  /** Second line under the name: the API, the well number. Null when neither. */
  detail: string | null;
  /** Click target for the well, when the event names a hole with an API. */
  api: number | null;
  /** Click target for the lease, when the wellbore row spells a whole key. */
  lease: PdqLeaseKey | null;
  /** The lease as text, for the rows whose key does not resolve (permits). */
  lease_name: string | null;
  county: string | null;
}

export interface ActivityYear {
  year: number;
  /** Events in this bucket. The header prints it; the rows are the proof. */
  count: number;
  /**
   * The RRC has not finished telling us about this year. Drawn, not hidden:
   * the same honesty the production strip applies to its unreported tail.
   */
  partial: boolean;
  events: ActivityEvent[];
}

export interface ActivityInput {
  /** `OperatorProfile.permits` — the same slice the Permits tab renders. */
  permits: OperatorPermit[];
  /** `OperatorProfile.wellEvents` — completions and pluggings under this P-5. */
  wellEvents: OperatorWellEvent[];
  /** `operators.last_p5_date`, `YYYYMMDD` as an int, as the profile carries it. */
  lastP5Date?: number | null;
  operatorName?: string | null;
}

/**
 * HOW FAR BEHIND THE RECORD RUNS.
 *
 * Permits, completion reports and W-3s all reach the mirror months after the
 * work, the same lag the production charts shade at ~3 months. It is used for
 * one thing only: deciding which year buckets are still filling up.
 */
export const FILING_LAG_MONTHS = 3;

/**
 * `YYYY-MM-DD` if this is a date a person could point at on a calendar,
 * otherwise null.
 *
 * Deliberately strict. The mirror's wellbore dates are text and carry zero
 * months and zero days for "not stated"; a permissive parse turns those into
 * January 1st, which reads as a real event on a real day and is not one.
 */
export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  // 1900 rather than 1: Texas' first permit predates neither, and a four-digit
  // year below it is a corrupt field, not a nineteenth-century well.
  if (year < 1900 || year > 2999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/**
 * Is this year still being filed into?
 *
 * True for the year in progress AND, in the first months of a new year, for the
 * one just past — a January reader is looking at a bucket the RRC is still
 * three months from finishing. Derived from the lag, not from "the newest
 * bucket in the array": an operator whose last activity was 2014 has a complete
 * 2014, and marking it incomplete would be a lie about the data.
 */
export function isPartialYear(year: number, asOf: Date): boolean {
  const edge = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - FILING_LAG_MONTHS, 1)
  );
  return year >= edge.getUTCFullYear();
}

/**
 * The name a person calls the hole: the lease and the well number, together.
 *
 * One construction, shared with the operator modal's well tables and with
 * `/api/scout/well-rate`'s hover label, so a well is called the same thing on
 * the Activity feed as in the bucket it sits in. Null when the row carries
 * neither half.
 */
export function wellLabel(
  leaseName: string | null | undefined,
  wellNo: string | null | undefined
): string | null {
  const lease = titleCase(leaseName);
  const no = wellNo?.trim();
  return [lease, no].filter(Boolean).join(" ") || null;
}

/** "Permit 0912345", plus the amendment when this is not the original. */
function permitLabel(p: OperatorPermit): string {
  const base = p.permit_number ? `Permit ${p.permit_number}` : "Permit";
  // 99 is the original; anything lower is an amendment, the same reading the
  // Permits table prints.
  return p.permit_seq && p.permit_seq !== "99" ? `${base} amd ${p.permit_seq}` : base;
}

function county(code: number | null | undefined): string | null {
  if (code == null) return null;
  return COUNTY_NAMES[code] ?? `County ${code}`;
}

/**
 * Every event this payload can date, newest first.
 *
 * Sorting is by date, then by `KIND_RANK`, then by id — total and stable, so
 * the feed does not reshuffle between renders and two events on one day always
 * read in the same order.
 */
export function activityEvents(input: ActivityInput): ActivityEvent[] {
  const out: ActivityEvent[] = [];

  for (const p of input.permits) {
    const key = `${p.permit_number ?? ""}-${p.permit_seq ?? ""}`;
    const shared = {
      name: permitLabel(p),
      detail: p.well_number ? `well ${p.well_number.trim()}` : null,
      // The permit register holds no API; only permits this mirror watched pass
      // through the pending feed carry one, and only those can open a well.
      api: p.api_number && /^\d+$/.test(p.api_number) ? Number(p.api_number) : null,
      // `rrc.permit` names the lease but carries no lease NUMBER, so there is no
      // key to open with. The name still reads as text.
      lease: null,
      lease_name: p.lease_name,
      county: titleCase(p.county_name) || null,
    };
    const filed = isoDate(p.filed_date);
    if (filed) {
      out.push({ id: `pf-${key}`, kind: "permit-filed", date: filed, ...shared });
    }
    const issued = isoDate(p.issued_date);
    if (issued) {
      out.push({ id: `pi-${key}`, kind: "permit-issued", date: issued, ...shared });
    }
  }

  /*
   * ONE ROW PER EVENT, and a hole completed into two fields on one day is ONE
   * event reported twice. The wellbore grain is well x lease x field, so that
   * hole arrives as two rows carrying the same date; a recompletion months
   * later is a different date and stays a second event. Without this the feed
   * prints the same completion twice and two rows share a React key.
   */
  const seen = new Set<string>();
  for (const w of input.wellEvents) {
    const shared = {
      name: wellLabel(w.lease_name, w.well_no) ?? api8(w.api_number),
      detail: api8(w.api_number),
      api: w.api_number,
      // EWA's district label, translated to PDQ's internal code on the way in —
      // joining the two directly lands on another operator's lease. See
      // `lease-key.ts`.
      lease: leaseKeyFromWellbore(w.oil_gas_code, w.district, w.lease_number),
      lease_name: w.lease_name,
      county: county(w.county_code),
    };
    const completed = isoDate(w.completion_date);
    if (completed && !seen.has(`c-${w.api_number}-${completed}`)) {
      seen.add(`c-${w.api_number}-${completed}`);
      out.push({
        // The date is part of the key, and with the dedupe above it is unique:
        // one hole, one completion per day, however many lease rows carry it.
        id: `wc-${w.api_number}-${completed}`,
        kind: "completed",
        date: completed,
        ...shared,
      });
    }
    const plugged = isoDate(w.plug_date);
    if (plugged && !seen.has(`p-${w.api_number}-${plugged}`)) {
      seen.add(`p-${w.api_number}-${plugged}`);
      out.push({
        id: `wp-${w.api_number}-${plugged}`,
        kind: "plugged",
        date: plugged,
        ...shared,
      });
    }
  }

  const p5 = isoDate(fmtDate8(input.lastP5Date));
  if (p5) {
    out.push({
      id: "p5",
      kind: "p5-renewed",
      date: p5,
      name: titleCase(input.operatorName) || "Organization report",
      detail: null,
      api: null,
      lease: null,
      lease_name: null,
      county: null,
    });
  }

  return out.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.id.localeCompare(b.id)
  );
}

/**
 * The feed the tab renders: events bucketed by year, newest bucket first.
 *
 * BUCKETS, NOT A SCROLL. A busy operator files thousands of permits, and a flat
 * list of them is a log rather than a story; the year header with its count is
 * what makes "they drilled hard in 2018 and stopped" visible without reading a
 * single row.
 *
 * `asOf` is injected rather than read from the clock so the partial-year mark
 * is testable against a fixed date.
 */
export function buildActivity(
  input: ActivityInput,
  asOf: Date = new Date()
): ActivityYear[] {
  const years: ActivityYear[] = [];
  let current: ActivityYear | null = null;
  // The events are already newest-first, so one pass yields the buckets in
  // order and each bucket's rows keep the feed's order inside it.
  for (const e of activityEvents(input)) {
    const year = Number(e.date.slice(0, 4));
    if (!current || current.year !== year) {
      current = { year, count: 0, partial: isPartialYear(year, asOf), events: [] };
      years.push(current);
    }
    current.events.push(e);
    current.count++;
  }
  return years;
}
