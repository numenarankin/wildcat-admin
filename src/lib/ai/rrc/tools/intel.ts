import "server-only";

import { z } from "zod";

import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import {
  findDisposal,
  findWells,
  getApprovedPermits,
  getCountyProfile,
  getCycleEdge,
  getOperatorDisposal,
  getOperatorDossier,
  getPendingQueue,
  listPermits,
  resolveCounty,
  type NearbyWell,
  type PendingPermit,
} from "@/lib/scout/rrc-queries";
import { distanceMiles, median, percentile, sum } from "../math";
import { defineTool, type RrcTool } from "../tool";

/**
 * Competitive intelligence over the Texas public record: what other operators
 * are doing, who is connected to whom, what is about to happen in an area, and
 * what our own filings broadcast back.
 *
 * Five facts hold across this file and are attached to results rather than left
 * in a comment, because each one is a wrong answer waiting to happen:
 *
 *   1. OFFICERS ARE MATCHED ON THE NAME AS FILED. There is no person id in the
 *      record. A common name links unrelated companies and one person can be
 *      filed under several spellings, so every graph result carries a
 *      confidence and says it is a lead to check.
 *   2. A FILING IS AN OBSERVATION, NOT A MOTIVE. The tools that walk entity
 *      formation, delinquency and plugging return the filings and their dates.
 *      They never return a conclusion about intent or conduct, because the
 *      record cannot support one and a reader will take one if offered.
 *   3. PURPOSE CODES AND COORDINATES LIVE ONLY IN THE PENDING FEED. rrc.permit
 *      is 950,665 approved permits with no purpose column and not one position;
 *      the twice-daily W-1 feed carries both, and this mirror has held it since
 *      2025-07-07. Any purpose split is that window, and says so.
 *   4. PRODUCTION RUNS ~3 MONTHS BEHIND and unfiled cycles are zeros in the
 *      mirror. Anything trending production drops the unreported tail first.
 *   5. EVERY TOOL NEEDS A NARROWING FILTER. rrc.permit alone is 950,665 rows
 *      behind a 5 s statement timeout, so an unfiltered statewide scan is
 *      refused rather than attempted.
 */

const NAME_AS_FILED =
  "Officers are matched on the NAME AS FILED, because the record carries no person identifier. A common name links companies that have nothing to do with each other, and one person filed two ways looks like two people. Every link here is a LEAD TO CHECK, not a proven relationship.";

const OBSERVED_FACTS =
  "These are filings and the dates they carry. Company formation, operator changes, delinquent tests and plugging all have ordinary explanations, and nothing here is a finding about intent or conduct.";

const PENDING_WINDOW =
  "Filing purpose comes from the twice-daily W-1 pending feed, held in this mirror since 2025-07-07. rrc.permit, the approved master, carries no purpose code at all, so nothing before that date can be split by purpose.";

const NO_PERMIT_COORDS =
  "rrc.permit carries no coordinates on any of its 950,665 rows. The only permits that can be placed on the ground are the ones seen in the pending feed, which is 2025-07-07 forward.";

const lagNote = (edge: string) =>
  `Production is published about three months behind and the unfiled cycles sit in the mirror as zeros rather than as gaps. Everything trended here stops at ${edge}.`;

function fail(error: string) {
  return { ok: false as const, error };
}

function clampInt(v: number | undefined, dflt: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(v ?? dflt)));
}

/** Today, as the record spells dates. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` shifted by whole months, for the forward-looking tools. */
function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = y * 12 + (m - 1) + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * `rrc.completion` stores every date as TEXT in MM/DD/YYYY.
 *
 * Which means its `approved_dt DESC` index sorts 12/31/2025 above 01/04/2026,
 * and any tool that ordered or ranged on the raw column would silently answer
 * for the wrong year. Every date out of that table goes through here first.
 */
