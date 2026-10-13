// Pure styling/layout helpers for the Network view graph. No React, no DOM, no
// data fetching, so it stays trivially testable. The renderer (network-graph)
// and the query layer (network.ts) both build on these types.
import { scaleSqrt } from "d3-scale";

export type NodeType = "operator" | "person";

export interface GraphNode {
  id: string; // "o:<operator_number>" | "p:<officer_name>"
  type: NodeType;
  label: string;
  /** Operators: wells operated. People: distinct operators connected (degree). */
  weight: number;
  status?: string | null; // operators: P-5 status (A/I/D/S)
  role?: string | null; // people: officer_title family (filing agent, etc.)
  opNumber?: number; // operators only
  name?: string; // people only (raw officer_name, the principal key)
  // Mutated in place by the d3-force simulation:
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  title?: string | null;
  hop: number; // 0 = directly on a seed/hub, 1 = expansion
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export type ColorMode = "type" | "status" | "role";

// Node radius. Square-root scale keeps the AREA proportional to the weight so a
// 5000-well operator does not visually swamp a 50-well one. Operators and people
// use separate domains because their weights mean different things.
const operatorRadius = scaleSqrt().domain([1, 5000]).range([3.5, 26]).clamp(true);
const personRadius = scaleSqrt().domain([1, 200]).range([3.5, 24]).clamp(true);

export function radiusFor(n: GraphNode): number {
  const w = Math.max(1, n.weight);
  return n.type === "operator" ? operatorRadius(w) : personRadius(w);
}

// App-light-theme palette (not the screenshot's neon).
const COLORS = {
  operator: "#2563eb", // blue
  person: "#7c3aed", // violet
  statusActive: "#16a34a",
  statusInactive: "#9ca3af",
  statusDelinquent: "#dc2626",
  statusOther: "#a78bfa",
  roleFiling: "#7c3aed",
  roleAgent: "#0d9488",
  roleOfficer: "#475569",
  muted: "#cbd5e1",
};

function isFilingAgent(role?: string | null): boolean {
  return !!role && /filing/i.test(role);
}
function isAgent(role?: string | null): boolean {
  return !!role && /agent/i.test(role);
}

export function colorFor(n: GraphNode, mode: ColorMode): string {
  if (mode === "status") {
    if (n.type !== "operator") return COLORS.person;
    switch (n.status) {
      case "A":
        return COLORS.statusActive;
      case "I":
        return COLORS.statusInactive;
      case "D":
        return COLORS.statusDelinquent;
      default:
        return COLORS.statusOther;
    }
  }
  if (mode === "role") {
    if (n.type !== "person") return COLORS.operator;
    if (isFilingAgent(n.role)) return COLORS.roleFiling;
    if (isAgent(n.role)) return COLORS.roleAgent;
    return COLORS.roleOfficer;
  }
  // mode === "type"
  return n.type === "operator" ? COLORS.operator : COLORS.person;
}

export const LINK_COLOR = COLORS.muted;

// Hubs (people) and big operators get labels; the rest only label when zoomed in
// so the canvas stays readable. degreeOrWeight tunes the threshold per type.
export function labelVisible(n: GraphNode, zoom: number): boolean {
  if (n.type === "person") return n.weight >= 8 || zoom > 1.6;
  return n.weight >= 200 || zoom > 2.2;
}
