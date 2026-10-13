import { renderCatalog, type CatalogTool } from "@/lib/ai/catalog-tool";
import { TOOLS as anomaly } from "./tools/anomaly";
import { TOOLS as integrity } from "./tools/integrity";
import { TOOLS as series } from "./tools/series";

/**
 * Every company analysis tool.
 *
 * Grouped by file, so a new tool is admitted by adding it to its module and
 * nothing else. There is no second list to keep in step, which is the failure
 * the geology catalog's generated build exists to prevent.
 */
const GROUPS: { label: string; tools: CatalogTool[] }[] = [
  { label: "ranking, comparison and trend", tools: series },
  { label: "revenue integrity", tools: integrity },
  { label: "anomalies and the standing brief", tools: anomaly },
];

export const COMPANY_TOOLS: readonly CatalogTool[] = GROUPS.flatMap((g) => g.tools);

const BY_NAME = new Map(COMPANY_TOOLS.map((t) => [t.name, t]));

export function findCompanyTool(name: string): CatalogTool | undefined {
  return BY_NAME.get(name);
}

export function companyToolNames(): string[] {
  return [...BY_NAME.keys()];
}

/** The catalog block that goes in the system prompt. */
export const COMPANY_CATALOG: string = renderCatalog(GROUPS);
