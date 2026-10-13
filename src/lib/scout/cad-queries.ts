import "server-only";

import { rrcQuery, rrcQueryOne } from "./rrc-db";
import { getCycleEdge } from "./rrc-queries";
import { districtLabel } from "./rrc-districts";
import { cadCoverage, type CadCoverage } from "./cad";
import type {
  CoOwner,
  LeaseMinerals,
  MineralInterest,
  OwnerDossier,
  OwnerInterest,
  OwnerMatch,
} from "./rrc-types";

/**
 * Every read of the county mineral rolls (`cad` schema in the Tiger mirror).
 *
 * A separate module from `rrc-queries.ts`: a different schema, a different
 * vintage rule (a tax year rather than a reporting cycle), and it has to be
 * deletable without touching the RRC reads. Same rules otherwise -- every
 * caller gates first, `rrc-db.ts` carries no authorization of its own, and
 * nothing here touches a hypertable except `lease_production` by its lease
 * index, which is the 96 ms path. See docs/plans/scout-minerals.md.
 *
 * THE TWO DISTRICT COLUMNS. `mineral_interest.district_no` is PDQ's code and
 * joins `rrc.lease` / `rrc.lease_production`; `mineral_interest.district` is
 * the real label and joins `rrc.wellbore` (the focus clause in
 * `focus-where.ts` uses that one). Each join is a plain equality because the
 * loader translated once.
 */

// ------------------------------------------------------------------ leases

/**
 * The Minerals tab for one lease.
 *
 * Null when the lease's county has no roll loaded (the tab is not rendered);
 * a covered county with nothing on the roll for this lease returns the shape
 * with an empty `interests`, which the tab renders as "not on the roll".
 *
 * `countyNo` is the county the caller attributes the lease to (the dossier's
 * dominant county). A lease spanning two counties is on each county's roll
 * separately; this reads the one asked for.
 */
export async function getLeaseMinerals(
  oilGasCode: string,
  districtNo: string,
  leaseNo: string,
  countyNo: string
): Promise<LeaseMinerals | null> {
  const cov = cadCoverage(countyNo);
  if (!cov) return null;

  const rows = await rrcQuery<
    MineralInterest & {
      cad_operator_name: string | null;
      cad_first_cycle: string | null;
      cad_last_cycle: string | null;
      ref_api_number: string | null;
    }
  >(
    `select mi.cad_account, mi.owner_id, o.name as owner_name, o.owner_type,
            o.city as owner_city, o.state as owner_state,
            mi.interest::float8 as interest, btrim(mi.interest_type) as interest_type,
            mi.value_appraised, mi.acreage::float8 as acreage,
            mi.cad_operator_name, mi.cad_first_cycle, mi.cad_last_cycle,
            mi.ref_api_number
       from cad.mineral_interest mi
       join cad.mineral_owner o
         on o.county_no = mi.county_no and o.tax_year = mi.tax_year
        and o.owner_id = mi.owner_id
      where mi.county_no = $1 and mi.tax_year = $2
        and mi.oil_gas_code = $3 and mi.district_no = $4 and mi.lease_no = $5
      order by mi.interest desc nulls last, o.name`,
    [cov.countyNo, cov.taxYear, oilGasCode, districtNo, leaseNo]
  );

  // The roll files the same operator string and cycles on every row of a
  // lease; the first row is as good as any and there is no "right" one to
  // prefer. Rows disagreeing would be a roll defect, not something to resolve.
  const head = rows[0];
  return {
    county_no: cov.countyNo,
    county_name: cov.name,
    tax_year: cov.taxYear,
    interests: rows.map((r) => ({
      cad_account: r.cad_account,
      owner_id: r.owner_id,
      owner_name: r.owner_name,
      owner_type: r.owner_type?.trim() ?? null,
      owner_city: r.owner_city,
      owner_state: r.owner_state,
      interest: r.interest,
      interest_type: r.interest_type,
      value_appraised: r.value_appraised,
      acreage: r.acreage,
    })),
    value_appraised: rows.reduce((s, r) => s + (r.value_appraised ?? 0), 0),
    cad_operator_name: head?.cad_operator_name ?? null,
    cad_first_cycle: head?.cad_first_cycle ?? null,
    cad_last_cycle: head?.cad_last_cycle ?? null,
    ref_api_number: head?.ref_api_number?.trim() ?? null,
  };
}