function mdy(v: string | null | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((v ?? "").trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** `rrc.wellbore` date columns are TEXT YYYYMMDD, with 0 and '' for unknown. */
function ymd(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
}

/** W-2/G-1 COMPLETION_TYPE, per the completion manual's packet layout. */
const COMPLETION_TYPE: Record<string, string> = {
  "1": "New well",
  "2": "Deepening",
  "3": "Plug back",
  "4": "Sidetrack",
  "5": "Horizontal",
  "6": "Reentry",
  "7": "Other",
};

/** W-2/G-1 PURPOSE_OF_FILING, same source. */
const FILING_PURPOSE: Record<string, string> = {
  "1": "Initial potential",
  "2": "Retest",
  "3": "Reclass oil to gas",
  "4": "Reclass gas to oil",
  "5": "Reclass injection to producing",
  "6": "Reclass producing to injection",
  "7": "Well record only",
};

/** W-1 FILING_PURPOSE_CODE, a different list on a different form. */
const PENDING_PURPOSE: Record<string, string> = {
  "01": "New drill",
  "07": "Reenter",
  "09": "Field transfer",
  "14": "Recompletion",
  "15": "Reclass",
  "16": "Amended as-drilled BHL",
  "99": "Unknown",
};

/** P-4 counterparty roles and products, per the P-4 tape's own 88-levels. */
const P4_ROLE: Record<string, string> = { G: "gatherer", H: "purchaser", I: "nominator" };
const P4_PRODUCT: Record<string, string> = {
  F: "full well stream",
  G: "gas well gas",
  H: "condensate",
  O: "oil",
  P: "casinghead gas",
};

/**
 * Completion types that put an EXISTING hole back to work.
 *
 * Not the same question as "is this the wellbore's second filing", which is why
 * both tests are applied and both reported: an operator can file a recompletion
 * as type 7 (Other), and a first filing on a 1950s hole is a new record rather
 * than new work.
 */
const REWORK_TYPES = new Set(["2", "3", "4", "6"]);

// ------------------------------------------------------------------- area

/**
 * The area argument for the tools that work over a set of wells.
 *
 * One of county, operator or point is REQUIRED and an unfiltered call is
 * refused, the same rule `findWells` follows internally.
 */
const AREA_SHAPE = {
  county: z.string().optional(),
  operator_no: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  radius_mi: z.number().optional(),
  limit: z.number().int().optional(),
};

interface AreaArgs {
  county?: string;
  operator_no?: string;
  lat?: number;
  lon?: number;
  radius_mi?: number;
  limit?: number;
}

const NO_AREA =
  "An area is required: give a county, an operator_no, or lat and lon. A statewide scan is refused.";

/** The wells an area argument names, or a refusal. */
async function areaWells(
  a: AreaArgs,
  cap: number
): Promise<{ label: string; wells: NearbyWell[] } | { error: string }> {
  const hasPoint = Number.isFinite(a.lat) && Number.isFinite(a.lon);
  const county = a.county?.trim();
  const op = a.operator_no?.trim();
  if (!hasPoint && !county && !op) return { error: NO_AREA };
  if (county && !resolveCounty(county)) return { error: `Not a Texas county: ${county}.` };

  const wells = await findWells({
    lat: hasPoint ? a.lat : undefined,
    lon: hasPoint ? a.lon : undefined,
    radiusMi: a.radius_mi,
    county,
    operatorNo: op,
    limit: cap,
  });
  const label = [
    county ? `${resolveCounty(county)!.county_name} County` : null,
    op ? `operator ${op}` : null,
    hasPoint ? `${a.radius_mi ?? 5} mi of ${a.lat}, ${a.lon}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { label, wells };
}

// -------------------------------------------------------------- the graph

/**
 * What a link is worth, and why these numbers.
 *
 * ASSERTED, not fitted. Nothing in the public record labels a corporate family,
 * so there is no training set and these weights are a stated prior rather than
 * a measurement: a shared officer name and a shared mailing address is the
 * strongest thing the file can say, a shared surname is close to nothing.
 * `rrc_backtest` is where a weight like this earns its keep, and until it has
 * been run against an outcome these are exactly as good as the reasoning above.
 */
const SIGNAL_WEIGHT = {
  officer: 0.5,
  /** The same name, filed on so many operators that it stops distinguishing. */
  officer_common: 0.15,
  address: 0.3,
  phone: 0.15,
  zip: 0.05,
  surname: 0.1,
} as const;

/** A filing agent sits on hundreds of P-5s. Past this, a name is not a link. */
const COMMON_NAME_OPERATORS = 10;

/** Never 1.0. The record cannot prove a relationship, only suggest one. */
const MAX_CONFIDENCE = 0.95;

function addrKey(s: string | null | undefined): string {
  return (s ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
function phoneKey(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}
function zipKey(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").slice(0, 5);
}
/** "SURNAME, GIVEN" is how 95% of officer names are filed. */
function surnameOf(name: string | null | undefined): string {
  const s = (name ?? "").trim().toUpperCase();
  if (!s) return "";
  return (s.includes(",") ? s.split(",")[0] : s.split(/\s+/).slice(-1)[0]).trim();
}

interface OperatorRow {
  operator_number: string;
  operator_name: string | null;
  p5_status: string | null;
  org_date?: string | null;
  last_p5_date?: string | null;
  addr1?: string | null;
  city1?: string | null;
  state1?: string | null;
  zip1?: string | null;
  phone1?: string | null;
}

async function operatorRow(operatorNo: string): Promise<OperatorRow | null> {
  return rrcQueryOne<OperatorRow>(
    `select operator_number, operator_name, p5_status, addr1, city1, state1, zip1,
            phone1,
            to_char(org_date, 'YYYY-MM-DD')     as org_date,
            to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
       from rrc.operators where operator_number = $1`,
    [operatorNo]
  );
}

interface OfficerRow {
  officer_name: string;
  officer_title: string | null;
  operator_number: string;
}

/** Officers on one operator's P-5. */
async function officersOf(operatorNo: string): Promise<OfficerRow[]> {
  return rrcQuery<OfficerRow>(
    `select officer_name, officer_title, operator_number
       from rrc.operator_officers
      where operator_number = $1 and nullif(btrim(officer_name), '') is not null
      order by officer_title, officer_name`,
    [operatorNo]
  );
}

/** How many operators each of these names sits on. The commonness discount. */
async function nameSpread(names: string[]): Promise<Map<string, number>> {
  if (!names.length) return new Map();
  const rows = await rrcQuery<{ officer_name: string; n: number }>(
    `select officer_name, count(distinct operator_number)::int as n
       from rrc.operator_officers
      where officer_name = any($1::text[])
      group by officer_name`,
    [names]
  );
  return new Map(rows.map((r) => [r.officer_name, r.n]));
}

interface Link {
  operator_number: string;
  operator_name: string | null;
  p5_status: string | null;
  signals: { signal: string; weight: number; evidence: string }[];
  confidence: number;
}

function scoreLink(link: Omit<Link, "confidence">): Link {
  return {
    ...link,
    confidence: Math.min(MAX_CONFIDENCE, sum(link.signals.map((s) => s.weight))),
  };
}

// ------------------------------------------------------------------ 45

const operatorTimeline = defineTool(
  "rrc_operator_timeline",
  "One operator's permits, spuds, completions, recompletions, first production and plugs on a single date-ordered line.",
  {
    operator_no: z.string(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async ({ operator_no, since, until, limit }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const cap = clampInt(limit, 300, 10, 1000);

    const [permits, completions, plugged, first] = await Promise.all([
      listPermits({ operatorNo: op, since, until, limit: 500 }),
      // Index-backed on operator_no. Dates are text MM/DD/YYYY, so the window
      // is applied here rather than in SQL: see `mdy`.
      rrcQuery<{
        api_no: string | null;
        lease_name: string | null;
        well_no: string | null;
        field_no: string | null;
        field_name: string | null;
        completion_type: string | null;
        purpose_of_filing: string | null;
        spud_dt: string | null;
        cmpl_or_recmpl_date: string | null;
        approved_dt: string | null;
      }>(
        `select api_no, lease_name, well_no, field_no, field_name,
                completion_type, purpose_of_filing,
                spud_dt, cmpl_or_recmpl_date, approved_dt
           from rrc.completion
          where operator_no = $1`,
        [op]
      ),
      rrcQuery<{
        api_number: string;
        lease_name: string | null;
        well_no: string | null;
        plug_date: string | null;
      }>(
        `select api_number, lease_name, well_no, plug_date
           from rrc.wellbore
          where operator_number = $1::bpchar
            and nullif(btrim(plug_date), '') is not null`,
        [op]
      ),
      rrcQueryOne<{ first_cycle: string | null }>(
        `select to_char(min(cycle), 'YYYY-MM') as first_cycle
           from rrc.operator_production
          where operator_no = $1
            and (coalesce(oil_prod_vol,0) > 0 or coalesce(gas_prod_vol,0) > 0)`,
        [op]
      ),
    ]);

    interface Event {
      date: string;
      event: string;
      api_number?: string | null;
      lease_name?: string | null;
      well_no?: string | null;
      detail?: string | null;
      field_name?: string | null;
    }
    const events: Event[] = [];

    for (const p of permits) {
      if (p.issued_date) {
        events.push({
          date: p.issued_date,
          event: "permit issued",
          lease_name: p.lease_name,
          well_no: p.well_number,
          detail: `permit ${p.permit_number ?? "?"}, TD ${p.total_depth ?? "?"} ft`,
        });
      }
      if (p.filed_date && p.filed_date !== p.issued_date) {
        events.push({
          date: p.filed_date,
          event: "permit filed",
          lease_name: p.lease_name,
          well_no: p.well_number,
          detail: `permit ${p.permit_number ?? "?"}`,
        });
      }
    }

    // First filing on a hole versus a later one, computed over this operator's
    // own filings only. A hole they took over already completed shows here as a
    // first filing, which is why the completion_type flag is reported beside it.
    const byApi = new Map<string, string[]>();
    for (const c of completions) {
      const d = mdy(c.cmpl_or_recmpl_date) ?? mdy(c.approved_dt);
      if (c.api_no && d) byApi.set(c.api_no, [...(byApi.get(c.api_no) ?? []), d]);
    }
    for (const c of completions) {
      const spud = mdy(c.spud_dt);
      if (spud) {
        events.push({
          date: spud,
          event: "spud",
          api_number: c.api_no,
          lease_name: c.lease_name,
          well_no: c.well_no,
          field_name: c.field_name,
        });
      }
      const done = mdy(c.cmpl_or_recmpl_date) ?? mdy(c.approved_dt);
      if (!done) continue;
      const earlier = (byApi.get(c.api_no ?? "") ?? []).filter((d) => d < done).length > 0;
      const rework = REWORK_TYPES.has((c.completion_type ?? "").trim());
      events.push({
        date: done,
        event: earlier || rework ? "recompletion" : "completion",
        api_number: c.api_no,
        lease_name: c.lease_name,
        well_no: c.well_no,
        field_name: c.field_name,
        detail: [
          COMPLETION_TYPE[(c.completion_type ?? "").trim()],
          FILING_PURPOSE[(c.purpose_of_filing ?? "").trim()],
        ]
          .filter(Boolean)
          .join(", "),
      });
    }

    for (const w of plugged) {
      const d = ymd(w.plug_date);
      if (d) {
        events.push({
          date: d,
          event: "plug",
          api_number: w.api_number.trim(),
          lease_name: w.lease_name,
          well_no: w.well_no,
        });
      }
    }

    if (first?.first_cycle) {
      events.push({ date: `${first.first_cycle}-01`, event: "first reported production" });
    }

    const from = since?.trim() || null;
    const to = until?.trim() || null;
    const inWindow = events.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
    inWindow.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const shown = inWindow.slice(-cap);

    return {
      ok: true as const,
      operator_no: op,
      window: { since: from, until: to },
      events: shown,
      counts: shown.reduce<Record<string, number>>((acc, e) => {
        acc[e.event] = (acc[e.event] ?? 0) + 1;
        return acc;
      }, {}),
      truncated: inWindow.length > shown.length,
      notes: [
        "A permit is the operator who applied, a completion the operator who filed the W-2 or G-1, and a plug the operator carrying the well on schedule today. A well that changed hands appears under different names at different steps.",
        'Recompletion means this operator had already filed on the hole, OR the filing is typed deepening, plug back, sidetrack or reentry. A first filing on an old hole is labelled "completion" even when it is decades of work later.',
        "Plugs are read off wells still on this operator's schedule. A plugged well that has since moved to another P-5 is not here.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 46

const recompletionWatch = defineTool(
  "rrc_recompletion_watch",
  "New completion filings against old wellbores in an area, with the field and formations the operator moved to.",
  { ...AREA_SHAPE, since: z.string().optional() },
  async (args) => {
    const cap = clampInt(args.limit, 200, 1, 400);
    const set = await areaWells(args, cap);
    if ("error" in set) return fail(set.error);
    if (!set.wells.length) {
      return { ok: true as const, area: set.label, wells: 0, recompletions: [], truncated: false };
    }
    const since = args.since?.trim() || shiftMonths(today(), -24);
    const apis = set.wells.map((w) => w.api_number.trim());

    const filings = await rrcQuery<{
      tracking_no: string | null;
      api_no: string;
      operator_no: string | null;
      lease_name: string | null;
      well_no: string | null;
      field_no: string | null;
      field_name: string | null;
      completion_type: string | null;
      purpose_of_filing: string | null;
      cmpl_or_recmpl_date: string | null;
      approved_dt: string | null;
    }>(
      `select tracking_no, api_no, operator_no, lease_name, well_no,
              field_no, field_name, completion_type, purpose_of_filing,
              cmpl_or_recmpl_date, approved_dt
         from rrc.completion
        where api_no = any($1::text[])`,
      [apis]
    );

    // The whole filing history per hole, so "new work on an old wellbore" is a
    // comparison against that hole's own first filing rather than against a
    // date somebody picked.
    const history = new Map<string, string[]>();
    for (const f of filings) {
      const d = mdy(f.cmpl_or_recmpl_date) ?? mdy(f.approved_dt);
      if (d) history.set(f.api_no, [...(history.get(f.api_no) ?? []), d]);
    }

    const recent = filings.filter((f) => {
      const d = mdy(f.cmpl_or_recmpl_date) ?? mdy(f.approved_dt);
      if (!d || d < since) return false;
      const prior = (history.get(f.api_no) ?? []).filter((x) => x < d);
      return prior.length > 0 || REWORK_TYPES.has((f.completion_type ?? "").trim());
    });

    const ids = recent.map((r) => r.tracking_no).filter((v): v is string => Boolean(v));
    const zones = ids.length
      ? await rrcQuery<{ tracking_no: string; formation: string | null; depth: string | null }>(
          `select tracking_no, formation, depth
             from rrc.completion_formation
            where tracking_no = any($1::text[])`,
          [ids]
        )
      : [];

    const byWell = new Map(set.wells.map((w) => [w.api_number.trim(), w]));
    const rows = recent
      .map((f) => {
        const d = mdy(f.cmpl_or_recmpl_date) ?? mdy(f.approved_dt)!;
        const prior = (history.get(f.api_no) ?? []).filter((x) => x < d).sort();
        const well = byWell.get(f.api_no);
        return {
          api_number: f.api_no,
          filed_date: d,
          operator_no: f.operator_no?.trim() ?? null,
          operator_name: well?.operator_name ?? null,
          lease_name: f.lease_name ?? well?.lease_name ?? null,
          well_no: f.well_no,
          distance_mi: well?.distance_mi ?? null,
          first_filing_on_hole: prior[0] ?? null,
          years_since_first: prior[0] ? daysBetween(prior[0], d) / 365.25 : null,
          completion_type: COMPLETION_TYPE[(f.completion_type ?? "").trim()] ?? f.completion_type,
          purpose: FILING_PURPOSE[(f.purpose_of_filing ?? "").trim()] ?? f.purpose_of_filing,
          moved_to_field_no: f.field_no,
          moved_to_field: f.field_name,
          formations: zones
            .filter((z) => z.tracking_no === f.tracking_no)
            .map((z) => ({ formation: z.formation, depth: z.depth })),
        };
      })
      .sort((a, b) => (a.filed_date < b.filed_date ? 1 : -1));

    return {
      ok: true as const,
      area: set.label,
      since,
      wells_searched: set.wells.length,
      recompletions: rows,
      operators: [...new Set(rows.map((r) => r.operator_no).filter(Boolean))],
      truncated: set.wells.length >= cap,
      notes: [
        "The field on the filing is the RESERVOIR the operator says the well now produces from, which is the zone they moved to. Formation rows are the tops as filed on that packet, not a log interpretation.",
        "Completion filing runs behind the work: the date here is the completion or recompletion date on the packet, and the packet is approved later.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 47

const zoneMigration = defineTool(
  "rrc_zone_migration",
  "How an operator's or a county's targeted field and permitted depth have shifted year by year.",
  {
    operator_no: z.string().optional(),
    county: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
  },
  async ({ operator_no, county, since, until }) => {
    const op = operator_no?.trim();
    const cty = county?.trim() ? resolveCounty(county.trim()) : null;
    if (!op && !cty) {
      return fail(
        county?.trim()
          ? `Not a Texas county: ${county}.`
          : "operator_no or county is required. A statewide scan is refused."
      );
    }
    const from = since?.trim() || `${new Date().getUTCFullYear() - 15}-01-01`;
    const to = until?.trim() || today();

    const [filings, permits] = await Promise.all([
      op
        ? rrcQuery<{
            field_no: string | null;
            field_name: string | null;
            completion_type: string | null;
            cmpl_or_recmpl_date: string | null;
            approved_dt: string | null;
          }>(
            `select field_no, field_name, completion_type, cmpl_or_recmpl_date, approved_dt
               from rrc.completion where operator_no = $1`,
            [op]
          )
        : rrcQuery<{
            field_no: string | null;
            field_name: string | null;
            completion_type: string | null;
            cmpl_or_recmpl_date: string | null;
            approved_dt: string | null;
          }>(
            `select field_no, field_name, completion_type, cmpl_or_recmpl_date, approved_dt
               from rrc.completion where county = $1`,
            [cty!.county_no]
          ),
      // Depth is the PERMITTED total depth: the completion packet carries no
      // depth column of its own, and the permit is the operator saying how deep
      // they intend to go before anyone has drilled it.
      rrcQuery<{ yr: string; depth: number | null }>(
        op
          ? `select to_char(issued_date, 'YYYY') as yr, total_depth as depth
               from rrc.permit
              where operator_number = $1::bpchar and issued_date between $2::date and $3::date`
          : `select to_char(issued_date, 'YYYY') as yr, total_depth as depth
               from rrc.permit
              where county_code = $1 and issued_date between $2::date and $3::date`,
        [op ?? cty!.county_no, from, to]
      ),
    ]);

    const years = new Map<
      string,
      { fields: Map<string, { name: string | null; n: number }>; filings: number }
    >();
    for (const f of filings) {
      const d = mdy(f.cmpl_or_recmpl_date) ?? mdy(f.approved_dt);
      if (!d || d < from || d > to) continue;
      const yr = d.slice(0, 4);
      const slot = years.get(yr) ?? { fields: new Map(), filings: 0 };
      slot.filings += 1;
      const key = f.field_no ?? "unknown";
      const cur = slot.fields.get(key) ?? { name: f.field_name, n: 0 };
      cur.n += 1;
      slot.fields.set(key, cur);
      years.set(yr, slot);
    }

    const depthByYear = new Map<string, number[]>();
    for (const p of permits) {
      if (!p.yr || p.depth == null || p.depth <= 0) continue;
      depthByYear.set(p.yr, [...(depthByYear.get(p.yr) ?? []), p.depth]);
    }

    const allYears = [...new Set([...years.keys(), ...depthByYear.keys()])].sort();
    const byYear = allYears.map((yr) => {
      const slot = years.get(yr);
      const depths = depthByYear.get(yr) ?? [];
      const top = [...(slot?.fields ?? new Map())]
        .map(([field_no, v]) => ({ field_no, field_name: v.name, filings: v.n }))
        .sort((a, b) => b.filings - a.filings)
        .slice(0, 5);
      return {
        year: yr,
        completion_filings: slot?.filings ?? 0,
        top_fields: top,
        permits: depths.length,
        median_permit_depth_ft: median(depths),
        p10_permit_depth_ft: percentile(depths, 0.1),
        p90_permit_depth_ft: percentile(depths, 0.9),
      };
    });

    const withDepth = byYear.filter((y) => y.median_permit_depth_ft != null);
    const firstDepth = withDepth[0]?.median_permit_depth_ft ?? null;
    const lastDepth = withDepth[withDepth.length - 1]?.median_permit_depth_ft ?? null;

    return {
      ok: true as const,
      subject: op ? `operator ${op}` : `${cty!.county_name} County`,
      window: { since: from, until: to },
      by_year: byYear,
      depth_shift_ft: firstDepth != null && lastDepth != null ? lastDepth - firstDepth : null,
      notes: [
        "Two independent series, deliberately not blended: the field mix comes from completion packets (what was actually completed) and the depth from drilling permits (what was intended). A year can have one and not the other.",
        "The field on a completion is the RRC reservoir designation, which is the closest the record has to a target zone. It is administrative, so a renamed or split field moves the count without anything changing in the ground.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 48

const completionBenchmark = defineTool(
  "rrc_completion_benchmark",
  "One operator's perforated length, casing count and cement volume against the distribution of everyone completing in the same field.",
  { operator_no: z.string(), field_no: z.string(), limit: z.number().int().optional() },
  async ({ operator_no, field_no, limit }) => {
    const op = operator_no.trim();
    const field = field_no.trim();
    if (!op || !field) return fail("operator_no and field_no are both required.");
    const cap = clampInt(limit, 400, 20, 800);

    const packets = await rrcQuery<{ api_no: string; operator_no: string | null }>(
      `select distinct api_no, operator_no
         from rrc.completion
        where field_no = $1 and nullif(btrim(api_no), '') is not null
        limit $2`,
      [field, cap]
    );
    if (!packets.length) return fail(`No completion filings in field ${field}.`);

    const apis = packets.map((p) => p.api_no.trim());
    const [perfs, casing] = await Promise.all([
      // bpchar arrays, not text: rrc.wb_* keys on `character` and a text cast
      // drops the index. See offsets.ts.
      rrcQuery<{ api_number: string; perf_ft: number | null; intervals: number }>(
        `select api_number,
                sum(greatest(0, bottom_ft - top_ft))::float8 as perf_ft,
                count(*)::int                                as intervals
           from rrc.wb_perf
          where api_number = any($1::bpchar[]) and top_ft > 0
          group by api_number`,
        [apis]
      ),
      rrcQuery<{ api_number: string; strings: number; cement: number | null }>(
        `select api_number, count(*)::int as strings,
                sum(cement_amount)::float8 as cement
           from rrc.wb_casing
          where api_number = any($1::bpchar[])
          group by api_number`,
        [apis]
      ),
    ]);

    const perfBy = new Map(perfs.map((p) => [p.api_number.trim(), p]));
    const casingBy = new Map(casing.map((c) => [c.api_number.trim(), c]));
    const rows = packets.map((p) => ({
      api_number: p.api_no.trim(),
      mine: p.operator_no?.trim() === op,
      perf_ft: perfBy.get(p.api_no.trim())?.perf_ft ?? null,
      intervals: perfBy.get(p.api_no.trim())?.intervals ?? null,
      casing_strings: casingBy.get(p.api_no.trim())?.strings ?? null,
      cement_amount: casingBy.get(p.api_no.trim())?.cement ?? null,
    }));

    const mine = rows.filter((r) => r.mine);
    if (!mine.length) return fail(`Operator ${op} has no completion filings in field ${field}.`);

    const stat = (pick: (r: (typeof rows)[number]) => number | null) => {
      const all = rows.map(pick).filter((v): v is number => v != null && v > 0);
      const ours = mine.map(pick).filter((v): v is number => v != null && v > 0);
      const m = median(ours);
      return {
        ours_median: m,
        ours_n: ours.length,
        field_median: median(all),
        field_p10: percentile(all, 0.1),
        field_p90: percentile(all, 0.9),
        field_n: all.length,
        // Where our median sits in the field's own distribution, which is the
        // only comparison that survives a field with three wells.
        percentile_in_field:
          m == null || !all.length
            ? null
            : all.filter((v) => v <= m).length / all.length,
      };
    };

    return {
      ok: true as const,
      operator_no: op,
      field_no: field,
      wells_in_field: rows.length,
      our_wells: mine.length,
      perforated_length_ft: stat((r) => r.perf_ft),
      perforated_intervals: stat((r) => r.intervals),
      casing_strings: stat((r) => r.casing_strings),
      cement_amount: stat((r) => r.cement_amount),
      shot_density: null,
      truncated: packets.length >= cap,
      notes: [
        "SHOT DENSITY IS NOT IN THE RECORD. rrc.wb_perf carries a top and a bottom depth per interval and no shot count, so shots per foot cannot be computed here at any accuracy. Perforated length and interval count are what the file supports.",
        "Perforated length is the union of intervals across EVERY filing on the hole, so a recompleted well reads longer than its current open interval.",
        "Cement amount comes off the casing record with its own unit column (sacks or cubic feet) and is summed raw. Compare within this result, not against a number from elsewhere.",
        "The peer set is everyone who filed a completion in this field, capped and unweighted. A field spanning several benches mixes them.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 49

const newEntrant = defineTool(
  "rrc_new_entrant",
  "Operator numbers whose first permit or first completion in a county or field falls inside a window.",
  {
    county: z.string().optional(),
    field_no: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async ({ county, field_no, since, until, limit }) => {
    const cty = county?.trim() ? resolveCounty(county.trim()) : null;
    const field = field_no?.trim();
    if (!cty && !field) {
      return fail(
        county?.trim()
          ? `Not a Texas county: ${county}.`
          : "county or field_no is required. A statewide scan is refused."
      );
    }
    const from = since?.trim() || shiftMonths(today(), -24);
    const to = until?.trim() || today();
    const cap = clampInt(limit, 100, 1, 300);

    const firsts = cty
      ? (
          await rrcQuery<{ operator_number: string; first_seen: string; in_window: number }>(
            `select operator_number,
                    to_char(min(issued_date), 'YYYY-MM-DD') as first_seen,
                    count(*) filter (where issued_date between $2::date and $3::date)::int
                      as in_window
               from rrc.permit
              where county_code = $1 and operator_number is not null
              group by operator_number`,
            [cty.county_no, from, to]
          )
        ).map((r) => ({ ...r, operator_number: r.operator_number.trim(), basis: "permit" as const }))
      : (
          await rrcQuery<{ operator_no: string; first_seen: string | null; in_window: number }>(
            `select operator_no,
                    to_char(min(to_date(nullif(approved_dt,''), 'MM/DD/YYYY')), 'YYYY-MM-DD')
                      as first_seen,
                    count(*) filter (
                      where to_date(nullif(approved_dt,''), 'MM/DD/YYYY')
                            between $2::date and $3::date)::int as in_window
               from rrc.completion
              where field_no = $1
                and nullif(btrim(operator_no), '') is not null
                and approved_dt ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
              group by operator_no`,
            [field, from, to]
          )
        ).map((r) => ({
          operator_number: r.operator_no.trim(),
          first_seen: r.first_seen ?? "",
          in_window: r.in_window,
          basis: "completion" as const,
        }));

    const entrants = firsts
      .filter((r) => r.first_seen && r.first_seen >= from && r.first_seen <= to)
      .sort((a, b) => (a.first_seen < b.first_seen ? 1 : -1))
      .slice(0, cap);
    if (!entrants.length) {
      return {
        ok: true as const,
        area: cty ? `${cty.county_name} County` : `field ${field}`,
        window: { since: from, until: to },
        entrants: [],
        incumbents: firsts.length,
        truncated: false,
        notes: [NAME_AS_FILED],
      };
    }

    const details = await rrcQuery<OperatorRow>(
      `select operator_number, operator_name, p5_status,
              to_char(org_date, 'YYYY-MM-DD') as org_date
         from rrc.operators where operator_number = any($1::bpchar[])`,
      [entrants.map((e) => e.operator_number)]
    );
    const byNo = new Map(details.map((d) => [d.operator_number.trim(), d]));

    return {
      ok: true as const,
      area: cty ? `${cty.county_name} County` : `field ${field}`,
      window: { since: from, until: to },
      basis: cty ? "first approved permit in the county" : "first completion filed in the field",
      incumbents: firsts.length,
      entrants: entrants.map((e) => ({
        operator_no: e.operator_number,
        operator_name: byNo.get(e.operator_number)?.operator_name ?? null,
        p5_status: byNo.get(e.operator_number)?.p5_status ?? null,
        org_date: byNo.get(e.operator_number)?.org_date ?? null,
        first_seen: e.first_seen,
        filings_in_window: e.in_window,
      })),
      truncated: entrants.length >= cap,
      notes: [
        "First seen is the earliest filing THE MIRROR HOLDS for that operator in this area, so an operator active before the file starts reads as an entrant. Check org_date beside it: an operator registered decades ago is a move, not a new company.",
        "A new operator number is not always a new party. A rename, a restructure or an affiliate takes a new P-5 number for the same people: run rrc_entity_resolve on anything that matters.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 50

/** An operator's own disposal fleet, shared by 50 and 66. */
async function ownDisposal(operatorNo: string) {
  const [rollup, wells] = await Promise.all([
    getOperatorDisposal(operatorNo),
    findDisposal({ operatorNo, limit: 200 }),
  ]);
  return { rollup, wells };
}

const waterStrategy = defineTool(
  "rrc_water_strategy",
  "Whether an operator holds its own disposal or leans on third-party commercial wells, with utilisation of what it holds.",
  { operator_no: z.string(), radius_mi: z.number().optional() },
  async ({ operator_no, radius_mi }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const radius = Math.min(100, Math.max(1, radius_mi ?? 25));
    const { rollup, wells } = await ownDisposal(op);

    const placed = wells.filter((w) => w.lat != null && w.lon != null);
    const centre = placed.length
      ? {
          lat: sum(placed.map((w) => w.lat)) / placed.length,
          lon: sum(placed.map((w) => w.lon)) / placed.length,
        }
      : await (async () => {
          const fleet = (await findWells({ operatorNo: op, limit: 200 })).filter(
            (w) => w.lat != null && w.lon != null
          );
          return fleet.length
            ? {
                lat: sum(fleet.map((w) => w.lat)) / fleet.length,
                lon: sum(fleet.map((w) => w.lon)) / fleet.length,
              }
            : null;
        })();

    const nearby = centre
      ? await findDisposal({
          lat: centre.lat,
          lon: centre.lon,
          radiusMi: radius,
          commercialOnly: true,
          limit: 50,
        })
      : [];
    const thirdParty = nearby.filter((w) => w.operator_no?.trim() !== op);

    const ownPermitted = sum(wells.map((w) => w.max_bbl_per_day));
    const ownUsed = sum(wells.map((w) => w.recentBblPerDay));
    const commercialPermitted = sum(thirdParty.map((w) => w.max_bbl_per_day));

    return {
      ok: true as const,
      operator_no: op,
      reported_through: rollup.reportedThrough,
      own: {
        wells: rollup.wells,
        commercial_wells: rollup.commercialWells,
        permitted_bbl_per_day: rollup.permittedBblPerDay,
        reported_bbl_per_day: ownUsed || null,
        injected_bbl_12m: rollup.injectedBbl12m,
        utilisation: ownPermitted > 0 ? ownUsed / ownPermitted : null,
        wells_detail: wells.map((w) => ({
          uic_no: w.uic_no,
          api_number: w.api_number,
          lease_name: w.lease_name,
          is_commercial: w.is_commercial,
          max_bbl_per_day: w.max_bbl_per_day,
          recent_bbl_per_day: w.recentBblPerDay,
          utilisation: w.utilisation,
        })),
      },
      third_party_nearby: {
        centre,
        radius_mi: radius,
        wells: thirdParty.length,
        permitted_bbl_per_day: commercialPermitted,
        headroom_bbl_per_day:
          commercialPermitted - sum(thirdParty.map((w) => w.recentBblPerDay)),
        operators: [...new Set(thirdParty.map((w) => w.operator_name).filter(Boolean))],
      },
      self_sufficiency:
        ownPermitted + commercialPermitted > 0
          ? ownPermitted / (ownPermitted + commercialPermitted)
          : null,
      notes: [
        "THE RECORD DOES NOT SAY WHERE PRODUCED WATER GOES. There is no manifest, no ticket and no volume attributed to a hauler. What it shows is which permits this operator holds and what they report injecting; water not accounted for there went somewhere the file does not name.",
        "Permitted volume is a legal ceiling, not an offer. Whether a commercial well will take your water, and at what price, is commercial and the public record says nothing about it.",
        `H-10 filing runs about a year behind. Volumes here are measured through ${rollup.reportedThrough}; a thin recent tail is late filing, not a well that stopped.`,
        "The centre is the mean position of the operator's own wells, which is not a facility location. For a real haul distance, run the radius from the lease.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 51

const purchaserMap = defineTool(
  "rrc_purchaser_map",
  "Who takes an operator's oil and gas today and every P-4 filing that changed a purchaser or gatherer.",
  { operator_no: z.string(), limit: z.number().int().optional() },
  async ({ operator_no, limit }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const cap = clampInt(limit, 100, 1, 300);

    const leases = await rrcQuery<{
      oil_gas_code: string;
      district_no: string;
      lease_no: string;
      lease_name: string | null;
    }>(
      `select oil_gas_code, district_no, lease_no, lease_name
         from rrc.lease where operator_no = $1::bpchar limit $2`,
      [op, cap]
    );
    if (!leases.length) return fail(`No leases on record for operator ${op}.`);

    // The lease key drives both reads through p4_gath_lease_idx and
    // p4_filing_lease_idx. Filtering p4_filing on operator_no instead is a seq
    // scan of 3.8M rows, and it answers a different question anyway: the P-4 is
    // filed against a LEASE, and the operator on it may since have changed.
    const keys = leases.map((l) => `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`);
    const codes = leases.map((l) => l.oil_gas_code);
    const districts = leases.map((l) => l.district_no);
    const numbers = leases.map((l) => l.lease_no);

    const [conns, filings] = await Promise.all([
      rrcQuery<{
        oil_gas_code: string;
        district: string;
        lease_no: string;
        product_code: string | null;
        type_code: string | null;
        gpn_no: string | null;
        operator_name: string | null;
        effective_date: string | null;
      }>(
        `with keys as (select * from unnest($1::text[], $2::text[], $3::text[]) as t(a, b, c))
         select distinct on (g.oil_gas_code, g.district, g.lease_no, g.product_code, g.type_code)
                g.oil_gas_code, g.district, g.lease_no, g.product_code, g.type_code,
                g.gpn_no, o.operator_name,
                to_char(g.effective_date, 'YYYY-MM-DD') as effective_date
           from rrc.p4_gatherer g
           join keys k on g.oil_gas_code = k.a and g.district = k.b and g.lease_no = k.c
           left join rrc.operators o on o.operator_number = g.gpn_no
          where g.gpn_no is not null and g.gpn_no <> '000000'
          order by g.oil_gas_code, g.district, g.lease_no, g.product_code, g.type_code,
                   g.effective_date desc nulls last`,
        [codes, districts, numbers]
      ),
      rrcQuery<{
        oil_gas_code: string;
        district: string;
        lease_no: string;
        effective_date: string | null;
        chg_purchaser: string | null;
        chg_gatherer: string | null;
        chg_purch_system: string | null;
        chg_operator: string | null;
      }>(
        `with keys as (select * from unnest($1::text[], $2::text[], $3::text[]) as t(a, b, c))
         select f.oil_gas_code, f.district, f.lease_no,
                to_char(f.effective_date, 'YYYY-MM-DD') as effective_date,
                f.chg_purchaser, f.chg_gatherer, f.chg_purch_system, f.chg_operator
           from rrc.p4_filing f
           join keys k on f.oil_gas_code = k.a and f.district = k.b and f.lease_no = k.c
          where f.record_type <> 'D'
            and (f.chg_purchaser = 'Y' or f.chg_gatherer = 'Y' or f.chg_purch_system = 'Y')
          order by f.effective_date desc nulls last
          limit 400`,
        [codes, districts, numbers]
      ),
    ]);

    const nameOf = new Map(
      leases.map((l) => [`${l.oil_gas_code}/${l.district_no}/${l.lease_no}`, l.lease_name])
    );
    const key = (r: { oil_gas_code: string; district: string; lease_no: string }) =>
      `${r.oil_gas_code}/${r.district}/${r.lease_no}`;

    const counterparties = new Map<
      string,
      { gpn_no: string; name: string | null; role: string; products: Set<string>; leases: Set<string> }
    >();
    for (const c of conns) {
      const role = P4_ROLE[(c.type_code ?? "").trim()] ?? c.type_code ?? "unknown";
      const id = `${c.gpn_no?.trim()}|${role}`;
      const slot = counterparties.get(id) ?? {
        gpn_no: c.gpn_no?.trim() ?? "",
        name: c.operator_name,
        role,
        products: new Set<string>(),
        leases: new Set<string>(),
      };
      slot.products.add(P4_PRODUCT[(c.product_code ?? "").trim()] ?? c.product_code ?? "unknown");
      slot.leases.add(key(c));
      counterparties.set(id, slot);
    }

    return {
      ok: true as const,
      operator_no: op,
      leases: leases.length,
      counterparties: [...counterparties.values()]
        .map((c) => ({
          gpn_no: c.gpn_no,
          name: c.name,
          role: c.role,
          products: [...c.products],
          leases: c.leases.size,
          share_of_leases: c.leases.size / leases.length,
        }))
        .sort((a, b) => b.leases - a.leases),
      switches: filings.map((f) => ({
        lease: key(f),
        lease_name: nameOf.get(key(f)) ?? null,
        effective_date: f.effective_date,
        changed: [
          f.chg_purchaser === "Y" ? "purchaser" : null,
          f.chg_gatherer === "Y" ? "gatherer" : null,
          f.chg_purch_system === "Y" ? "purchaser system" : null,
          f.chg_operator === "Y" ? "operator" : null,
        ].filter(Boolean),
      })),
      lease_keys: keys,
      truncated: leases.length >= cap,
      notes: [
        "A P-4 names who is AUTHORISED to move the product, not who paid what. There are no prices, no deducts and no volumes on this form.",
        "The connection shown per product is the one with the latest effective date. The tape's own 'current' flag only ever means current PURCHASER, and only for gas, so it is not used here.",
        "Leases are this operator's CURRENT leases from rrc.lease. A lease they have since sold carries its P-4 history under the new operator.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 52

/** Operators holding leases in one field, biggest holder first. */
async function fieldOperators(fieldNo: string, cap: number) {
  return rrcQuery<{ operator_no: string; leases: number }>(
    `select operator_no, count(*)::int as leases
       from rrc.lease
      where field_no = $1 and nullif(btrim(operator_no), '') is not null
      group by operator_no
      order by leases desc
      limit $2`,
    [fieldNo, cap]
  );
}

interface FieldMonth {
  operator_no: string;
  cycle: string;
  oil: number;
  gas: number;
  oil_allow: number | null;
}

/** One grouped read of every peer's months in one field. */
async function fieldMonths(operators: string[], fieldNo: string, months: number) {
  return rrcQuery<FieldMonth>(
    `select operator_no, to_char(cycle, 'YYYY-MM') as cycle,
            sum(coalesce(oil_prod_vol,0))::bigint as oil,
            sum(coalesce(gas_prod_vol,0))::bigint as gas,
            sum(oil_allow)::bigint                as oil_allow
       from rrc.lease_production
      where operator_no = any($1::bpchar[])
        and field_no = $2
        and cycle > (date_trunc('month', now()) - ($3 || ' months')::interval)
      group by 1, 2`,
    [operators, fieldNo, String(Math.max(1, Math.floor(months)))]
  );
}

/** Producing months, gaps and the longest run of zeros, over reported cycles. */
function uptimeOf(rows: { cycle: string; oil: number; gas: number }[], edge: string) {
  const months = rows
    .filter((r) => r.cycle <= edge)
    .sort((a, b) => (a.cycle < b.cycle ? -1 : 1));
  const producing = months.filter((m) => m.oil > 0 || m.gas > 0);
  let stops = 0;
  let run = 0;
  let longest = 0;
  for (const m of months) {
    const on = m.oil > 0 || m.gas > 0;
    if (!on) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      if (run > 0) stops += 1;
      run = 0;
    }
  }
  return {
    months: months.length,
    producing_months: producing.length,
    uptime: months.length ? producing.length / months.length : null,
    // Only closed gaps count as a stop: a well down at the reporting edge has
    // not come back yet, and calling that an intermittency event would count a
    // shut-in as a restart that never happened.
    stops,
    longest_gap_months: longest,
    first_cycle: months[0]?.cycle ?? null,
    last_producing_cycle: producing[producing.length - 1]?.cycle ?? null,
  };
}

const peerUptime = defineTool(
  "rrc_peer_uptime",
  "Producing months, intermittency and longest downtime gap for an operator against peers holding leases in the same field.",
  {
    operator_no: z.string(),
    field_no: z.string(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async ({ operator_no, field_no, months, limit }) => {
    const op = operator_no.trim();
    const field = field_no.trim();
    if (!op || !field) return fail("operator_no and field_no are both required.");
    const window = clampInt(months, 36, 6, 240);
    const cap = clampInt(limit, 25, 2, 50);

    const peers = await fieldOperators(field, cap);
    if (!peers.length) return fail(`No leases on record in field ${field}.`);
    const numbers = [...new Set([op, ...peers.map((p) => p.operator_no.trim())])];

    const [{ reported }, rows, names] = await Promise.all([
      getCycleEdge(),
      fieldMonths(numbers, field, window),
      rrcQuery<OperatorRow>(
        `select operator_number, operator_name, p5_status
           from rrc.operators where operator_number = any($1::bpchar[])`,
        [numbers]
      ),
    ]);
    const nameOf = new Map(names.map((n) => [n.operator_number.trim(), n.operator_name]));

    const ranked = numbers
      .map((no) => {
        const mine = rows.filter((r) => r.operator_no.trim() === no);
        const stats = uptimeOf(mine, reported);
        return {
          operator_no: no,
          operator_name: nameOf.get(no) ?? null,
          is_subject: no === op,
          ...stats,
          oil_bbl: sum(mine.filter((m) => m.cycle <= reported).map((m) => m.oil)),
          gas_mcf: sum(mine.filter((m) => m.cycle <= reported).map((m) => m.gas)),
        };
      })
      .filter((r) => r.months > 0)
      .sort((a, b) => (b.uptime ?? 0) - (a.uptime ?? 0));

    const subject = ranked.find((r) => r.is_subject) ?? null;
    return {
      ok: true as const,
      operator_no: op,
      field_no: field,
      window_months: window,
      reported_through: reported,
      subject,
      subject_rank: subject ? ranked.indexOf(subject) + 1 : null,
      peers: ranked.length,
      peer_median_uptime: median(
        ranked.filter((r) => !r.is_subject).map((r) => r.uptime ?? 0)
      ),
      ranked,
      notes: [
        lagNote(reported),
        "Uptime is the share of cycles in the window with any reported oil or gas ON THIS FIELD'S LEASES, so an operator producing elsewhere still reads as down here.",
        "A reported zero can be a lease off schedule, severed, or simply not filed. This measures FILING behaviour and production together, because the record does not separate them.",
        "Peers are whoever holds leases in the same field. Field is administrative and can span more than one bench, so a like-for-like rock comparison needs a formation filter the file does not carry.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 53

const areaWatch = defineTool(
  "rrc_area_watch",
  "One diff of everything filed in a county since a date: permits, pending applications, completions, plugs and new injection permits.",
  { county: z.string(), since: z.string(), limit: z.number().int().optional() },
  async ({ county, since, limit }) => {
    const cty = resolveCounty(county.trim());
    if (!cty) return fail(`Not a Texas county: ${county}.`);
    const from = since.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail("since must be a date, YYYY-MM-DD.");
    const cap = clampInt(limit, 100, 1, 300);

    // County wells key on the API's first three digits, which IS the county
    // code. That turns two of these reads into a range scan on the api index
    // instead of a filter with nothing to lean on.
    const apiLo = `${cty.county_no}00000`;
    const apiHi = `${cty.county_no}99999`;

    const [permits, pending, completions, plugs, injection] = await Promise.all([
      listPermits({ county: cty.county_no, since: from, limit: cap }),
      getPendingQueue(2000),
      rrcQuery<{
        api_no: string;
        operator_no: string | null;
        lease_name: string | null;
        well_no: string | null;
        field_name: string | null;
        completion_type: string | null;
        approved_dt: string | null;
        cmpl_or_recmpl_date: string | null;
      }>(
        `select api_no, operator_no, lease_name, well_no, field_name,
                completion_type, approved_dt, cmpl_or_recmpl_date
           from rrc.completion
          where county = $1
            and approved_dt ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
            and to_date(approved_dt, 'MM/DD/YYYY') >= $2::date
          limit $3`,
        [cty.county_no, from, cap]
      ),
      rrcQuery<{
        api_number: string;
        lease_name: string | null;
        well_no: string | null;
        operator_name: string | null;
        plug_date: string | null;
      }>(
        `select api_number, lease_name, well_no, operator_name, plug_date
           from rrc.wellbore
          where api_number between $1 and $2
            and nullif(btrim(plug_date), '') is not null
            and btrim(plug_date) >= $3
          limit $4`,
        [apiLo, apiHi, from.replace(/-/g, ""), cap]
      ),
      rrcQuery<{
        uic_no: string;
        api_number: string | null;
        operator_no: string | null;
        lease_name: string | null;
        inj_type: string | null;
        is_commercial: boolean | null;
        approved_date: string | null;
      }>(
        `select uic_no, api_number, operator_no, lease_name, inj_type, is_commercial,
                to_char(approved_date, 'YYYY-MM-DD') as approved_date
           from rrc.uic_permit
          where api_number between $1 and $2 and approved_date >= $3::date
          limit $4`,
        [apiLo, apiHi, from, cap]
      ),
    ]);

    const queue = pending.filter((p) => p.county_name === cty.county_name);

    return {
      ok: true as const,
      county: cty.county_name,
      county_no: cty.county_no,
      since: from,
      permits_issued: permits.map((p) => ({
        permit_number: p.permit_number,
        issued_date: p.issued_date,
        operator_no: p.operator_number,
        operator_name: p.operator_name,
        lease_name: p.lease_name,
        well_number: p.well_number,
        total_depth: p.total_depth,
      })),
      applications_pending: queue.map((p) => ({
        universal_doc_no: p.universal_doc_no,
        submit_date: p.submit_date,
        days_pending: p.days_pending,
        operator_no: p.operator_number,
        operator_name: p.operator_name,
        lease_name: p.lease_name,
        purpose: p.filing_purpose,
        surface_lat: p.surface_lat,
        surface_lon: p.surface_lon,
      })),
      completions: completions.map((c) => ({
        api_number: c.api_no,
        approved_date: mdy(c.approved_dt),
        completion_date: mdy(c.cmpl_or_recmpl_date),
        operator_no: c.operator_no?.trim() ?? null,
        lease_name: c.lease_name,
        well_no: c.well_no,
        field_name: c.field_name,
        completion_type: COMPLETION_TYPE[(c.completion_type ?? "").trim()] ?? c.completion_type,
      })),
      plugs: plugs.map((p) => ({
        api_number: p.api_number.trim(),
        plug_date: ymd(p.plug_date),
        lease_name: p.lease_name,
        well_no: p.well_no,
        operator_name: p.operator_name,
      })),
      injection_permits: injection.map((i) => ({
        uic_no: i.uic_no.trim(),
        api_number: i.api_number?.trim() ?? null,
        approved_date: i.approved_date,
        operator_no: i.operator_no?.trim() ?? null,
        lease_name: i.lease_name,
        inj_type: i.inj_type,
        is_commercial: i.is_commercial,
      })),
      counts: {
        permits_issued: permits.length,
        applications_pending: queue.length,
        completions: completions.length,
        plugs: plugs.length,
        injection_permits: injection.length,
      },
      truncated:
        permits.length >= cap ||
        completions.length >= cap ||
        plugs.length >= cap ||
        injection.length >= cap,
      notes: [
        "COUNTY GRAIN, not a radius. rrc.permit has no coordinates, so a permit can only be placed in a county, and a radius diff would silently drop every permit outside the pending window.",
        "Operator changes are NOT here. A P-4 is filed against a lease and the record gives a lease no county, so an operator change can only be pulled per operator: see rrc_purchaser_map.",
        "The pending queue is what has not yet reached rrc.permit and is capped at 180 days by the view. An application denied or withdrawn simply stops appearing, because the feed publishes arrivals and never removals.",
        "Completion and plug dates are the dates on the filing. Both are filed after the work.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 54

const permitForecast = defineTool(
  "rrc_permit_forecast",
  "The county's own permit-to-completion lag, applied to permits that are issued and unbuilt, to date when they should reach the production file.",
  { county: z.string(), since: z.string().optional(), limit: z.number().int().optional() },
  async ({ county, since, limit }) => {
    const cty = resolveCounty(county.trim());
    if (!cty) return fail(`Not a Texas county: ${county}.`);
    const cap = clampInt(limit, 200, 10, 500);
    const from = since?.trim() || shiftMonths(today(), -60);

    const holes = await rrcQuery<{
      api_number: string;
      recent_permit: string | null;
      completion_date: string | null;
    }>(
      `select api_number, recent_permit, completion_date
         from rrc.wellbore
        where api_number between $1 and $2
          and nullif(btrim(recent_permit), '') is not null
          and nullif(btrim(completion_date), '') is not null`,
      [`${cty.county_no}00000`, `${cty.county_no}99999`]
    );

    // rrc.permit keys the number zero-padded to seven; the wellbore carries the
    // bare six. Joining without the pad matches nothing at all, silently.
    const padded = [...new Set(holes.map((h) => h.recent_permit!.trim().padStart(7, "0")))];
    const issued = padded.length
      ? await rrcQuery<{ permit_number: string; issued_date: string | null }>(
          `select permit_number, to_char(min(issued_date), 'YYYY-MM-DD') as issued_date
             from rrc.permit
            where permit_number = any($1::text[])
            group by permit_number`,
          [padded]
        )
      : [];
    const issuedBy = new Map(issued.map((i) => [i.permit_number.trim(), i.issued_date]));

    const lags: number[] = [];
    for (const h of holes) {
      const done = ymd(h.completion_date);
      const start = issuedBy.get(h.recent_permit!.trim().padStart(7, "0")) ?? null;
      if (!done || !start || done < start) continue;
      const days = daysBetween(start, done);
      // A hole completed more than five years after its permit is a re-entry or
      // a mismatched pairing, not a drilling cycle. Trimmed rather than left to
      // drag the median.
      if (days <= 1825) lags.push(days);
    }

    const [outstanding, pending] = await Promise.all([
      listPermits({ county: cty.county_no, since: from, limit: cap }),
      getPendingQueue(2000),
    ]);
    const built = new Set(
      holes.map((h) => h.recent_permit!.trim().padStart(7, "0"))
    );
    const waiting = outstanding.filter(
      (p) => p.permit_number && !built.has(p.permit_number.trim())
    );

    const p50 = median(lags);
    const p90 = percentile(lags, 0.9);
    const queue = pending.filter((p) => p.county_name === cty.county_name);

    return {
      ok: true as const,
      county: cty.county_name,
      lag_sample: lags.length,
      permit_to_completion_days: {
        p10: percentile(lags, 0.1),
        median: p50,
        p90,
      },
      permits_outstanding: waiting.length,
      applications_pending: queue.length,
      projected: p50 == null
        ? []
        : waiting
            .filter((p) => p.issued_date)
            .map((p) => ({
              permit_number: p.permit_number,
              operator_no: p.operator_number,
              operator_name: p.operator_name,
              lease_name: p.lease_name,
              issued_date: p.issued_date,
              expires_date: p.expires_date,
              projected_completion: shiftMonths(p.issued_date!, Math.round(p50 / 30.4)),
              projected_late: shiftMonths(p.issued_date!, Math.round((p90 ?? p50) / 30.4)),
            }))
            .sort((a, b) =>
              a.projected_completion < b.projected_completion ? -1 : 1
            )
            .slice(0, cap),
      truncated: outstanding.length >= cap,
      notes: [
        "The lag measured is PERMIT ISSUE TO COMPLETION DATE, not to first production. First production follows the completion by a cycle or two and is then published about three months late, so add roughly four months to reach the production file.",
        "Pairing is through rrc.wellbore.recent_permit, which is the MOST RECENT permit on the hole. On a re-entered well that pairs the old hole with a new permit, which is why lags over five years are dropped.",
        "An outstanding permit is one no wellbore in this county carries. A permit runs two years and most of the ones here are simply not drilled yet; a permit is an option, not a commitment.",
        NO_PERMIT_COORDS,
      ],
    };
  }
);

// ------------------------------------------------------------------ 55

const entityResolve = defineTool(
  "rrc_entity_resolve",
  "Operators that may be the same corporate family as this one, scored by shared officer name, mailing address, phone and ZIP.",
  { operator_no: z.string(), limit: z.number().int().optional() },
  async ({ operator_no, limit }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const cap = clampInt(limit, 50, 1, 200);

    const me = await operatorRow(op);
    if (!me) return fail(`No operator ${op}.`);
    const mine = await officersOf(op);
    const names = [...new Set(mine.map((o) => o.officer_name))];
    const surnames = [...new Set(names.map(surnameOf).filter(Boolean))];

    const [shared, spread, contact, bySurname] = await Promise.all([
      names.length
        ? rrcQuery<{ officer_name: string; operator_number: string }>(
            `select distinct officer_name, operator_number
               from rrc.operator_officers
              where officer_name = any($1::text[]) and operator_number <> $2::bpchar
              limit 500`,
            [names, op]
          )
        : [],
      nameSpread(names),
      rrcQuery<OperatorRow>(
        `select operator_number, operator_name, p5_status, addr1, city1, state1, zip1,
                phone1, to_char(org_date, 'YYYY-MM-DD') as org_date
           from rrc.operators
          where operator_number <> $1::bpchar
            and (($2 <> '' and upper(regexp_replace(coalesce(addr1,''), '[^A-Za-z0-9]', '', 'g')) = $2)
              or ($3 <> '' and regexp_replace(coalesce(phone1,''), '[^0-9]', '', 'g') = $3)
              or ($4 <> '' and left(regexp_replace(coalesce(zip1,''), '[^0-9]', '', 'g'), 5) = $4))
          limit 300`,
        [op, addrKey(me.addr1), phoneKey(me.phone1), zipKey(me.zip1)]
      ),
      surnames.length
        ? rrcQuery<{ officer_name: string; operator_number: string }>(
            `select distinct officer_name, operator_number
               from rrc.operator_officers
              where operator_number <> $2::bpchar
                and officer_name ilike any($1::text[])
              limit 500`,
            [surnames.map((s) => `${s},%`), op]
          )
        : [],
    ]);

    const links = new Map<string, Omit<Link, "confidence">>();
    const slot = (no: string) =>
      links.get(no) ?? { operator_number: no, operator_name: null, p5_status: null, signals: [] };

    for (const s of shared) {
      const no = s.operator_number.trim();
      const on = spread.get(s.officer_name) ?? 1;
      const common = on > COMMON_NAME_OPERATORS;
      const l = slot(no);
      l.signals.push({
        signal: common ? "officer name, common" : "officer name",
        weight: common ? SIGNAL_WEIGHT.officer_common : SIGNAL_WEIGHT.officer,
        evidence: `${s.officer_name} is filed on ${on} operators`,
      });
      links.set(no, l);
    }

    for (const c of contact) {
      const no = c.operator_number.trim();
      const l = slot(no);
      l.operator_name = c.operator_name;
      l.p5_status = c.p5_status;
      if (addrKey(me.addr1) && addrKey(c.addr1) === addrKey(me.addr1)) {
        l.signals.push({
          signal: "mailing address",
          weight: SIGNAL_WEIGHT.address,
          evidence: `${c.addr1 ?? ""} ${c.city1 ?? ""} ${c.state1 ?? ""}`.trim(),
        });
      } else if (zipKey(me.zip1) && zipKey(c.zip1) === zipKey(me.zip1)) {
        l.signals.push({
          signal: "ZIP only",
          weight: SIGNAL_WEIGHT.zip,
          evidence: `ZIP ${zipKey(c.zip1)}`,
        });
      }
      if (phoneKey(me.phone1) && phoneKey(c.phone1) === phoneKey(me.phone1)) {
        l.signals.push({
          signal: "phone",
          weight: SIGNAL_WEIGHT.phone,
          evidence: `phone ${c.phone1 ?? ""}`.trim(),
        });
      }
      links.set(no, l);
    }

    for (const s of bySurname) {
      const no = s.operator_number.trim();
      if (names.includes(s.officer_name)) continue; // already a full-name link
      const l = slot(no);
      l.signals.push({
        signal: "surname only",
        weight: SIGNAL_WEIGHT.surname,
        evidence: `${s.officer_name} shares the surname ${surnameOf(s.officer_name)}`,
      });
      links.set(no, l);
    }

    const missing = [...links.keys()].filter((no) => !links.get(no)!.operator_name);
    if (missing.length) {
      const rows = await rrcQuery<OperatorRow>(
        `select operator_number, operator_name, p5_status
           from rrc.operators where operator_number = any($1::bpchar[])`,
        [missing]
      );
      for (const r of rows) {
        const l = links.get(r.operator_number.trim());
        if (l) {
          l.operator_name = r.operator_name;
          l.p5_status = r.p5_status;
        }
      }
    }

    const scored = [...links.values()]
      .map(scoreLink)
      .sort((a, b) => b.confidence - a.confidence);

    return {
      ok: true as const,
      operator_no: op,
      operator_name: me.operator_name,
      p5_status: me.p5_status,
      officers: mine.map((o) => ({
        officer_name: o.officer_name,
        officer_title: o.officer_title,
        operators_with_this_name: spread.get(o.officer_name) ?? 1,
      })),
      candidates: scored.slice(0, cap),
      weights: SIGNAL_WEIGHT,
      common_name_threshold: COMMON_NAME_OPERATORS,
      truncated: scored.length > cap,
      notes: [
        NAME_AS_FILED,
        `Confidence is the sum of the signals listed on each link, capped at ${MAX_CONFIDENCE}. The weights are ASSERTED from what each signal can mean, not fitted to any outcome: an officer name filed on more than ${COMMON_NAME_OPERATORS} operators is discounted because at that point it is a filing agent or a common name.`,
        "A shared mailing address is often a registered agent or an accountant. It links the paperwork, not the ownership.",
        OBSERVED_FACTS,
      ],
    };
  }
);

// ------------------------------------------------------------------ 56

const MAX_PATH_DEPTH = 6;
/** Operators expanded per person. A filing agent would otherwise explode. */
const PATH_FANOUT = 25;
/** Total nodes expanded before the search gives up. */
const PATH_BUDGET = 300;

const pathBetween = defineTool(
  "rrc_path_between",
  "The shortest chain of shared officers linking two operators, with every hop's evidence and a depth cap.",
  {
    from_operator_no: z.string(),
    to_operator_no: z.string(),
    max_depth: z.number().int().optional(),
  },
  async ({ from_operator_no, to_operator_no, max_depth }) => {
    const from = from_operator_no.trim();
    const to = to_operator_no.trim();
    if (!from || !to) return fail("from_operator_no and to_operator_no are both required.");
    if (from === to) return fail("from and to are the same operator.");
    const depth = clampInt(max_depth, 4, 1, MAX_PATH_DEPTH);

    interface Step {
      operator_no: string;
      via_officer: string | null;
      officer_on_operators: number | null;
    }
    const start: Step = { operator_no: from, via_officer: null, officer_on_operators: null };
    let frontier: Step[][] = [[start]];
    const visited = new Set([from]);
    let expanded = 0;
    let hit: Step[] | null = null;

    // Breadth first, so the first path found is a shortest one. The visited set
    // is what makes a cyclic graph terminate: an operator is expanded once and
    // never re-entered, so A -> B -> C -> A closes instead of looping.
    for (let d = 0; d < depth && !hit && frontier.length; d += 1) {
      const next: Step[][] = [];
      for (const path of frontier) {
        if (expanded >= PATH_BUDGET) break;
        expanded += 1;
        const head = path[path.length - 1].operator_no;
        const officers = await officersOf(head);
        const names = [...new Set(officers.map((o) => o.officer_name))];
        if (!names.length) continue;
        const [neighbours, spread] = await Promise.all([
          rrcQuery<{ officer_name: string; operator_number: string }>(
            `select distinct officer_name, operator_number
               from rrc.operator_officers
              where officer_name = any($1::text[]) and operator_number <> $2::bpchar
              limit $3`,
            [names, head, PATH_FANOUT * 4]
          ),
          nameSpread(names),
        ]);
        const seen = new Set<string>();
        for (const n of neighbours) {
          const no = n.operator_number.trim();
          if (seen.size >= PATH_FANOUT && no !== to) continue;
          seen.add(no);
          if (no !== to && visited.has(no)) continue;
          const step: Step = {
            operator_no: no,
            via_officer: n.officer_name,
            officer_on_operators: spread.get(n.officer_name) ?? 1,
          };
          if (no === to) {
            hit = [...path, step];
            break;
          }
          visited.add(no);
          next.push([...path, step]);
        }
        if (hit) break;
      }
      frontier = next;
    }

    if (!hit) {
      return {
        ok: true as const,
        from,
        to,
        found: false,
        max_depth: depth,
        nodes_expanded: expanded,
        budget_exhausted: expanded >= PATH_BUDGET,
        notes: [
          `No chain of shared officer names within ${depth} hops. That is not proof of no relationship: the record only links companies through the names on their P-5s.`,
          NAME_AS_FILED,
        ],
      };
    }

    const numbers = hit.map((s) => s.operator_no);
    const rows = await rrcQuery<OperatorRow>(
      `select operator_number, operator_name, p5_status
         from rrc.operators where operator_number = any($1::bpchar[])`,
      [numbers]
    );
    const nameOf = new Map(rows.map((r) => [r.operator_number.trim(), r.operator_name]));

    // Each hop is worth less when the name that made it is on many operators.
    const hops = hit.slice(1).map((s) => ({
      operator_no: s.operator_no,
      operator_name: nameOf.get(s.operator_no) ?? null,
      via_officer: s.via_officer,
      officer_on_operators: s.officer_on_operators,
      hop_confidence:
        (s.officer_on_operators ?? 1) > COMMON_NAME_OPERATORS
          ? SIGNAL_WEIGHT.officer_common
          : SIGNAL_WEIGHT.officer,
    }));

    return {
      ok: true as const,
      from,
      to,
      found: true,
      max_depth: depth,
      nodes_expanded: expanded,
      hops: hops.length,
      path: [
        { operator_no: from, operator_name: nameOf.get(from) ?? null, via_officer: null },
        ...hops,
      ],
      path_confidence: hops.reduce((a, h) => a * h.hop_confidence, 1),
      notes: [
        NAME_AS_FILED,
        "Path confidence is the product of the hops, so a long chain is worth very little by construction. A two-hop link through a name filed on one other operator is the only shape here worth acting on without checking.",
        "Shortest path only. Other chains exist and a shorter one through a signal this tool does not walk (address, phone, a shared lease) may too.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 57

const shellDetect = defineTool(
  "rrc_shell_detect",
  "Operators registered since a date with one officer and no well history, listing wells and transfers that arrived afterwards.",
  {
    since: z.string(),
    county: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async ({ since, county, limit }) => {
    const from = since.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail("since must be a date, YYYY-MM-DD.");
    const cty = county?.trim() ? resolveCounty(county.trim()) : null;
    if (county?.trim() && !cty) return fail(`Not a Texas county: ${county}.`);
    const cap = clampInt(limit, 100, 1, 300);

    const fresh = await rrcQuery<OperatorRow>(
      `select operator_number, operator_name, p5_status,
              to_char(org_date, 'YYYY-MM-DD')     as org_date,
              to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date,
              addr1, city1, state1, zip1, phone1
         from rrc.operators
        where org_date >= $1::date
        order by org_date desc
        limit 400`,
      [from]
    );
    if (!fresh.length) {
      return { ok: true as const, since: from, operators: [], truncated: false, notes: [OBSERVED_FACTS] };
    }
    const numbers = fresh.map((f) => f.operator_number.trim());

    const [officers, wells, transfers] = await Promise.all([
      rrcQuery<{ operator_number: string; officer_name: string }>(
        `select distinct operator_number, officer_name
           from rrc.operator_officers
          where operator_number = any($1::bpchar[])
            and nullif(btrim(officer_name), '') is not null`,
        [numbers]
      ),
      rrcQuery<{
        operator_number: string;
        wells: number;
        counties: string[];
        oldest_completion: string | null;
      }>(
        `select operator_number, count(distinct api_number)::int as wells,
                array_agg(distinct county_name) as counties,
                min(nullif(btrim(completion_date), '')) as oldest_completion
           from rrc.wellbore
          where operator_number = any($1::bpchar[]) and on_schedule = 'Y'
          group by operator_number`,
        [numbers]
      ),
      // The P-4 is the filing that moves a lease between operators. Keyed on
      // operator_no here rather than on a lease, which costs a scan of the
      // filing tape but is the only way to ask "what arrived at this company".
      rrcQuery<{
        operator_no: string;
        transfers: number;
        first_transfer: string | null;
        last_transfer: string | null;
      }>(
        `select operator_no, count(*)::int as transfers,
                to_char(min(effective_date), 'YYYY-MM-DD') as first_transfer,
                to_char(max(effective_date), 'YYYY-MM-DD') as last_transfer
           from rrc.p4_filing
          where operator_no = any($1::bpchar[])
            and chg_operator = 'Y' and record_type <> 'D'
          group by operator_no`,
        [numbers]
      ),
    ]);

    const officerBy = new Map<string, string[]>();
    for (const o of officers) {
      const no = o.operator_number.trim();
      officerBy.set(no, [...(officerBy.get(no) ?? []), o.officer_name]);
    }
    const wellBy = new Map(wells.map((w) => [w.operator_number.trim(), w]));
    const transferBy = new Map(transfers.map((t) => [t.operator_no.trim(), t]));

    const rows = fresh
      .map((f) => {
        const no = f.operator_number.trim();
        const w = wellBy.get(no);
        const t = transferBy.get(no);
        return {
          operator_no: no,
          operator_name: f.operator_name,
          p5_status: f.p5_status,
          org_date: f.org_date ?? null,
          officers: officerBy.get(no) ?? [],
          officer_count: (officerBy.get(no) ?? []).length,
          wells_on_schedule: w?.wells ?? 0,
          counties: w?.counties ?? [],
          oldest_completion_on_those_wells: ymd(w?.oldest_completion),
          operator_change_filings: t?.transfers ?? 0,
          first_operator_change: t?.first_transfer ?? null,
          last_operator_change: t?.last_transfer ?? null,
          days_from_registration_to_first_change:
            f.org_date && t?.first_transfer ? daysBetween(f.org_date, t.first_transfer) : null,
          mailing_address: [f.addr1, f.city1, f.state1, f.zip1].filter(Boolean).join(", "),
        };
      })
      .filter((r) => r.officer_count <= 1)
      .filter((r) => !cty || r.counties.includes(cty.county_name))
      .sort((a, b) => (a.org_date ?? "") < (b.org_date ?? "") ? 1 : -1)
      .slice(0, cap);

    return {
      ok: true as const,
      since: from,
      county: cty?.county_name ?? null,
      registered_in_window: fresh.length,
      operators: rows,
      truncated: fresh.length >= 400,
      notes: [
        OBSERVED_FACTS,
        "One officer on a P-5 is the normal filing for a single-member LLC, which is how most small Texas operators are held. It is a property of the paperwork, not of the company.",
        "Wells reaching a company shortly after it registers is what a purchase looks like in this record, and what a restructuring looks like, and what a family transfer looks like. The record does not distinguish them.",
        "The oldest completion on the wells now under this operator dates the WELLS, not the company. A new number carrying 1950s holes means the holes changed hands.",
        NAME_AS_FILED,
      ],
    };
  }
);

// ------------------------------------------------------------------ 58

const aliasWatch = defineTool(
  "rrc_alias_watch",
  "Operators registered after this one's P-5 lapsed that share an officer name with it, with both sets of dates.",
  { operator_no: z.string(), limit: z.number().int().optional() },
  async ({ operator_no, limit }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const cap = clampInt(limit, 50, 1, 200);

    const me = await operatorRow(op);
    if (!me) return fail(`No operator ${op}.`);
    const mine = await officersOf(op);
    const names = [...new Set(mine.map((o) => o.officer_name))];
    if (!names.length) {
      return {
        ok: true as const,
        operator_no: op,
        operator_name: me.operator_name,
        officers: [],
        successors: [],
        notes: ["No officers on file for this operator, so there is no name to follow.", NAME_AS_FILED],
      };
    }

    const [shared, spread] = await Promise.all([
      rrcQuery<{ officer_name: string; operator_number: string }>(
        `select distinct officer_name, operator_number
           from rrc.operator_officers
          where officer_name = any($1::text[]) and operator_number <> $2::bpchar
          limit 500`,
        [names, op]
      ),
      nameSpread(names),
    ]);
    if (!shared.length) {
      return {
        ok: true as const,
        operator_no: op,
        operator_name: me.operator_name,
        p5_status: me.p5_status,
        officers: names,
        successors: [],
        notes: [NAME_AS_FILED, OBSERVED_FACTS],
      };
    }

    const numbers = [...new Set(shared.map((s) => s.operator_number.trim()))];
    const [others, wells] = await Promise.all([
      rrcQuery<OperatorRow>(
        `select operator_number, operator_name, p5_status,
                to_char(org_date, 'YYYY-MM-DD')     as org_date,
                to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
           from rrc.operators where operator_number = any($1::bpchar[])`,
        [numbers]
      ),
      rrcQuery<{ operator_number: string; wells: number }>(
        `select operator_number, count(distinct api_number)::int as wells
           from rrc.wellbore
          where operator_number = any($1::bpchar[]) and on_schedule = 'Y'
          group by operator_number`,
        [numbers]
      ),
    ]);
    const wellBy = new Map(wells.map((w) => [w.operator_number.trim(), w.wells]));

    // The reference date is the subject's last P-5 renewal: after that its
    // authority to operate lapses unless it renews. Everything is reported
    // relative to that date rather than filtered by it, so a company formed
    // BEFORE the lapse is visible too and reads as what it is.
    const reference = me.last_p5_date ?? me.org_date ?? null;
    const rows = others
      .map((o) => {
        const no = o.operator_number.trim();
        const via = shared.filter((s) => s.operator_number.trim() === no);
        return {
          operator_no: no,
          operator_name: o.operator_name,
          p5_status: o.p5_status,
          org_date: o.org_date ?? null,
          last_p5_date: o.last_p5_date ?? null,
          wells_on_schedule: wellBy.get(no) ?? 0,
          shared_officers: via.map((v) => ({
            officer_name: v.officer_name,
            operators_with_this_name: spread.get(v.officer_name) ?? 1,
          })),
          registered_after_subject_last_p5:
            reference != null && o.org_date != null ? o.org_date > reference : null,
          days_after_subject_last_p5:
            reference != null && o.org_date != null ? daysBetween(reference, o.org_date) : null,
          confidence: scoreLink({
            operator_number: no,
            operator_name: o.operator_name,
            p5_status: o.p5_status,
            signals: via.map((v) => ({
              signal:
                (spread.get(v.officer_name) ?? 1) > COMMON_NAME_OPERATORS
                  ? "officer name, common"
                  : "officer name",
              weight:
                (spread.get(v.officer_name) ?? 1) > COMMON_NAME_OPERATORS
                  ? SIGNAL_WEIGHT.officer_common
                  : SIGNAL_WEIGHT.officer,
              evidence: v.officer_name,
            })),
          }).confidence,
        };
      })
      .sort((a, b) => (a.org_date ?? "") < (b.org_date ?? "") ? 1 : -1)
      .slice(0, cap);

    return {
      ok: true as const,
      operator_no: op,
      operator_name: me.operator_name,
      p5_status: me.p5_status,
      p5_status_meaning: "A active, I inactive or expired, D delinquent, as filed on the P-5.",
      org_date: me.org_date ?? null,
      last_p5_date: me.last_p5_date ?? null,
      officers: names,
      successors: rows,
      truncated: shared.length >= 500,
      notes: [
        NAME_AS_FILED,
        OBSERVED_FACTS,
        "A P-5 is renewed yearly and lapses when it is not. Lapsing is what happens when a company stops operating, for every reason a company stops operating.",
        "People start more than one company, and partners, spouses and children share surnames and often names. A later company sharing an officer is a lead to check against the corporate filings at the Secretary of State, which is not this record.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 59

/**
 * The named sequences, fixed here rather than taken from the caller.
 *
 * Caller-supplied logic would make this a query language with no review step,
 * and the review is the whole point: each of these is a sequence somebody can
 * argue with, and each step returns the filings that did or did not occur
 * rather than a verdict.
 */
const PATTERNS = ["entity_then_transfers", "delinquency_then_plugs", "acquire_then_quiet"] as const;
type PatternName = (typeof PATTERNS)[number];

const patternScan = defineTool(
  "rrc_pattern_scan",
  "Walk one named filing sequence for an operator and return which steps are on the record with their dates.",
  { pattern: z.enum(PATTERNS), operator_no: z.string() },
  async ({ pattern, operator_no }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const me = await operatorRow(op);
    if (!me) return fail(`No operator ${op}.`);

    interface Step {
      step: string;
      observed: boolean;
      count: number;
      first_date: string | null;
      last_date: string | null;
      source: string;
    }
    const steps: Step[] = [];
    const name = pattern as PatternName;

    steps.push({
      step: "operator registered",
      observed: Boolean(me.org_date),
      count: me.org_date ? 1 : 0,
      first_date: me.org_date ?? null,
      last_date: me.org_date ?? null,
      source: "rrc.operators.org_date",
    });

    if (name === "entity_then_transfers" || name === "acquire_then_quiet") {
      const [transfers, wells, production] = await Promise.all([
        rrcQueryOne<{ n: number; first: string | null; last: string | null }>(
          `select count(*)::int as n,
                  to_char(min(effective_date), 'YYYY-MM-DD') as first,
                  to_char(max(effective_date), 'YYYY-MM-DD') as last
             from rrc.p4_filing
            where operator_no = $1::bpchar and chg_operator = 'Y' and record_type <> 'D'`,
          [op]
        ),
        rrcQueryOne<{ n: number }>(
          `select count(distinct api_number)::int as n
             from rrc.wellbore where operator_number = $1::bpchar and on_schedule = 'Y'`,
          [op]
        ),
        rrcQueryOne<{ first: string | null; last: string | null }>(
          `select to_char(min(cycle), 'YYYY-MM') as first,
                  to_char(max(cycle), 'YYYY-MM') as last
             from rrc.operator_production
            where operator_no = $1
              and (coalesce(oil_prod_vol,0) > 0 or coalesce(gas_prod_vol,0) > 0)`,
          [op]
        ),
      ]);
      steps.push({
        step: "leases transferred in on a P-4",
        observed: (transfers?.n ?? 0) > 0,
        count: transfers?.n ?? 0,
        first_date: transfers?.first ?? null,
        last_date: transfers?.last ?? null,
        source: "rrc.p4_filing where chg_operator = 'Y'",
      });
      steps.push({
        step: "wells carried on schedule",
        observed: (wells?.n ?? 0) > 0,
        count: wells?.n ?? 0,
        first_date: null,
        last_date: null,
        source: "rrc.wellbore where on_schedule = 'Y'",
      });
      steps.push({
        step: "production reported",
        observed: Boolean(production?.first),
        count: 0,
        first_date: production?.first ?? null,
        last_date: production?.last ?? null,
        source: "rrc.operator_production",
      });
    }

    if (name === "delinquency_then_plugs") {
      const wells = await rrcQuery<{ api_number: string }>(
        `select distinct api_number from rrc.wellbore
          where operator_number = $1::bpchar limit 3000`,
        [op]
      );
      const apis = wells.map((w) => w.api_number.trim());
      const [h15, plugs] = await Promise.all([
        rrcQueryOne<{ n: number; first: string | null; last: string | null }>(
          `select count(distinct api_number)::int as n,
                  to_char(min(status_date), 'YYYY-MM-DD') as first,
                  to_char(max(status_date), 'YYYY-MM-DD') as last
             from rrc.wb_h15 where operator_no = $1 and status = 'D'`,
          [op]
        ),
        apis.length
          ? rrcQueryOne<{ n: number; first: string | null; last: string | null }>(
              `select count(*)::int as n,
                      to_char(min(plug_date), 'YYYY-MM-DD') as first,
                      to_char(max(plug_date), 'YYYY-MM-DD') as last
                 from rrc.wb_plug_summary
                where api_number = any($1::bpchar[]) and state_funded`,
              [apis]
            )
          : null,
      ]);
      steps.push({
        step: "H-15 tests filed delinquent",
        observed: (h15?.n ?? 0) > 0,
        count: h15?.n ?? 0,
        first_date: h15?.first ?? null,
        last_date: h15?.last ?? null,
        source: "rrc.wb_h15 where status = 'D'",
      });
      steps.push({
        step: "wells plugged with state funds",
        observed: (plugs?.n ?? 0) > 0,
        count: plugs?.n ?? 0,
        first_date: plugs?.first ?? null,
        last_date: plugs?.last ?? null,
        source: "rrc.wb_plug_summary where state_funded",
      });
    }

    const dated = steps.filter((s) => s.observed && s.first_date);
    const inOrder = dated.every(
      (s, i) => i === 0 || (dated[i - 1].first_date ?? "") <= (s.first_date ?? "")
    );

    return {
      ok: true as const,
      pattern: name,
      operator_no: op,
      operator_name: me.operator_name,
      p5_status: me.p5_status,
      steps,
      steps_observed: steps.filter((s) => s.observed).length,
      steps_total: steps.length,
      dates_in_sequence_order: inOrder,
      notes: [
        OBSERVED_FACTS,
        "Steps are reported whether or not they occurred, and the date order is stated rather than scored. A sequence appearing in order is a sequence appearing in order.",
        "Every step is the ordinary course of business for a company that bought producing wells: registering, filing P-4s, carrying wells, and reporting production.",
        "State-funded plugging is the state paying to plug a well. The record shows it happened and does not show who was liable, what was recovered, or what was agreed.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 60

const velocity = defineTool(
  "rrc_velocity",
  "Whether permits, applications and completions in a county are accelerating, with the production series that has not moved yet.",
  { county: z.string(), months: z.number().int().optional() },
  async ({ county, months }) => {
    const cty = resolveCounty(county.trim());
    if (!cty) return fail(`Not a Texas county: ${county}.`);
    const window = clampInt(months, 36, 6, 120);
    const from = shiftMonths(today(), -window);

    const [permits, completions, applications, profile, edge] = await Promise.all([
      rrcQuery<{ m: string; n: number }>(
        `select to_char(date_trunc('month', issued_date), 'YYYY-MM') as m, count(*)::int as n
           from rrc.permit
          where county_code = $1 and issued_date >= $2::date
          group by 1 order by 1`,
        [cty.county_no, from]
      ),
      rrcQuery<{ m: string; n: number }>(
        `select to_char(date_trunc('month', to_date(approved_dt, 'MM/DD/YYYY')), 'YYYY-MM') as m,
                count(*)::int as n
           from rrc.completion
          where county = $1
            and approved_dt ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
            and to_date(approved_dt, 'MM/DD/YYYY') >= $2::date
          group by 1 order by 1`,
        [cty.county_no, from]
      ),
      rrcQuery<{ m: string; n: number }>(
        `select to_char(month, 'YYYY-MM') as m, count(*)::int as n
           from rrc.pending_activity
          where county_code = $1 and month >= $2::date
          group by 1 order by 1`,
        [cty.county_no, from]
      ),
      getCountyProfile(cty.county_name, 4000),
      getCycleEdge(),
    ]);

    /** Counts per month, then the change, then the change in the change. */
    const derive = (rows: { m: string; n: number }[], label: string) => {
      const months = [...new Set(rows.map((r) => r.m))].sort();
      const series = months.map((m) => ({
        month: m,
        n: rows.filter((r) => r.m === m).reduce((a, r) => a + r.n, 0),
      }));
      const values = series.map((s) => s.n);
      const half = Math.floor(values.length / 2);
      const older = values.slice(0, half);
      const newer = values.slice(half);
      const meanOf = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
      const a = meanOf(older);
      const b = meanOf(newer);
      return {
        stream: label,
        months: series.length,
        series,
        total: sum(values),
        first_half_per_month: a,
        second_half_per_month: b,
        change_per_month: a != null && b != null ? b - a : null,
        // The second difference: is the rate of filing itself speeding up.
        acceleration_per_month_squared:
          series.length >= 4
            ? (() => {
                const d = values.slice(1).map((v, i) => v - values[i]);
                const dd = d.slice(1).map((v, i) => v - d[i]);
                return dd.length ? dd.reduce((x, y) => x + y, 0) / dd.length : null;
              })()
            : null,
      };
    };

    const production = (profile?.monthly ?? [])
      .filter((p) => p.reported && p.cycle >= from.slice(0, 7))
      .map((p) => ({ cycle: p.cycle, oil: p.oil, gas: p.gas }));

    return {
      ok: true as const,
      county: cty.county_name,
      window_months: window,
      since: from,
      reported_through: edge.reported,
      streams: [
        derive(permits, "permits issued"),
        derive(applications, "applications filed"),
        derive(completions, "completions approved"),
      ],
      production_reported: production,
      notes: [
        PENDING_WINDOW,
        lagNote(edge.reported),
        "Acceleration is the mean second difference of the monthly counts, which is noisy on small counties by construction: three permits instead of one is a 200% move and means nothing.",
        "Filing counts move for administrative reasons too. A batch of applications entered on one day, a fee change, or a rule deadline all show up here as activity.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 61

const SIGNALS = ["h15_delinquent", "p5_lapsed", "no_recent_permit"] as const;
const OUTCOMES = ["state_funded_plug", "production_stopped"] as const;

const backtest = defineTool(
  "rrc_backtest",
  "Replay one named signal against one named outcome over a given list of operators, with the base rate beside it.",
  {
    signal: z.enum(SIGNALS),
    outcome: z.enum(OUTCOMES),
    operator_nos: z.array(z.string()),
    horizon_months: z.number().int().optional(),
  },
  async ({ signal, outcome, operator_nos, horizon_months }) => {
    const given = [...new Set(operator_nos.map((s) => s.trim()).filter(Boolean))];
    const list = given.slice(0, 50);
    if (!list.length) return fail("operator_nos is required: give up to 50 operator numbers.");
    const horizon = clampInt(horizon_months, 24, 1, 120);

    const [operators, wells, h15, permits, production] = await Promise.all([
      rrcQuery<OperatorRow>(
        `select operator_number, operator_name, p5_status,
                to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
           from rrc.operators where operator_number = any($1::bpchar[])`,
        [list]
      ),
      rrcQuery<{ operator_number: string; api_number: string }>(
        `select operator_number, api_number from rrc.wellbore
          where operator_number = any($1::bpchar[]) limit 20000`,
        [list]
      ),
      rrcQuery<{ operator_no: string; first: string | null }>(
        `select operator_no, to_char(min(status_date), 'YYYY-MM-DD') as first
           from rrc.wb_h15 where operator_no = any($1::text[]) and status = 'D'
          group by operator_no`,
        [list]
      ),
      rrcQuery<{ operator_number: string; last: string | null }>(
        `select operator_number, to_char(max(issued_date), 'YYYY-MM-DD') as last
           from rrc.permit where operator_number = any($1::bpchar[])
          group by operator_number`,
        [list]
      ),
      rrcQuery<{ operator_no: string; last: string | null }>(
        `select operator_no, to_char(max(cycle), 'YYYY-MM') as last
           from rrc.operator_production
          where operator_no = any($1::text[])
            and (coalesce(oil_prod_vol,0) > 0 or coalesce(gas_prod_vol,0) > 0)
          group by operator_no`,
        [list]
      ),
    ]);

    const apisBy = new Map<string, string[]>();
    for (const w of wells) {
      const no = w.operator_number.trim();
      apisBy.set(no, [...(apisBy.get(no) ?? []), w.api_number.trim()]);
    }
    const allApis = [...new Set(wells.map((w) => w.api_number.trim()))].slice(0, 20000);
    const plugs = allApis.length
      ? await rrcQuery<{ api_number: string; plug_date: string | null }>(
          `select api_number, to_char(min(plug_date), 'YYYY-MM-DD') as plug_date
             from rrc.wb_plug_summary
            where api_number = any($1::bpchar[]) and state_funded
            group by api_number`,
          [allApis]
        )
      : [];
    const plugBy = new Map(plugs.map((p) => [p.api_number.trim(), p.plug_date]));

    const h15By = new Map(h15.map((h) => [h.operator_no.trim(), h.first]));
    const permitBy = new Map(permits.map((p) => [p.operator_number.trim(), p.last]));
    const prodBy = new Map(production.map((p) => [p.operator_no.trim(), p.last]));
    const opBy = new Map(operators.map((o) => [o.operator_number.trim(), o]));
    const cutoff = shiftMonths(today(), -24);

    const rows = list.map((no) => {
      const op = opBy.get(no);
      const signalDate =
        signal === "h15_delinquent"
          ? h15By.get(no) ?? null
          : signal === "p5_lapsed"
            ? op?.p5_status === "A"
              ? null
              : op?.last_p5_date ?? null
            : (permitBy.get(no) ?? "0000-00-00") < cutoff
              ? permitBy.get(no) ?? null
              : null;

      const plugDates = (apisBy.get(no) ?? [])
        .map((api) => plugBy.get(api))
        .filter((d): d is string => Boolean(d))
        .sort();
      const lastCycle = prodBy.get(no) ?? null;
      const outcomeDate =
        outcome === "state_funded_plug"
          ? plugDates[0] ?? null
          : lastCycle && `${lastCycle}-01` < shiftMonths(today(), -12)
            ? `${lastCycle}-01`
            : null;

      const preceded =
        signalDate != null &&
        outcomeDate != null &&
        signalDate <= outcomeDate &&
        daysBetween(signalDate, outcomeDate) <= horizon * 31;

      return {
        operator_no: no,
        operator_name: op?.operator_name ?? null,
        p5_status: op?.p5_status ?? null,
        wells: (apisBy.get(no) ?? []).length,
        signal_date: signalDate,
        outcome_date: outcomeDate,
        signal_preceded_outcome: preceded,
        months_between:
          signalDate && outcomeDate ? daysBetween(signalDate, outcomeDate) / 30.44 : null,
      };
    });

    const withSignal = rows.filter((r) => r.signal_date != null);
    const without = rows.filter((r) => r.signal_date == null);
    const hits = withSignal.filter((r) => r.signal_preceded_outcome).length;
    const baseHits = without.filter((r) => r.outcome_date != null).length;
    const rate = withSignal.length ? hits / withSignal.length : null;
    const base = without.length ? baseHits / without.length : null;

    return {
      ok: true as const,
      signal,
      outcome,
      horizon_months: horizon,
      operators_tested: rows.length,
      with_signal: withSignal.length,
      with_signal_and_outcome: hits,
      hit_rate: rate,
      without_signal: without.length,
      without_signal_with_outcome: baseHits,
      base_rate: base,
      lift: rate != null && base != null && base > 0 ? rate / base : null,
      rows,
      truncated: given.length > list.length,
      notes: [
        "A HAND-PICKED LIST IS NOT A SAMPLE. This replays the signal over exactly the operators given, so the rates below describe those operators and generalise to nothing.",
        "Both dates are the earliest on file, and the file is not a timeline of events: an H-15 status date is when a test was recorded delinquent, not when the operator's trouble started.",
        "Order is not cause. Every operator that eventually stops producing has a last cycle, and any signal that fires late enough will 'precede' it.",
        "The base rate is the same outcome among the operators in this list where the signal never fired. With small lists it is the number to distrust first.",
        OBSERVED_FACTS,
      ],
    };
  }
);

// ------------------------------------------------------------------ 63

const ownFootprint = defineTool(
  "rrc_own_footprint",
  "An operator's whole public position by operator number: identity, fleet, flags, permits, disposal and tests, which is what a counterparty sees.",
  { operator_no: z.string() },
  async ({ operator_no }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const dossier = await getOperatorDossier(op);
    if (!dossier) return fail(`No operator ${op}.`);
    const { reported } = await getCycleEdge();

    const months = dossier.monthly.filter((m) => m.reported);
    const last12 = months.slice(-12);

    return {
      ok: true as const,
      identity: {
        operator_no: dossier.record.operator_number,
        operator_name: dossier.record.operator_name,
        p5_status: dossier.record.p5_status,
        p5_status_meaning: "A active, I inactive or expired, D delinquent.",
        flags: dossier.record.flags,
        org_date: dossier.record.org_date,
        last_p5_date: dossier.record.last_p5_date,
        address: [
          dossier.record.addr1,
          dossier.record.city1,
          dossier.record.state1,
          dossier.record.zip1,
        ]
          .filter(Boolean)
          .join(", "),
        phone: dossier.record.phone1,
      },
      // Names as filed on the P-5, which is what anyone running this operator
      // sees and the entry point to every graph tool in this catalog.
      officers: dossier.officers.map((o) => ({
        officer_name: o.officer_name,
        officer_title: o.officer_title,
        city: o.city,
        state: o.state,
      })),
      fleet: {
        wells: dossier.wells.total,
        by_type: dossier.wells.byType,
        plugged: dossier.wells.plugged,
        flagged_14b2: dossier.wells.flagged14b2,
        surface_violations: dossier.wells.surfaceViolations,
        w3x_violations: dossier.wells.w3xViolations,
        inactive_reasons: dossier.wells.reasons,
      },
      leases: dossier.leases.length,
      fields: dossier.fields.slice(0, 20).map((f) => ({
        field_no: f.field_no,
        field_name: f.field_name,
        leases: f.lease_count,
        oil_last12: f.oil_last12,
        gas_last12: f.gas_last12,
      })),
      production: {
        reported_through: reported,
        last12_oil_bbl: sum(last12.map((m) => m.oil_prod_vol)),
        last12_gas_mcf: sum(last12.map((m) => m.gas_prod_vol)),
        first_cycle: months[0]?.cycle ?? null,
        last_cycle: months[months.length - 1]?.cycle ?? null,
      },
      permits: {
        total: dossier.permitTotal,
        latest: dossier.permits.slice(0, 10).map((p) => ({
          permit_number: p.permit_number,
          issued_date: p.issued_date,
          lease_name: p.lease_name,
          county_name: p.county_name,
          total_depth: p.total_depth,
        })),
      },
      disposal: dossier.disposal,
      h15: dossier.h15,
      truncated: dossier.fields.length > 20 || dossier.permits.length > 10,
      notes: [
        "This is the whole public position, assembled the same way anyone else can assemble it. Nothing here is private and nothing here comes from our own systems.",
        "Officer names, the mailing address and the phone number are the join keys every entity-resolution tool uses, ours included. Whatever links other companies to each other links us the same way.",
        lagNote(reported),
        "Wells are those carried on this P-5 today. Wells sold keep their history under the buyer.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 64

const ownVsPeers = defineTool(
  "rrc_own_vs_peers",
  "An operator's rate, uptime, allowable utilisation and permitted disposal against peers holding leases in the same field.",
  {
    operator_no: z.string(),
    field_no: z.string(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async ({ operator_no, field_no, months, limit }) => {
    const op = operator_no.trim();
    const field = field_no.trim();
    if (!op || !field) return fail("operator_no and field_no are both required.");
    const window = clampInt(months, 24, 6, 120);
    const cap = clampInt(limit, 25, 2, 50);

    const peers = await fieldOperators(field, cap);
    if (!peers.length) return fail(`No leases on record in field ${field}.`);
    const numbers = [...new Set([op, ...peers.map((p) => p.operator_no.trim())])];

    const [{ reported }, rows, names, disposal] = await Promise.all([
      getCycleEdge(),
      fieldMonths(numbers, field, window),
      rrcQuery<OperatorRow>(
        `select operator_number, operator_name, p5_status
           from rrc.operators where operator_number = any($1::bpchar[])`,
        [numbers]
      ),
      rrcQuery<{ operator_no: string; wells: number; permitted: number | null }>(
        // The live-permit test is uic_class, activated_flag, cancel_date AND
        // w3_date together, exactly as `getOperatorDisposal` applies it. Drop
        // any one of the four and this catalog quotes two different permitted
        // volumes for the same operator.
        `select operator_no, count(*)::int as wells,
                sum(max_bbl_per_day)::float8 as permitted
           from rrc.uic_permit
          where operator_no = any($1::bpchar[])
            and inj_type in ('1','2')
            and uic_class = '2' and activated_flag = 'Y'
            and cancel_date is null and w3_date is null
          group by operator_no`,
        [numbers]
      ),
    ]);
    const nameOf = new Map(names.map((n) => [n.operator_number.trim(), n.operator_name]));
    const disposalBy = new Map(disposal.map((d) => [d.operator_no.trim(), d]));

    const ranked = numbers
      .map((no) => {
        const mine = rows.filter((r) => r.operator_no.trim() === no && r.cycle <= reported);
        const stats = uptimeOf(mine, reported);
        const oil = sum(mine.map((m) => m.oil));
        const allow = sum(mine.map((m) => m.oil_allow));
        return {
          operator_no: no,
          operator_name: nameOf.get(no) ?? null,
          is_subject: no === op,
          months: stats.months,
          uptime: stats.uptime,
          oil_bbl: oil,
          gas_mcf: sum(mine.map((m) => m.gas)),
          oil_bbl_per_producing_month: stats.producing_months
            ? oil / stats.producing_months
            : null,
          oil_allowable_bbl: allow || null,
          // Actual over allowable: at 1.0 the lease is at its ceiling and
          // cannot ramp without a new allowable, whatever the rock would give.
          allowable_utilisation: allow > 0 ? oil / allow : null,
          disposal_wells: disposalBy.get(no)?.wells ?? 0,
          disposal_permitted_bbl_per_day: disposalBy.get(no)?.permitted ?? null,
        };
      })
      .filter((r) => r.months > 0)
      .sort((a, b) => b.oil_bbl - a.oil_bbl);

    const subject = ranked.find((r) => r.is_subject) ?? null;
    const others = ranked.filter((r) => !r.is_subject);
    return {
      ok: true as const,
      operator_no: op,
      field_no: field,
      window_months: window,
      reported_through: reported,
      subject,
      peers: others.length,
      peer_medians: {
        uptime: median(others.map((o) => o.uptime ?? 0)),
        oil_bbl: median(others.map((o) => o.oil_bbl)),
        allowable_utilisation: median(
          others.map((o) => o.allowable_utilisation).filter((v): v is number => v != null)
        ),
      },
      ranked,
      notes: [
        lagNote(reported),
        "Every number is FIELD-SCOPED: only the leases these operators hold in this field. An operator's other assets are not here and their statewide numbers will not match.",
        "Allowable utilisation is reported oil over the filed oil allowable. An allowable is an administrative ceiling per lease, so a low ratio can be a choked well, a market problem, or an allowable that was simply set high.",
        "Disposal is PERMITTED barrels per day across live injection and disposal permits, which is capacity held, not water moved.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 65

const offsetPressure = defineTool(
  "rrc_offset_pressure",
  "Other operators' permits and pending applications sitting close to an operator's own wells, by well and by rival.",
  {
    operator_no: z.string(),
    radius_mi: z.number().optional(),
    since: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async ({ operator_no, radius_mi, since, limit }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const radius = Math.min(25, Math.max(0.25, radius_mi ?? 2));
    const cap = clampInt(limit, 200, 1, 500);
    const from = since?.trim() || shiftMonths(today(), -12);

    const fleet = (await findWells({ operatorNo: op, limit: cap })).filter(
      (w) => w.lat != null && w.lon != null
    );
    if (!fleet.length) return fail(`No wells with coordinates on file for operator ${op}.`);

    // A padded bounding box round our own fleet, so the permit read is one
    // viewport query rather than one per well.
    const pad = radius / 60;
    const box = {
      south: Math.min(...fleet.map((w) => w.lat!)) - pad,
      north: Math.max(...fleet.map((w) => w.lat!)) + pad,
      west: Math.min(...fleet.map((w) => w.lon!)) - pad,
      east: Math.max(...fleet.map((w) => w.lon!)) + pad,
    };
    const [approved, pending] = await Promise.all([
      getApprovedPermits(box, 4000),
      getPendingQueue(2000),
    ]);

    const candidates: (PendingPermit & { state: "approved" | "pending" })[] = [
      ...approved.map((p) => ({ ...p, state: "approved" as const })),
      ...pending.map((p) => ({ ...p, state: "pending" as const })),
    ].filter(
      (p) =>
        p.surface_lat != null &&
        p.surface_lon != null &&
        p.operator_number?.trim() !== op &&
        (p.submit_date ?? "") >= from
    );

    const hits = candidates
      .map((p) => {
        let best: { well: NearbyWell; mi: number } | null = null;
        for (const w of fleet) {
          const mi = distanceMiles(w.lat!, w.lon!, p.surface_lat!, p.surface_lon!);
          if (!best || mi < best.mi) best = { well: w, mi };
        }
        return { permit: p, nearest: best! };
      })
      .filter((h) => h.nearest.mi <= radius)
      .sort((a, b) => a.nearest.mi - b.nearest.mi);

    const byOperator = new Map<string, { name: string | null; permits: number; nearest_mi: number }>();
    for (const h of hits) {
      const no = h.permit.operator_number?.trim() ?? "unknown";
      const slot = byOperator.get(no) ?? {
        name: h.permit.operator_name,
        permits: 0,
        nearest_mi: h.nearest.mi,
      };
      slot.permits += 1;
      slot.nearest_mi = Math.min(slot.nearest_mi, h.nearest.mi);
      byOperator.set(no, slot);
    }

    return {
      ok: true as const,
      operator_no: op,
      radius_mi: radius,
      since: from,
      our_wells_placed: fleet.length,
      offset_filings: hits.map((h) => ({
        state: h.permit.state,
        universal_doc_no: h.permit.universal_doc_no,
        operator_no: h.permit.operator_number,
        operator_name: h.permit.operator_name,
        lease_name: h.permit.lease_name,
        purpose: h.permit.filing_purpose,
        total_depth: h.permit.total_depth,
        horizontal: h.permit.horizontal,
        submit_date: h.permit.submit_date,
        days_pending: h.permit.days_pending,
        distance_mi: Math.round(h.nearest.mi * 100) / 100,
        our_nearest_well: h.nearest.well.api_number,
        our_nearest_lease: h.nearest.well.lease_name,
      })),
      by_operator: [...byOperator.entries()]
        .map(([no, v]) => ({ operator_no: no, ...v }))
        .sort((a, b) => b.permits - a.permits),
      wells_under_pressure: [
        ...new Set(hits.map((h) => h.nearest.well.api_number)),
      ].length,
      notes: [
        NO_PERMIT_COORDS,
        "Purpose is the W-1 filing purpose, which is where a recompletion or a re-entry next door shows up before anything is drilled. Approved permits carry the same field.",
        "Distance is surface hole to surface hole. A horizontal permit's lateral can run a mile or more from its surface location, so a filing that looks far can land under the lease and one that looks close can head away.",
        "Our own wells are those on this P-5 with coordinates in rrc.well_location. Coverage thins badly on old leases, and unplaced wells are excluded rather than assumed near.",
        "The since filter reads the filing date on a pending application and the ISSUE date on an approved one, which are the two dates that mean the same thing to the operator on the other side of the fence.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 66

const ownDisposalPosition = defineTool(
  "rrc_own_disposal_position",
  "An operator's injected barrels against the permitted headroom and commercial capacity within a radius of its own disposal.",
  { operator_no: z.string(), radius_mi: z.number().optional() },
  async ({ operator_no, radius_mi }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const radius = Math.min(100, Math.max(1, radius_mi ?? 25));
    const { rollup, wells } = await ownDisposal(op);
    if (!wells.length) {
      return {
        ok: true as const,
        operator_no: op,
        reported_through: rollup.reportedThrough,
        own_wells: 0,
        local: null,
        notes: [
          "This operator holds no live disposal or injection permit, so there is no position to measure. Water they produce goes somewhere the record does not name.",
        ],
      };
    }

    const placed = wells.filter((w) => w.lat != null && w.lon != null);
    const centre = placed.length
      ? {
          lat: sum(placed.map((w) => w.lat)) / placed.length,
          lon: sum(placed.map((w) => w.lon)) / placed.length,
        }
      : null;
    const local = centre
      ? await findDisposal({ lat: centre.lat, lon: centre.lon, radiusMi: radius, limit: 200 })
      : [];

    const ours = new Set(wells.map((w) => w.uic_no));
    const theirs = local.filter((w) => !ours.has(w.uic_no));
    const measured = theirs.filter(
      (w) => w.max_bbl_per_day != null && w.recentBblPerDay != null
    );
    const commercial = measured.filter((w) => w.is_commercial);

    const ownUsed = sum(wells.map((w) => w.recentBblPerDay));
    const ownPermitted = sum(wells.map((w) => w.max_bbl_per_day));
    const localHeadroom = measured.reduce(
      (s, w) => s + Math.max(0, w.max_bbl_per_day! - w.recentBblPerDay!),
      0
    );
    const commercialHeadroom = commercial.reduce(
      (s, w) => s + Math.max(0, w.max_bbl_per_day! - w.recentBblPerDay!),
      0
    );

    return {
      ok: true as const,
      operator_no: op,
      reported_through: rollup.reportedThrough,
      centre,
      radius_mi: radius,
      own_wells: wells.length,
      own_permitted_bbl_per_day: ownPermitted,
      own_reported_bbl_per_day: ownUsed,
      own_utilisation: ownPermitted > 0 ? ownUsed / ownPermitted : null,
      own_headroom_bbl_per_day: Math.max(0, ownPermitted - ownUsed),
      local: {
        wells: theirs.length,
        wells_measured: measured.length,
        headroom_bbl_per_day: localHeadroom,
        commercial_wells: commercial.length,
        commercial_headroom_bbl_per_day: commercialHeadroom,
        // What it would take to rehome today's volume if our own wells went
        // away: the number that decides whether this is a risk or an errand.
        cover_ratio: ownUsed > 0 ? localHeadroom / ownUsed : null,
      },
      notes: [
        "Permitted volume is a legal ceiling, not an offer. A third-party well with headroom on paper may not take your water at all, and the price is not in the record.",
        `H-10 filing runs about a year behind, so everything here is measured through ${rollup.reportedThrough}. A thin recent tail is late filing, not a well that stopped.`,
        "Wells that have never reported are listed by the headroom tools but excluded from these sums: their ceiling is real and their spare capacity is unknown, and counting it would overstate cover by exactly the amount nobody can verify.",
        "Enhanced-recovery injection is excluded from the local set only where the source query excludes it. Type 3 goes back into a producing zone, not away.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 82

const intentFeed = defineTool(
  "rrc_intent_feed",
  "Drilling permits FILED and not yet approved, by county, operator or radius: the earliest signal in the record and the only one with coordinates.",
  { ...AREA_SHAPE, purpose: z.string().optional() },
  async (args) => {
    const cty = args.county?.trim() ? resolveCounty(args.county.trim()) : null;
    if (args.county?.trim() && !cty) return fail(`Not a Texas county: ${args.county}.`);
    const op = args.operator_no?.trim();
    const hasPoint = Number.isFinite(args.lat) && Number.isFinite(args.lon);
    if (!cty && !op && !hasPoint) return fail(NO_AREA);
    const cap = clampInt(args.limit, 200, 1, 500);
    const radius = Math.min(100, Math.max(1, args.radius_mi ?? 25));

    // rrc.pending_queue ONLY. The issued-permit master is a different question
    // and a later one: everything here is an application the Commission has
    // received and not yet acted on.
    const queue = await getPendingQueue(2000);
    const wanted = args.purpose?.trim().toLowerCase();

    const rows = queue
      .filter((p) => !cty || p.county_name === cty.county_name)
      .filter((p) => !op || p.operator_number?.trim() === op)
      .filter((p) => !wanted || (p.filing_purpose ?? "").toLowerCase().includes(wanted))
      .map((p) => ({
        ...p,
        distance_mi:
          hasPoint && p.surface_lat != null && p.surface_lon != null
            ? Math.round(
                distanceMiles(args.lat!, args.lon!, p.surface_lat, p.surface_lon) * 100
              ) / 100
            : null,
      }))
      .filter((p) => !hasPoint || (p.distance_mi != null && p.distance_mi <= radius))
      .sort((a, b) => (a.days_pending ?? 0) - (b.days_pending ?? 0));

    const shown = rows.slice(0, cap);
    return {
      ok: true as const,
      area:
        [cty ? `${cty.county_name} County` : null, op ? `operator ${op}` : null,
          hasPoint ? `${radius} mi of ${args.lat}, ${args.lon}` : null]
          .filter(Boolean)
          .join(", "),
      queue_size: queue.length,
      matches: rows.length,
      applications: shown.map((p) => ({
        universal_doc_no: p.universal_doc_no,
        status_number: p.status_number,
        operator_no: p.operator_number,
        operator_name: p.operator_name,
        lease_name: p.lease_name,
        well_number: p.well_number,
        county_name: p.county_name,
        district: p.district_name,
        purpose: p.filing_purpose,
        total_depth: p.total_depth,
        horizontal: p.horizontal,
        submit_date: p.submit_date,
        days_pending: p.days_pending,
        current_state_code: p.current_state_code,
        surface_lat: p.surface_lat,
        surface_lon: p.surface_lon,
        location_source: p.location_source,
        distance_mi: p.distance_mi,
      })),
      by_operator: [...new Set(shown.map((p) => p.operator_number?.trim()))]
        .filter(Boolean)
        .map((no) => ({
          operator_no: no,
          operator_name:
            shown.find((p) => p.operator_number?.trim() === no)?.operator_name ?? null,
          applications: shown.filter((p) => p.operator_number?.trim() === no).length,
        }))
        .sort((a, b) => b.applications - a.applications),
      truncated: rows.length > shown.length,
      notes: [
        "APPLICATIONS, NOT PERMITS. Nothing here is approved and about 3 percent never will be. An operator can withdraw one, and the feed publishes arrivals only, so a withdrawal simply stops appearing.",
        "The queue is capped at 180 days by the source view, because the feed never announces a denial and an old unapproved application is a dead one rather than a slow one.",
        "Coordinates are NAD27 decimal degrees as the RRC GIS holds them, about 35 m off the NAD83 positions in rrc.well_location. Close, not identical.",
        "Days pending is days since filing. Issue takes 1 to 8 days for most of what is granted, so a row sitting at 30 is stuck, usually in mapping or a hearing.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 83

const permitPurpose = defineTool(
  "rrc_permit_purpose",
  "Applications split by filing purpose, new drill against recompletion, re-entry, field transfer and reclass, with the approval rate for each.",
  {
    county: z.string().optional(),
    operator_no: z.string().optional(),
    since: z.string().optional(),
  },
  async ({ county, operator_no, since }) => {
    const cty = county?.trim() ? resolveCounty(county.trim()) : null;
    if (county?.trim() && !cty) return fail(`Not a Texas county: ${county}.`);
    const op = operator_no?.trim();
    if (!cty && !op) return fail("county or operator_no is required. A statewide scan is refused.");
    const from = since?.trim() || "2025-07-07";

    const rows = await rrcQuery<{
      filing_purpose_code: string | null;
      month: string;
      n: number;
      approved: number;
    }>(
      `select filing_purpose_code, to_char(month, 'YYYY-MM') as month,
              count(*)::int                          as n,
              count(*) filter (where approved)::int  as approved
         from rrc.pending_activity
        where ${cty ? "county_code = $1" : "operator_number = $1::bpchar"}
          and month >= $2::date
        group by 1, 2
        order by 2`,
      [cty ? cty.county_no : op, from]
    );

    const codes = [...new Set(rows.map((r) => (r.filing_purpose_code ?? "").trim()))];
    const total = sum(rows.map((r) => r.n));

    return {
      ok: true as const,
      subject: cty ? `${cty.county_name} County` : `operator ${op}`,
      since: from,
      applications: total,
      by_purpose: codes
        .map((code) => {
          const mine = rows.filter((r) => (r.filing_purpose_code ?? "").trim() === code);
          const n = sum(mine.map((r) => r.n));
          const approved = sum(mine.map((r) => r.approved));
          return {
            purpose_code: code,
            purpose: PENDING_PURPOSE[code] ?? "Unmapped code",
            applications: n,
            approved,
            // Recent filings have not had time to be decided, so this floors
            // rather than measures the approval rate.
            approved_share: n > 0 ? approved / n : null,
            share_of_all: total > 0 ? n / total : null,
          };
        })
        .sort((a, b) => b.applications - a.applications),
      by_month: [...new Set(rows.map((r) => r.month))].sort().map((m) => ({
        month: m,
        applications: sum(rows.filter((r) => r.month === m).map((r) => r.n)),
        purposes: rows
          .filter((r) => r.month === m)
          .map((r) => ({
            purpose: PENDING_PURPOSE[(r.filing_purpose_code ?? "").trim()] ?? r.filing_purpose_code,
            applications: r.n,
          })),
      })),
      notes: [
        PENDING_WINDOW,
        "Approved means the application has since turned up in rrc.permit under the same number and sequence. Something filed last week is usually not decided yet, so the approval share reads low at the recent end by construction.",
        "Recompletion here is the W-1 purpose code 14, an operator applying to complete in a different zone on an existing hole. That is a different form and a different code list from the W-2 completion type.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 84

const permitAbandoned = defineTool(
  "rrc_permit_abandoned",
  "Permits that reached their expiry with no wellbore carrying the number: a plan that died, or acreage about to fall out of hold.",
  {
    county: z.string().optional(),
    operator_no: z.string().optional(),
    since: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async ({ county, operator_no, since, limit }) => {
    const cty = county?.trim() ? resolveCounty(county.trim()) : null;
    if (county?.trim() && !cty) return fail(`Not a Texas county: ${county}.`);
    const op = operator_no?.trim();
    if (!cty && !op) return fail("county or operator_no is required. A statewide scan is refused.");
    const cap = clampInt(limit, 200, 1, 500);
    const from = since?.trim() || shiftMonths(today(), -60);

    const expired = await rrcQuery<{
      permit_number: string;
      permit_seq: string | null;
      operator_number: string | null;
      operator_name: string | null;
      lease_name: string | null;
      well_number: string | null;
      county_code: string | null;
      district: string | null;
      total_depth: number | null;
      issued_date: string | null;
      expires_date: string | null;
    }>(
      `select p.permit_number, p.permit_seq, p.operator_number, o.operator_name,
              p.lease_name, p.well_number, p.county_code, p.district, p.total_depth,
              to_char(p.issued_date, 'YYYY-MM-DD')  as issued_date,
              to_char(p.expires_date, 'YYYY-MM-DD') as expires_date
         from rrc.permit p
         left join rrc.operators o on o.operator_number = p.operator_number
        where ${cty ? "p.county_code = $1" : "p.operator_number = $1::bpchar"}
          and p.expires_date < current_date
          and p.issued_date >= $2::date
        order by p.expires_date desc
        limit $3`,
      [cty ? cty.county_no : op, from, cap]
    );
    if (!expired.length) {
      return {
        ok: true as const,
        subject: cty ? `${cty.county_name} County` : `operator ${op}`,
        since: from,
        expired: 0,
        abandoned: [],
        truncated: false,
      };
    }

    // One scan of the wellbore table for the whole candidate set, rather than an
    // exists() per permit: rrc.wellbore has no index on recent_permit, so a
    // correlated subquery here is one full scan per row.
    // Stripped on BOTH sides. rrc.permit pads to seven and the wellbore usually
    // carries six, but 1,376 of 23,961 wellbore rows in one county alone keep a
    // leading zero, so comparing a stripped number against a raw column silently
    // calls those permits unbuilt.
    const bare = [...new Set(expired.map((p) => p.permit_number.trim().replace(/^0+/, "")))];
    const used = await rrcQuery<{ recent_permit: string }>(
      `select distinct ltrim(btrim(recent_permit), '0') as recent_permit
         from rrc.wellbore
        where ltrim(btrim(recent_permit), '0') = any($1::text[])`,
      [bare]
    );
    const built = new Set(used.map((u) => u.recent_permit.trim()));

    const rows = expired
      .map((p) => ({
        permit_number: p.permit_number.trim(),
        permit_seq: p.permit_seq,
        operator_no: p.operator_number?.trim() ?? null,
        operator_name: p.operator_name,
        lease_name: p.lease_name,
        well_number: p.well_number,
        county_no: p.county_code,
        district: p.district,
        total_depth: p.total_depth,
        issued_date: p.issued_date,
        expires_date: p.expires_date,
        wellbore_carries_this_permit: built.has(p.permit_number.trim().replace(/^0+/, "")),
      }))
      .filter((r) => !r.wellbore_carries_this_permit);

    const byOperator = new Map<string, { name: string | null; n: number }>();
    for (const r of rows) {
      const no = r.operator_no ?? "unknown";
      const slot = byOperator.get(no) ?? { name: r.operator_name, n: 0 };
      slot.n += 1;
      byOperator.set(no, slot);
    }

    return {
      ok: true as const,
      subject: cty ? `${cty.county_name} County` : `operator ${op}`,
      since: from,
      expired: expired.length,
      unbuilt: rows.length,
      unbuilt_share: expired.length ? rows.length / expired.length : null,
      abandoned: rows,
      by_operator: [...byOperator.entries()]
        .map(([no, v]) => ({ operator_no: no, operator_name: v.name, permits: v.n }))
        .sort((a, b) => b.permits - a.permits),
      truncated: expired.length >= cap,
      notes: [
        "Unbuilt means NO WELLBORE IN THE MIRROR CARRIES THIS PERMIT NUMBER. rrc.wellbore holds only the most recent permit per hole, so a well drilled on this permit and re-permitted later reads as unbuilt here. Treat it as a candidate list, not a count.",
        "A Texas drilling permit runs two years. Expiry is routine: plans slip, prices move, and a permit is an option nobody is obliged to exercise.",
        "Expiry is not the lease clock. Whether acreage is actually held depends on the lease terms, which are private contracts and not in this record.",
        NO_PERMIT_COORDS,
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  operatorTimeline,
  recompletionWatch,
  zoneMigration,
  completionBenchmark,
  newEntrant,
  waterStrategy,
  purchaserMap,
  peerUptime,
  areaWatch,
  permitForecast,
  entityResolve,
  pathBetween,
  shellDetect,
  aliasWatch,
  patternScan,
  velocity,
  backtest,
  ownFootprint,
  ownVsPeers,
  offsetPressure,
  ownDisposalPosition,
  intentFeed,
  permitPurpose,
  permitAbandoned,
];
