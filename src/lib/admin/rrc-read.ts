import "server-only";
import type { QueryConfig } from "pg";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getRrcPool } from "@/lib/scout/rrc-db";
import { MAX_RESULT_CHARS, MAX_ROWS, type ReadResult } from "@/lib/admin/db-read";

/**
 * Read-only SQL over the whole Texas RRC mirror (the separate Postgres behind
 * Recon, `RRC_DATABASE_URL`), for the admin Orion: the database tools'
 * analogue for the RRC record, which the fixed RRC tools only reach through
 * set questions.
 *
 * The mirror's connection user can write, so read-only is enforced here:
 *   1. one statement only, twice over: a `;` anywhere but the end is refused
 *      before anything runs, and the query goes over Postgres's extended
 *      protocol, which takes exactly one statement. A second statement is the
 *      one way past the next two layers (`...; commit; delete ...` ends the
 *      read-only transaction itself), so it is shut at both ends;
 *   2. the statement runs wrapped as `select * from (<sql>) q limit N`, which
 *      only parses for a query that returns rows;
 *   3. inside a READ ONLY transaction that is always rolled back.
 * A statement timeout stops an unindexed scan of the big tables (the lease
 * table alone is tens of millions of rows) from holding a connection the
 * Recon pages share. Size limits are db_query's: refused, never truncated.
 */

/** How long one query may run. */
export const RRC_QUERY_TIMEOUT_MS = 20_000;
const SCHEMAS = ["rrc", "cad", "wildcat", "public"];

/** The statement, or why it is refused. Pure, so the guard has its own tests. */
export function prepareRrcSql(sql: string): { ok: true; text: string } | { ok: false; error: string } {
  const body = sql.trim().replace(/;\s*$/, "").trim();
  if (!body) return { ok: false, error: "Empty query." };
  if (body.includes(";")) {
    return { ok: false, error: "One statement only: remove every ';' (a ';' inside a string literal is refused too; use chr(59))." };
  }
  // The newline keeps a trailing `-- comment` from swallowing the wrapper's closing paren.
  return { ok: true, text: `select * from (\n${body}\n) as orion_q limit ${MAX_ROWS + 1}` };
}

type Row = Record<string, unknown>;

async function readOnly(text: string, params: unknown[] = []): Promise<Row[]> {
  const client = await getRrcPool().connect();
  try {
    await client.query("begin read only");
    await client.query(`set local statement_timeout = ${RRC_QUERY_TIMEOUT_MS}`);
    // Extended protocol: one statement, however the text was built. `queryMode`
    // is honoured by pg at runtime but missing from its type definitions.
    const config = { text, values: params, queryMode: "extended" } as QueryConfig;
    const res = await client.query<Row>(config);
    return res.rows;
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function gate() {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

export async function runRrcQuery(sql: string): Promise<ReadResult> {
  await gate();
  const prepared = prepareRrcSql(sql);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  let rows: Row[];
  try {
    rows = await readOnly(prepared.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/statement timeout/i.test(message)) {
      return {
        ok: false,
        error: `Ran past ${RRC_QUERY_TIMEOUT_MS / 1000} s and was stopped. Filter on indexed columns (rrc_describe lists each table's indexes), aggregate, or narrow the date range; nothing was returned.`,
      };
    }
    return { ok: false, error: message };
  }
  if (rows.length > MAX_ROWS) {
    return {
      ok: false,
      error: `More than ${MAX_ROWS} rows. Aggregate in SQL (count, sum, group by) or narrow with WHERE; nothing was returned.`,
    };
  }
  const chars = JSON.stringify(rows).length;
  if (chars > MAX_RESULT_CHARS) {
    return {
      ok: false,
      error: `${rows.length} rows came to ${chars} characters, over the ${MAX_RESULT_CHARS} limit. Select fewer columns, aggregate, or narrow with WHERE; nothing was returned.`,
    };
  }
  return { ok: true, rows, rowCount: rows.length };
}

/** Tables, views and materialized views in the mirror, partitions folded into their parent. */
export async function listRrcTables(opts: { schema?: string; search?: string } = {}): Promise<Row[]> {
  await gate();
  const schemas = opts.schema ? [opts.schema] : SCHEMAS;
  return readOnly(
    `select n.nspname as schema, c.relname as name,
            case c.relkind when 'r' then 'table' when 'p' then 'table (partitioned)' when 'v' then 'view'
                           when 'm' then 'materialized view' when 'f' then 'foreign table' end as kind,
            case when c.relkind = 'p'
                 then (select coalesce(sum(greatest(ch.reltuples, 0)), 0)::bigint
                         from pg_inherits i join pg_class ch on ch.oid = i.inhrelid where i.inhparent = c.oid)
                 else greatest(c.reltuples, 0)::bigint end as estimated_rows,
            obj_description(c.oid, 'pg_class') as comment
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
        and n.nspname = any($1)
        and ($2::text is null
             or c.relname ilike '%' || $2 || '%'
             or obj_description(c.oid, 'pg_class') ilike '%' || $2 || '%'
             or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0
                          and not a.attisdropped and a.attname ilike '%' || $2 || '%'))
      order by 1, 2`,
    [schemas, opts.search?.trim() || null],
  );
}

/** One relation: columns with types and comments, its primary key and its indexes (what a fast query filters on). */
export async function describeRrcTable(name: string): Promise<{ columns: Row[]; indexes: Row[] } | { error: string }> {
  await gate();
  const [schema, table] = name.includes(".") ? name.split(".", 2) : ["rrc", name];
  const columns = await readOnly(
    `select a.attname as column, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
            col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [schema.replace(/"/g, ""), table.replace(/"/g, "")],
  );
  if (columns.length === 0) return { error: `No table ${schema}.${table} in the RRC mirror; rrc_tables lists them.` };
  const indexes = await readOnly(
    `select i.relname as index, pg_get_indexdef(i.oid) as definition, x.indisprimary as primary_key
       from pg_index x
       join pg_class c on c.oid = x.indrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class i on i.oid = x.indexrelid
      where n.nspname = $1 and c.relname = $2
      order by x.indisprimary desc, i.relname`,
    [schema.replace(/"/g, ""), table.replace(/"/g, "")],
  );
  return { columns, indexes };
}
