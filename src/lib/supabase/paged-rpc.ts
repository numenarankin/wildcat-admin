import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read every row of a set-returning RPC, all pages in TWO round trips.
 *
 * PostgREST caps a response at 1,000 rows and applies that to a function's
 * rows too, so the bulk readers page. They paged SERIALLY: fetch, see a full
 * page, fetch the next, and so on. On a fleet with 1,800 meter readings that
 * was two round trips one after the other; on an operator with years of
 * history it is N, each a full network wait, and the waterfall showed the
 * second page of one read starting alone after every other wave had landed.
 *
 * The first request asks for `count: "exact"`, which PostgREST returns in
 * `Content-Range` for the whole result, so the number of remaining pages is
 * known after page one and they are all issued at once. Row order is preserved
 * by assembling pages in offset order, so callers that rely on the function's
 * `ORDER BY` see exactly what the serial loop gave them.
 *
 * `page` is the cap PostgREST enforces, not a tuning knob: asking for more per
 * request just returns the cap.
 *
 * Callers with an id list also pass `chunkKey` so the read is split across
 * concurrent calls small enough to fit under the cap in one go (see `opts`).
 * Rows from chunks are concatenated in chunk order; a caller that needs a
 * global order must not rely on the function's `ORDER BY` across chunks and
 * every current caller groups by id first, which is order-independent.
 */
export async function rpcAllRows<Row>(
  sb: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  opts: {
    /**
     * Split `args[chunkKey]` (an id list) into concurrent calls of at most
     * `chunkSize` ids. With a per-node history of a few months, eight nodes
     * fit under the 1,000-row cap, so the whole read is ONE wave; a chunk that
     * still overflows pages within itself, so nothing is ever lost, it just
     * costs that chunk a second round trip. Without chunking, page two of a
     * single big call can only start once page one has returned its count,
     * which the waterfall showed as a lone read starting after every other
     * wave had finished.
     */
    chunkKey?: string;
    chunkSize?: number;
    page?: number;
  } = {}
): Promise<{ rows: Row[]; error: { message: string; code?: string } | null }> {
  const page = opts.page ?? 1000;
  const ids = opts.chunkKey ? (args[opts.chunkKey] as unknown[] | undefined) : undefined;
  if (!opts.chunkKey || !Array.isArray(ids) || ids.length <= (opts.chunkSize ?? 8)) {
    return rpcAllPages<Row>(sb, fn, args, page);
  }
  const size = opts.chunkSize ?? 8;
  const chunks: unknown[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const results = await Promise.all(
    chunks.map((chunk) => rpcAllPages<Row>(sb, fn, { ...args, [opts.chunkKey!]: chunk }, page))
  );
  const rows: Row[] = [];
  for (const r of results) {
    if (r.error) return { rows: [], error: r.error };
    rows.push(...r.rows);
  }
  return { rows, error: null };
}

/** One call's pages: the first with a count, the rest together. */
async function rpcAllPages<Row>(
  sb: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  page: number
): Promise<{ rows: Row[]; error: { message: string; code?: string } | null }> {
  const first = await sb.rpc(fn, args, { count: "exact" }).range(0, page - 1);
  if (first.error) return { rows: [], error: first.error };
  const rows = (first.data ?? []) as Row[];
  const total = first.count ?? rows.length;
  if (total <= rows.length) return { rows, error: null };

  const offsets: number[] = [];
  for (let from = rows.length; from < total; from += page) offsets.push(from);
  const rest = await Promise.all(
    offsets.map((from) => sb.rpc(fn, args).range(from, from + page - 1))
  );
  for (const r of rest) {
    if (r.error) return { rows: [], error: r.error };
    rows.push(...((r.data ?? []) as Row[]));
  }
  return { rows, error: null };
}