// ------------------------------------------------------------------ owners

/**
 * Owners whose name matches, biggest holder first.
 *
 * Ranked by lease count then appraised value, the way `searchPeople` ranks by
 * wells: typing "bridwell" should surface the Bridwell on 23 leases, not a
 * namesake with one. Trigram-indexed (`mo_name_trgm`), so the leading
 * wildcard is an index scan. Across every loaded roll; the hit says which.
 */
export async function searchOwners(q: string, limit = 10): Promise<OwnerMatch[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  return rrcQuery<OwnerMatch>(
    `select o.county_no, o.tax_year, o.owner_id, o.name, btrim(o.owner_type) as owner_type,
            o.city, o.state,
            count(distinct (mi.oil_gas_code, mi.district_no, mi.lease_no))::int as lease_count,
            coalesce(sum(mi.value_appraised), 0)::bigint as value_appraised
       from cad.mineral_owner o
       join cad.mineral_interest mi
         on mi.county_no = o.county_no and mi.tax_year = o.tax_year
        and mi.owner_id = o.owner_id
      where o.name ilike $1
      group by o.county_no, o.tax_year, o.owner_id, o.name, o.owner_type, o.city, o.state
      order by lease_count desc, value_appraised desc, o.name
      limit $2`,
    [`%${term}%`, Math.min(50, Math.max(1, Math.floor(limit)))]
  );
}

/**
 * One owner: who they are, every lease they hold, and who holds beside them.
 *
 * The lease name and operator on each row are the MIRROR'S (`rrc.lease`),
 * not the roll's string, so what the modal shows for a lease here is what the
 * lease modal shows. The volumes are the lease's twelve months ending at the
 * reported edge, read by the lease index over at most a few hundred keys.
 *
 * Wells are not here: the map draws them through the focus query
 * (`FocusOpts.owner`), which is the same colour rule and cap as an operator's.
 */
