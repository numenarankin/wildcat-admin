/**
 * Assembles the flat affiliation edge rows returned by Archon's graph RPCs into
 * the deduped { nodes, links } graph the Network canvas lays out. Operators and
 * people are nodes; affiliations are links.
 *
 * Pure (no fetching, no React) so it stays testable, and so `queries.ts` — a
 * `"use server"` module, which may only export async functions — can use it
 * without exporting it.
 *
 * Ported from archon `src/lib/wells/network.ts`; the row shape is what
 * archon's `20260623000200_operator_network.sql` RPCs return.
 */

import type { GraphData, GraphLink, GraphNode } from "@/lib/scout/graph-style";

/** One affiliation edge row as returned by the graph RPCs. */
export interface EdgeRow {
  src_person: string;
  operator_number: number;
  operator_name: string | null;
  officer_title: string | null;
  p5_status: string | null;
  op_wells: number;
  person_operators: number;
  hop: number;
}

/** Build a deduped node/link graph from a flat affiliation edge list. */
export function buildGraph(rows: EdgeRow[]): GraphData {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];

  for (const r of rows) {
    const personId = `p:${r.src_person}`;
    const opId = `o:${r.operator_number}`;

    if (!nodes.has(personId)) {
      nodes.set(personId, {
        id: personId,
        type: "person",
        label: r.src_person,
        name: r.src_person,
        weight: r.person_operators || 1,
        role: r.officer_title,
      });
    }
    if (!nodes.has(opId)) {
      nodes.set(opId, {
        id: opId,
        type: "operator",
        label: r.operator_name ?? `Operator #${r.operator_number}`,
        weight: r.op_wells || 0,
        status: r.p5_status,
        opNumber: r.operator_number,
      });
    }
    links.push({ source: personId, target: opId, title: r.officer_title, hop: r.hop });
  }

  return { nodes: [...nodes.values()], links };
}
