import "server-only";

/**
 * Reads of `rrc.arrival` (the Tiger mirror, rrc-data `sql/022_arrivals.sql`).
 *
 * The mirror reloads its tables every night, so it cannot say what is new; the
 * nightly `rrc.arrivals` step records each key the first night it is seen and
 * these reads are all Wildcat ever asks of it. Seeded rows (the install-time
 * backfill and anything that arrived already stale) are never returned.
 *
 * No auth here, like the rest of `rrc-queries.ts`: the callers are the
 * dispatcher (service role, no session) and a signed-in server action.
 */

import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import { FILING_PURPOSE } from "@/lib/scout/rrc-queries";
import type { AlertKind, ArrivalItem } from "./types";

/**
 * The newest arrivals run, or null when the step has never run.
 *
 * This is the cursor ceiling: a send covers `first_seen` up to here, so an
 * arrivals run that lands mid-dispatch is reported next time rather than split.
 */
export async function latestArrivalRun(): Promise<string | null> {
  const row = await rrcQueryOne<{ run_at: string | null }>(
    `select max(run_at)::text as run_at from rrc.arrival_run`
  );
  return row?.run_at ? new Date(row.run_at).toISOString() : null;
}

/** Ceiling on one read: a week of statewide activity is a few thousand rows. */
const READ_CAP = 20_000;

interface Row {
  kind: AlertKind;
  key: string;
  county_code: string;
  operator_number: string | null;
  operator_name: string | null;
  lease_name: string | null;
  well_number: string | null;
  purpose_code: string | null;
  total_depth: number | null;
  event_date: string | null;
  doc: string | null;
  first_seen: string;
}

/**
 * Every unseeded arrival in `counties` of `kinds` with first_seen in
 * (after, until], with the fields the email shows.
 *
 * One read for a whole dispatch pass (the union of every due alert's counties),
 * split per alert in memory: per-alert reads would cost a round trip each to a
 * second database that the map is also using.
 *
 * The detail joins are keyed lookups (`pending_permit` by doc and status,
 * `permit` by number via sql/022's `permit_number_idx`, `wellbore` by API) so a pass stays well inside the pool's
 * 5 s statement timeout.
 */
export async function readArrivals(opts: {
  counties: number[];
  kinds: AlertKind[];
  after: string;
  until: string;
}): Promise<ArrivalItem[]> {
  if (!opts.counties.length || !opts.kinds.length) return [];
  const counties = [...new Set(opts.counties)].map((c) => String(c).padStart(3, "0"));
  const rows = await rrcQuery<Row>(
    `with a as (
       select kind, key, county_code, operator_number, event_date, first_seen
         from rrc.arrival
        where not seeded
          and county_code = any($1::char(3)[])
          and kind = any($2::text[])
          and first_seen > $3::timestamptz
          and first_seen <= $4::timestamptz
        order by first_seen, event_date desc nulls last
        limit $5
     )
     select a.kind, a.key, a.county_code, a.operator_number,
            coalesce(pp.operator_name, wb.operator_name, o.operator_name) as operator_name,
            coalesce(pp.default_lease_name, pm.lease_name, wb.lease_name) as lease_name,
            coalesce(pp.default_well_number, pm.well_number, wb.well_no) as well_number,
            coalesce(pp.filing_purpose_code, ap.filing_purpose_code) as purpose_code,
            coalesce(pp.total_depth, pm.total_depth) as total_depth,
            to_char(a.event_date, 'YYYY-MM-DD') as event_date,
            ap.universal_doc_no as doc,
            a.first_seen::text as first_seen
       from a
       left join lateral (
         select p.operator_name, p.default_lease_name, p.default_well_number,
                p.filing_purpose_code, p.total_depth
           from rrc.pending_permit p
          where a.kind = 'pending_permit' and p.universal_doc_no = a.key
          order by p.snapshot desc
          limit 1
       ) pp on true
       left join lateral (
         select m.lease_name, m.well_number, m.total_depth, m.permit_seq
           from rrc.permit m
          where a.kind = 'permit'
            and m.permit_number = a.key
          order by m.permit_seq desc
          limit 1
       ) pm on true
       left join lateral (
         select p.universal_doc_no, p.filing_purpose_code
           from rrc.pending_permit p
          where a.kind = 'permit'
            -- status_number is the 6-char form of the 7-char permit number:
            -- matching on it lets the status index serve the lookup.
            and p.status_number = right(a.key, 6)
            and lpad(p.status_number, 7, '0') = a.key
            and p.status_seq_no = pm.permit_seq
          order by p.snapshot desc
          limit 1
       ) ap on true
       left join lateral (
         select w.operator_name, w.lease_name, w.well_no
           from rrc.wellbore w
          where a.kind = 'well' and w.api_number = a.key and w.on_schedule = 'Y'
          limit 1
       ) wb on true
       left join rrc.operators o on o.operator_number = a.operator_number`,
    [counties, opts.kinds, opts.after, opts.until, READ_CAP]
  );
  if (rows.length >= READ_CAP) {
    console.warn(`[recon-alerts] arrivals read hit its cap of ${READ_CAP}`);
  }
  return rows.map((r) => ({
    kind: r.kind,
    key: r.key.trim(),
    countyCode: Number(r.county_code),
    operatorNumber: r.operator_number?.trim() || null,
    operatorName: r.operator_name?.trim() || null,
    leaseName: r.lease_name?.trim() || null,
    wellNumber: r.well_number?.trim() || null,
    purpose: r.purpose_code ? FILING_PURPOSE[r.purpose_code] ?? null : null,
    totalDepth: r.total_depth,
    eventDate: r.event_date,
    doc: r.doc,
    firstSeen: new Date(r.first_seen).toISOString(),
  }));
}
