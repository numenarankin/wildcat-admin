/**
 * The RRC analysis catalog's tool shape.
 *
 * The mechanics are shared with the company catalog and live in
 * `@/lib/ai/catalog-tool`; this module keeps the RRC-facing names so the ~120
 * tools under `./tools/` and the geology bridge need no edit. `RrcTool` and
 * `CatalogTool` are the same type.
 */
export {
  defineTool,
  shortType,
  signature,
  catalogLine,
  type CatalogTool,
  type CatalogTool as RrcTool,
} from "@/lib/ai/catalog-tool";
