import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { describeRrcTable, listRrcTables, RRC_QUERY_TIMEOUT_MS, runRrcQuery } from "@/lib/admin/rrc-read";
import { MAX_RESULT_CHARS, MAX_ROWS } from "@/lib/admin/db-read";

/**
 * Free read-only SQL over the whole Texas RRC mirror, beside the fixed RRC
 * tools: those answer the questions they were built for; these answer the
 * rest. Read-only by construction (`rrc-read.ts`).
 */
export function rrcSqlTools() {
  return {
    rrc_tables: tool({
      description:
        "List the tables and views in the Texas RRC mirror (schemas rrc, cad, wildcat, public) with estimated row counts and comments. search matches a table's name, comment or any column name. Start here for an RRC question the rrc_* tools do not answer, then rrc_describe.",
      inputSchema: z.object({
        schema: z.string().optional().describe("only this schema, e.g. rrc"),
        search: z.string().optional(),
      }),
      execute: async ({ schema, search } = {}) => ({ tables: await listRrcTables({ schema, search }) }),
    }),
    rrc_describe: tool({
      description:
        "One RRC mirror table or view: its columns (type, nullable, comment) and its indexes. The big tables (leases, production, wells) are tens of millions of rows: filter on an indexed column or the query is stopped. Describe a table before querying it.",
      inputSchema: z.object({ table: z.string().min(1).describe("schema.table, or a bare name in rrc") }),
      execute: async ({ table }) => describeRrcTable(table),
    }),
    rrc_query: tool({
      description:
        `Run ONE read-only SELECT (or WITH ... SELECT) against the Texas RRC mirror. Up to ${MAX_ROWS} rows and ${MAX_RESULT_CHARS} characters, refused (never cut) when over; stopped after ${RRC_QUERY_TIMEOUT_MS / 1000} s. Compute totals, counts and rankings in SQL. No ';' inside the query. Prefer the rrc_* tools when one fits: they carry the record's rules (district coding, the reporting lag, lease-level oil); here you apply them yourself.`,
      inputSchema: z.object({ sql: z.string().min(1) }),
      execute: async ({ sql }) => runRrcQuery(sql),
    }),
  };
}
