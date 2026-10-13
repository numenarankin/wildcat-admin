import "server-only";

/**
 * Scout's Network view queries, against the Tiger mirror.
 *
 * These used to reproduce Archon's three `network_*` RPCs in TypeScript over
 * PostgREST, because those RPCs are `security definer` and gated on an
 * entitlement a service-role caller can never hold. The mirror has no such
 * gate, so the same shapes are expressed as SQL again — one round trip each
 * instead of a paged fan-out, and the emitted `EdgeRow` stays identical so
 * `buildGraph` and the canvas renderer are unchanged.
 *
 * NO MATERIALIZED VIEWS HERE, deliberately. Archon precomputed
 * `mv_person_affiliations` (person -> operator count, summed wells) and
 * `mv_operator_well_counts`; the mirror has neither, and creating them on a
 * managed Timescale service is not this module's call. The shape below avoids
 * needing them: the candidate people are resolved from `operator_officers`
 * alone (184,725 rows, trigram- and operator-indexed), and wells are counted
 * only for the operators those people actually touch, through
 * `wellbore_op_idx`. A statewide well-count aggregate would be a 1.37M-row scan
 * on every graph load; this is a few thousand indexed lookups instead.
 *
 * WELL COUNTS ARE ON-SCHEDULE, matching the operator points and the operator
 * modal. An operator's graph weight is the fleet it runs now, not everything it
 * has ever been named on.
 */

import { rrcQuery } from "@/lib/scout/rrc-db";
import type { EdgeRow } from "@/lib/scout/graph-build";
import type { NetworkRole, SubgraphSeed, TopHub } from "@/lib/scout/types";

/** Role predicate over `officer_title`, mirroring the `p_role` branch. */
function roleClause(role: NetworkRole): string {
  if (role === "filing") return `and officer_title ilike '%filing%agent%'`;
  if (role === "agent") return `and officer_title ilike '%agent%'`;
  return "";
}

/**
 * A person's distinct operators, and the wells behind them.
 *
 * Wells are counted over DISTINCT `api_number` — `wellbore` is one row per
 * well x lease x field, so a plain count reads a person's fleet ~4% high.
 */
/**
 * A person's distinct operators, and the wells behind them.
 *
 * TWO-STAGE, and it has to be. Counting wells for every person on two or more
 * operators means joining tens of thousands of people to `wellbore` and blows
 * the 5 s statement timeout outright (measured). So the cheap half runs first —
 * `operator_officers` alone, 184,725 rows, no joins — the widest-spread
 * `$2` candidates are taken, and only their operators get counted, through
 * `wellbore_op_idx`.
 *
 * The cost of the shortcut: someone on few operators but a huge fleet can miss
 * the candidate cut, where Archon's precomputed view would have ranked them.
 * Keep `$2` a healthy multiple of the list length so the ranking that follows
 * has room to reorder.
 *
 * Wells are counted over DISTINCT `api_number` — `wellbore` is one row per
 * well x lease x field, so a plain count reads a person's fleet ~4% high — and
 * only on-schedule rows, matching the operator points and the operator modal.
 */
const PERSON_ROLLUP = `
  with candidates as (
    select officer_name,
           bool_or(officer_title ilike '%filing%agent%') as is_filing_agent,
           bool_or(officer_title ilike '%agent%')        as is_agent,
           count(distinct operator_number)::int          as operator_count
      from rrc.operator_officers
     where nullif(btrim(officer_name), '') is not null
       and operator_number is not null
       %ROLE%
     group by officer_name
    having count(distinct operator_number) >= $1
     order by count(distinct operator_number) desc, officer_name
     limit $2
  ),
  pairs as (
    select distinct c.officer_name, oo.operator_number
      from candidates c
      join rrc.operator_officers oo on oo.officer_name = c.officer_name
     where oo.operator_number is not null
  ),
  wells as (
    select pr.officer_name, count(distinct wb.api_number)::int as total_wells
      from pairs pr
      join rrc.wellbore wb
        on wb.operator_number = pr.operator_number and wb.on_schedule = 'Y'
     group by pr.officer_name
  )
  select c.officer_name, c.operator_count, c.is_filing_agent, c.is_agent,
         coalesce(w.total_wells, 0)::int as total_wells
    from candidates c
    left join wells w on w.officer_name = c.officer_name`;

/** Ranked hub list — the "biggest filing partners". */
export async function topHubs(
  role: NetworkRole,
  minOperators: number,
  limit: number
): Promise<TopHub[]> {
  return rrcQuery<TopHub>(
    `${PERSON_ROLLUP.replace("%ROLE%", roleClause(role))}
     order by total_wells desc, operator_count desc, officer_name
     limit $3`,
    [Math.max(1, minOperators), Math.max(limit * 8, 400), limit]
  );
}

/**
 * One row per (person, operator) with the facts an edge needs.
 *
 * Well counts come from ONE grouped pass over the operators actually in the
 * edge set, not a lateral subquery per row: as a lateral this ran a fresh
 * index scan for every edge and timed out on any seed with a few hundred of
 * them.
 */
const EDGE_SELECT = `
  , op_wells as (
    select wb.operator_number, count(distinct wb.api_number)::int as wells
      from rrc.wellbore wb
     where wb.operator_number in (select operator_number from edges)
       and wb.on_schedule = 'Y'
     group by wb.operator_number
  ),
  joined as (
    select e.officer_name                        as src_person,
           e.operator_number::int                as operator_number,
           o.operator_name,
           e.officer_title,
           o.p5_status,
           coalesce(w.wells, 0)::int             as op_wells,
           e.person_operators,
           e.hop
      from edges e
      join rrc.operators o on o.operator_number = e.operator_number
      left join op_wells w on w.operator_number = e.operator_number
  )`;

