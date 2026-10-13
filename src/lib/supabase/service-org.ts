import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which org a SERVICE-ROLE client is acting for.
 *
 * A request-scoped client carries its org in the caller's JWT, so every read
 * below it resolves the org on its own. A service-role client carries no user at
 * all: `current_org_id()` is null inside the reading functions
 * (`2026081700500`), which returned nothing rather than erroring, and the cron
 * digests were assembled from no tank gauges and no meter readings.
 *
 * The org is known at the top of those paths (`ProductionScope.orgId`) and
 * needed several layers down, inside loaders that only ever receive a client. So
 * it is registered against the CLIENT OBJECT — the same key the request memo
 * cache scopes on — instead of being threaded through every signature between
 * the two.
 *
 * A WeakMap, so a client that goes out of scope takes its entry with it and a
 * cron looping orgs cannot accumulate them.
 *
 * NOT marked `server-only`, deliberately: `@/lib/meters/meters` reads it and is
 * imported by client components (the well gas-test modal reaches it through
 * `@/lib/wells/well-tests`), so a server-only guard here fails the build. There
 * is nothing to protect — the map is empty in a browser bundle, and a client can
 * only ever get null out of it.
 */
const orgByClient = new WeakMap<object, string>();

/** Record that `client` is a service-role client acting for `orgId`. */
export function markServiceScope(client: SupabaseClient, orgId: string): void {
  if (orgId) orgByClient.set(client, orgId);
}

/**
 * The org a service-role client was marked for, or null for an ordinary
 * request-scoped client (which resolves its own org and must not be handed one).
 */
export function serviceOrgFor(client: object): string | null {
  return orgByClient.get(client) ?? null;
}
