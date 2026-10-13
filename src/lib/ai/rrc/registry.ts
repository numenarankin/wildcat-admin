import { catalogLine, type RrcTool } from "./tool";
import { TOOLS as advanced } from "./tools/advanced";
import { TOOLS as geology } from "./tools/geology";
import { TOOLS as intel } from "./tools/intel";
import { TOOLS as operator } from "./tools/operator";
import { TOOLS as people } from "./tools/people";
import { TOOLS as production } from "./tools/production";
import { TOOLS as recompletion } from "./tools/recompletion";
import { TOOLS as screen } from "./tools/screen";
import { TOOLS as screening } from "./tools/screening";
import { TOOLS as series } from "./tools/series";
import { TOOLS as spatial } from "./tools/spatial";
import { TOOLS as trust } from "./tools/trust";
import { TOOLS as water } from "./tools/water";
import { TOOLS as wells } from "./tools/wells";

/**
 * Every RRC analysis tool, in the order a question tends to need them.
 *
 * Grouped by file rather than by a group letter: the file IS the group, so a new
 * tool is admitted by adding it to its module and nothing else. There is no
 * second list to keep in step, which is the failure the geology catalog's
 * generated build exists to prevent.
 */
const GROUPS: { label: string; tools: RrcTool[] }[] = [
  // First on purpose. Everything below it analyses a population, and until this
  // existed the only way to get one was the nearest hundred wells to a point,
  // so a question about the state was answered from a circle. A model reads a
  // catalog top down; the tool that decides WHICH WELLS has to be there.
  { label: "which wells: the population screen, before any analysis", tools: screen },
  { label: "series and decline", tools: series },
  { label: "wells, allocation and tests", tools: wells },
  { label: "water, injection and pressure", tools: water },
  { label: "location and infrastructure", tools: spatial },
  { label: "operators and aggregation", tools: operator },
  { label: "people and principals", tools: people },
  { label: "acquisition screening", tools: screening },
  { label: "competitive intelligence", tools: intel },
  { label: "production limits and waste", tools: production },
  { label: "geology and the offset population", tools: geology },
  { label: "uphole recompletion", tools: recompletion },
  { label: "advanced analysis", tools: advanced },
  { label: "provenance and coverage", tools: trust },
];

export const RRC_TOOLS: readonly RrcTool[] = GROUPS.flatMap((g) => g.tools);

const BY_NAME = new Map(RRC_TOOLS.map((t) => [t.name, t]));

export function findRrcTool(name: string): RrcTool | undefined {
  return BY_NAME.get(name);
}

export function rrcToolNames(): string[] {
  return [...BY_NAME.keys()];
}

/**
 * The catalog block that goes in the system prompt.
 *
 * One line per tool, grouped with a heading, built once at module load. This is
 * the entire description the model gets, which is why every summary has to say
 * what the tool answers rather than how it works.
 */
export const RRC_CATALOG: string = GROUPS.filter((g) => g.tools.length > 0)
  .map((g) => `# ${g.label}\n${g.tools.map(catalogLine).join("\n")}`)
  .join("\n\n");