export async function getOwner(
  countyNo: string,
  taxYear: number,
  ownerId: string
): Promise<OwnerDossier | null> {
  const cov = cadCoverage(countyNo);
  if (!cov || cov.taxYear !== taxYear) return null;

  const owner = await rrcQueryOne<{
    owner_id: string;
    name: string;
    owner_type: string | null;
    owner2_name: string | null;
    address: string | null;
    addr1: string | null;
    addr2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  }>(
    `select owner_id, name, btrim(owner_type) as owner_type, owner2_name,
            address, addr1, addr2, city, state, zip, country
       from cad.mineral_owner
      where county_no = $1 and tax_year = $2 and owner_id = $3`,
    [cov.countyNo, cov.taxYear, ownerId]
  );
  if (!owner) return null;

  const { reported } = await getCycleEdge();
  const [interests, coOwners] = await Promise.all([
    rrcQuery<OwnerInterest>(
      `with mine as (
         select mi.cad_account, mi.oil_gas_code, mi.district_no, mi.lease_no,
                mi.interest::float8 as interest, btrim(mi.interest_type) as interest_type,
                mi.value_appraised, mi.acreage::float8 as acreage
           from cad.mineral_interest mi
          where mi.county_no = $1 and mi.tax_year = $2 and mi.owner_id = $3
       ),
       vol as (
         select lp.oil_gas_code, lp.district_no, lp.lease_no,
                coalesce(sum(lp.oil_prod_vol), 0)::bigint as oil_12mo,
                coalesce(sum(lp.gas_prod_vol), 0)::bigint as gas_12mo,
                count(distinct lp.cycle)::int as months
           from rrc.lease_production lp
           join (select distinct oil_gas_code, district_no, lease_no from mine) k
             on k.oil_gas_code = lp.oil_gas_code and k.district_no = lp.district_no
            and k.lease_no = lp.lease_no
          where lp.cycle >  to_date($4, 'YYYY-MM') - interval '12 months'
            and lp.cycle <= to_date($4, 'YYYY-MM')
          group by 1, 2, 3
       )
       select m.cad_account, m.oil_gas_code, m.district_no, m.lease_no,
              l.lease_name, l.operator_no, op.operator_name,
              m.interest, m.interest_type, m.value_appraised, m.acreage,
              coalesce(v.oil_12mo, 0) as oil_12mo,
              coalesce(v.gas_12mo, 0) as gas_12mo,
              coalesce(v.months, 0)   as months
         from mine m
         left join rrc.lease l
           on l.oil_gas_code = m.oil_gas_code and l.district_no = m.district_no
          and l.lease_no = m.lease_no
         left join rrc.operators op on op.operator_number = l.operator_no
         left join vol v
           on v.oil_gas_code = m.oil_gas_code and v.district_no = m.district_no
          and v.lease_no = m.lease_no
        order by m.value_appraised desc nulls last, m.interest desc, l.lease_name`,
      [cov.countyNo, cov.taxYear, ownerId, reported]
    ),
    rrcQuery<CoOwner>(
      `select o.owner_id, o.name, btrim(o.owner_type) as owner_type,
              count(distinct (t.oil_gas_code, t.district_no, t.lease_no))::int as shared_leases
         from cad.mineral_interest mine
         join cad.mineral_interest t
           on t.county_no = mine.county_no and t.tax_year = mine.tax_year
          and t.oil_gas_code = mine.oil_gas_code and t.district_no = mine.district_no
          and t.lease_no = mine.lease_no
          and t.owner_id <> mine.owner_id
         join cad.mineral_owner o
           on o.county_no = t.county_no and o.tax_year = t.tax_year
          and o.owner_id = t.owner_id
        where mine.county_no = $1 and mine.tax_year = $2 and mine.owner_id = $3
        group by o.owner_id, o.name, o.owner_type
        order by shared_leases desc, o.name
        limit 100`,
      [cov.countyNo, cov.taxYear, ownerId]
    ),
  ]);

  return {
    county_no: cov.countyNo,
    county_name: cov.name,
    tax_year: cov.taxYear,
    owner_id: owner.owner_id,
    name: owner.name,
    owner_type: owner.owner_type,
    owner2_name: owner.owner2_name,
    address: owner.address,
    addr1: owner.addr1,
    addr2: owner.addr2,
    city: owner.city,
    state: owner.state,
    zip: owner.zip,
    country: owner.country,
    interests: interests.map((r) => ({
      ...r,
      district_name: districtLabel(r.district_no),
    })),
    coOwners,
    reportedThrough: reported,
  };
}

// ------------------------------------------------------------- near a point

export interface OwnerNearby {
  county_no: string;
  tax_year: number;
  owner_id: string;
  name: string;
  owner_type: string | null;
  lease_count: number;
  /** Sum over their interests here of interest x the lease's last-12-month oil. */
  net_oil_12mo: number;
  net_gas_12mo: number;
  value_appraised: number;
}

/**
 * Who owns minerals under the wells near a point: Orion's "who owns around
 * here". The wells come from `findWells`' shape of query (well_location by
 * bounding box, then the great-circle trim), the leases from those wells'
 * on-schedule rows, the owners from the roll. Ranked by the owner's share of
 * the leases' last-12-month oil, which is the number a buyer asks for.
 *
 * Empty, not the whole roll, outside a covered county.
 */
