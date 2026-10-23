import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";

/**
 * Read-only SQL over the whole database for the admin Orion, through the
 * `orion_read_query` RPC (wildcat migration `2026102300200_orion_db_read.sql`).
 * The RPC runs as `orion_reader`: SELECT on every table, every row (RLS
 * bypassed), in a READ ONLY transaction, with credentials and taxpayer ids
 * withheld at the column grant. Service role only, so every call here starts
 * at the platform-admin gate.
 *
 * Two size limits, both refusals and never a partial result, so a count or a
 * total is never computed over rows that were silently dropped:
 *   MAX_ROWS          rows in one result
 *   MAX_RESULT_CHARS  characters of JSON handed back to the model
 */
export const MAX_ROWS = 2_000;
export const MAX_RESULT_CHARS = 200_000;

export type ReadResult =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number }
  | { ok: false; error: string };

/** A SQL string literal. */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function runReadQuery(sql: string): Promise<ReadResult> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const { data, error } = await getSupabaseAdmin().rpc("orion_read_query", { p_sql: sql, p_max_rows: MAX_ROWS });
  if (error) return { ok: false, error: error.message };
  const out = data as { rows?: Record<string, unknown>[]; rowCount?: number; error?: string } | null;
  if (out?.error === "too_many_rows") {
    return {
      ok: false,
      error: `More than ${MAX_ROWS} rows. Aggregate in SQL (count, sum, group by) or narrow with WHERE; nothing was returned.`,
    };
  }
  const rows = out?.rows ?? [];
  const chars = JSON.stringify(rows).length;
  if (chars > MAX_RESULT_CHARS) {
    return {
      ok: false,
      error: `${rows.length} rows came to ${chars} characters, over the ${MAX_RESULT_CHARS} limit. Select fewer columns, aggregate, or narrow with WHERE; nothing was returned.`,
    };
  }
  return { ok: true, rows, rowCount: out?.rowCount ?? rows.length };
}

/** Readable relations, partitions folded into their parent. */
const READABLE = `
  c.relkind in ('r', 'p', 'v', 'm', 'f')
  and not c.relispartition
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname !~ '^pg_'
  and has_schema_privilege(n.oid, 'USAGE')
  and (
    has_table_privilege(c.oid, 'SELECT')
    or exists (
      select 1 from pg_attribute a
       where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         and has_column_privilege(c.oid, a.attnum, 'SELECT')
    )
  )`;

/**
 * Every table and view Orion can read: schema, name, kind, Postgres's row
 * estimate (from the last analyze; use count(*) for an exact figure) and the
 * table comment. `search` matches the table name, its comment, or any of its
 * column names.
 */
export function listTables(opts: { schema?: string; search?: string }): Promise<ReadResult> {
  const filters: string[] = [];
  if (opts.schema) filters.push(`n.nspname = ${lit(opts.schema)}`);
  if (opts.search) {
    const p = lit(`%${opts.search}%`);
    filters.push(`(
      c.relname ilike ${p}
      or obj_description(c.oid, 'pg_class') ilike ${p}
      or exists (
        select 1 from pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attname ilike ${p}
      )
    )`);
  }
  return runReadQuery(`
    select n.nspname as schema,
           c.relname as name,
           case c.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end as kind,
           greatest(c.reltuples, 0)::bigint as approx_rows,
           obj_description(c.oid, 'pg_class') as comment
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where ${READABLE}
       ${filters.map((f) => `and ${f}`).join("\n")}
     order by 1, 2`);
}

/**
 * One table: its readable columns (type, nullable, default, comment), primary
 * key, the foreign keys it holds and the ones that point at it. `table` is
 * `schema.name`, or a bare name in public.
 */
export async function describeTable(table: string) {
  const rel = `to_regclass(${lit(table)})`;
  const [exists, columns, constraints, referencedBy] = await Promise.all([
    runReadQuery(`select ${rel}::text as name, obj_description(${rel}, 'pg_class') as comment,
                         greatest((select reltuples from pg_class where oid = ${rel}), 0)::bigint as approx_rows`),
    runReadQuery(`
      select a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             not a.attnotnull as nullable,
             pg_get_expr(d.adbin, d.adrelid) as "default",
             col_description(a.attrelid, a.attnum) as comment
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = ${rel} and a.attnum > 0 and not a.attisdropped
         and has_column_privilege(a.attrelid, a.attnum, 'SELECT')
       order by a.attnum`),
    runReadQuery(`
      select conname as name,
             case contype when 'p' then 'primary key' when 'f' then 'foreign key' when 'u' then 'unique' else 'check' end as kind,
             pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = ${rel} and contype in ('p', 'f', 'u', 'c')
       order by contype, conname`),
    runReadQuery(`
      select conrelid::regclass::text as from_table, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where confrelid = ${rel} and contype = 'f'
       order by 1`),
  ]);
  const first = exists.ok ? exists.rows[0] : undefined;
  if (!first?.name) return { ok: false as const, error: `No table or view named ${table}.` };
  if (!columns.ok) return columns;
  return {
    ok: true as const,
    table: first.name,
    comment: first.comment ?? null,
    approxRows: first.approx_rows,
    columns: columns.rows,
    constraints: constraints.ok ? constraints.rows : [],
    referencedBy: referencedBy.ok ? referencedBy.rows : [],
  };
}

/** Readable columns whose name matches, across every table: where a field lives. */
export function searchColumns(pattern: string): Promise<ReadResult> {
  return runReadQuery(`
    select n.nspname as schema, c.relname as "table", a.attname as "column",
           format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where ${READABLE}
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege(c.oid, a.attnum, 'SELECT')
       and a.attname ilike ${lit(`%${pattern}%`)}
     order by 1, 2, 3`);
}
