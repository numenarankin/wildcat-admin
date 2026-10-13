/**
 * Postgres/PostgREST error shapes worth branching on.
 *
 * Reads that call an RPC need to survive the window between a deploy and its
 * `supabase db push`, so they ask "is this database simply missing the
 * function?" before falling back to a slower query that needs no migration.
 */

/** PostgREST/Postgres for "that function does not exist here". */
export function isMissingFunction(error: {
  code?: string;
  message?: string;
}): boolean {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /could not find the function|does not exist/i.test(error.message ?? "")
  );
}