export async function findOwnersNear(f: {
  lat: number;
  lon: number;
  radiusMi?: number;
  limit?: number;
}): Promise<OwnerNearby[]> {
  const radius = Math.min(50, Math.max(0.1, f.radiusMi ?? 5));
  const limit = Math.min(100, Math.max(1, Math.floor(f.limit ?? 25)));
  const dLat = radius / 69.0;
  const dLon = radius / (69.0 * Math.max(0.05, Math.cos((f.lat * Math.PI) / 180)));
  const dist = `(3958.7613 * acos(least(1, greatest(-1,
      sin(radians($1)) * sin(radians(l.lat)) +
      cos(radians($1)) * cos(radians(l.lat)) * cos(radians(l.lon) - radians($2))))))`;
  const { reported } = await getCycleEdge();
  return rrcQuery<OwnerNearby>(
    `with near as (
       select distinct wb.oil_gas_code, wb.district, wb.lease_number as lease_no
         from rrc.well_location l
         join rrc.wellbore wb on wb.api_number = l.api_number and wb.on_schedule = 'Y'
        where l.lat between $3 and $4 and l.lon between $5 and $6
          and ${dist} <= $7
     ),
     mine as (
       select mi.county_no, mi.tax_year, mi.owner_id,
              mi.oil_gas_code, mi.district_no, mi.lease_no,
              mi.interest::float8 as interest, mi.value_appraised
         from cad.mineral_interest mi
         join near n on n.oil_gas_code = mi.oil_gas_code and n.district = mi.district
                    and n.lease_no = mi.lease_no
     ),
     vol as (
       select lp.oil_gas_code, lp.district_no, lp.lease_no,
              coalesce(sum(lp.oil_prod_vol), 0)::float8 as oil,
              coalesce(sum(lp.gas_prod_vol), 0)::float8 as gas
         from rrc.lease_production lp
         join (select distinct oil_gas_code, district_no, lease_no from mine) k
           on k.oil_gas_code = lp.oil_gas_code and k.district_no = lp.district_no
          and k.lease_no = lp.lease_no
        where lp.cycle >  to_date($8, 'YYYY-MM') - interval '12 months'
          and lp.cycle <= to_date($8, 'YYYY-MM')
        group by 1, 2, 3
     )
     select m.county_no, m.tax_year, m.owner_id, o.name, btrim(o.owner_type) as owner_type,
            count(distinct (m.oil_gas_code, m.district_no, m.lease_no))::int as lease_count,
            round(sum(m.interest * coalesce(v.oil, 0)))::float8 as net_oil_12mo,
            round(sum(m.interest * coalesce(v.gas, 0)))::float8 as net_gas_12mo,
            coalesce(sum(m.value_appraised), 0)::bigint as value_appraised
       from mine m
       join cad.mineral_owner o
         on o.county_no = m.county_no and o.tax_year = m.tax_year and o.owner_id = m.owner_id
       left join vol v
         on v.oil_gas_code = m.oil_gas_code and v.district_no = m.district_no
        and v.lease_no = m.lease_no
      group by m.county_no, m.tax_year, m.owner_id, o.name, o.owner_type
      order by net_oil_12mo desc, value_appraised desc, o.name
      limit $9`,
    [f.lat, f.lon, f.lat - dLat, f.lat + dLat, f.lon - dLon, f.lon + dLon, radius, reported, limit]
  );
}

// ---------------------------------------------------------------- coverage

/** What the mirror says is loaded, for the check that holds `CAD_COUNTIES` to it. */
export async function getCadCoverage(): Promise<
  (CadCoverage & { interests: number; owners: number; leases: number; loaded_at: string })[]
> {
  const rows = await rrcQuery<{
    county_no: string;
    tax_year: number;
    county_name: string;
    interests: number;
    owners: number;
    leases: number;
    loaded_at: string;
  }>(
    `select county_no, tax_year, county_name, interests, owners, leases,
            to_char(loaded_at, 'YYYY-MM-DD') as loaded_at
       from cad.coverage order by county_no, tax_year`
  );
  return rows.map((r) => ({
    countyNo: r.county_no,
    name: r.county_name,
    taxYear: r.tax_year,
    interests: r.interests,
    owners: r.owners,
    leases: r.leases,
    loaded_at: r.loaded_at,
  }));
}