/**
 * Top hubs and the operators they connect.
 *
 * `join rrc.operators` is an inner join on purpose, matching the original: an
 * operator with no P-5 master row drops out rather than drawing a nameless node.
 */
export async function hubGraphEdges(
  role: NetworkRole,
  minOperators: number,
  hubLimit: number,
  minWells: number,
  perHub: number
): Promise<EdgeRow[]> {
  return rrcQuery<EdgeRow>(
    `with hubs as (
       ${PERSON_ROLLUP.replace("%ROLE%", roleClause(role))}
       order by total_wells desc, operator_count desc, officer_name
       limit $3
     ),
     edges as (
       select oo.officer_name        as officer_name,
              oo.operator_number     as operator_number,
              min(oo.officer_title)  as officer_title,
              max(h.operator_count)  as person_operators,
              0                      as hop
         from hubs h
         join rrc.operator_officers oo on oo.officer_name = h.officer_name
        where oo.operator_number is not null
        group by oo.officer_name, oo.operator_number
     )
     ${EDGE_SELECT},
     ranked as (
       select j.*,
              row_number() over (partition by src_person order by op_wells desc) as rn
         from joined j
        where j.op_wells >= $4
     )
     select src_person, operator_number, operator_name, officer_title, p5_status,
            op_wells, person_operators, hop
       from ranked
      where rn <= $5
      order by op_wells desc`,
    [
      Math.max(1, minOperators),
      Math.max(hubLimit * 8, 400),
      hubLimit,
      Math.max(0, minWells),
      perHub,
    ]
  );
}

/**
 * Focused subgraph around a person, an operator, or a county.
 *
 * Three seeds, unioned exactly as the original did:
 *   - person   -> everything that person is on (hop 0)
 *   - operator -> that operator's people (hop 0), then their OTHER operators (hop 1)
 *   - county   -> the people behind the county's 60 biggest operators (hop 0)
 *
 * The seed operator survives the well floor even when it is below it, so
 * seeding on a small operator never yields an empty graph.
 */
export async function subgraphEdges(
  seed: SubgraphSeed,
  minWells: number,
  edgeCap: number
): Promise<EdgeRow[]> {
  const person = seed.person ?? null;
  const operator =
    seed.operator == null ? null : String(seed.operator).padStart(6, "0");
  const county =
    seed.county == null
      ? null
      : String(seed.county).replace(/\D/g, "").padStart(3, "0");

  if (!person && !operator && !county) return [];

  return rrcQuery<EdgeRow>(
    `with person_star as (
       select oo.officer_name, oo.operator_number, min(oo.officer_title) as officer_title, 0 as hop
         from rrc.operator_officers oo
        where $1::text is not null and oo.officer_name = $1 and oo.operator_number is not null
        group by oo.officer_name, oo.operator_number
     ),
     op_people as (
       select oo.officer_name, $2::bpchar as operator_number,
              min(oo.officer_title) as officer_title, 0 as hop
         from rrc.operator_officers oo
        where $2::text is not null and oo.operator_number = $2
          and nullif(btrim(oo.officer_name), '') is not null
        group by oo.officer_name
     ),
     op_expand as (
       select oo.officer_name, oo.operator_number, min(oo.officer_title) as officer_title, 1 as hop
         from rrc.operator_officers oo
        where $2::text is not null
          and oo.officer_name in (select officer_name from op_people)
          and oo.operator_number <> $2 and oo.operator_number is not null
        group by oo.officer_name, oo.operator_number
     ),
     county_ops as (
       select wb.operator_number, count(distinct wb.api_number)::int as wells
         from rrc.wellbore wb
        where $3::text is not null
          and wb.api_number between $3 || '00000' and $3 || '99999'
          and wb.on_schedule = 'Y' and wb.operator_number is not null
        group by wb.operator_number
        order by wells desc
        limit 60
     ),
     county_people as (
       select oo.officer_name, oo.operator_number, min(oo.officer_title) as officer_title, 0 as hop
         from county_ops c
         join rrc.operator_officers oo on oo.operator_number = c.operator_number
        where nullif(btrim(oo.officer_name), '') is not null
        group by oo.officer_name, oo.operator_number
     ),
     all_edges as (
       select * from person_star
       union all select * from op_people
       union all select * from op_expand
       union all select * from county_people
     ),
     person_counts as (
       select oo.officer_name, count(distinct oo.operator_number)::int as person_operators
         from rrc.operator_officers oo
        where oo.officer_name in (select officer_name from all_edges)
          and oo.operator_number is not null
        group by oo.officer_name
     ),
     edges as (
       select a.officer_name, a.operator_number, min(a.officer_title) as officer_title,
              min(a.hop) as hop,
              coalesce(max(pc.person_operators), 0) as person_operators
         from all_edges a
         left join person_counts pc on pc.officer_name = a.officer_name
        group by a.officer_name, a.operator_number
     )
     ${EDGE_SELECT}
     select src_person, operator_number, operator_name, officer_title, p5_status,
            op_wells, person_operators, hop
       from joined
      -- the seed operator stays even below the floor, so seeding never empties
      where op_wells >= $4 or operator_number = nullif($2, '')::int
      order by hop, op_wells desc
      limit $5`,
    [person, operator, county, Math.max(0, minWells), edgeCap]
  );
}
