import type { SupabaseClient } from "@supabase/supabase-js";

import { getTank } from "@/lib/tanks/tanks";
import { getMeter } from "@/lib/meters/meters";

/**
 * Name the tank or meter a comment notification is about, the way every other
 * surface names it.
 *
 * A tank and a meter have no stored name: a tank is its effective lease plus
 * `tank_no` ("Roach T123") and a meter its lease plus `meter_no`
 * ("Dofflemeyer M1234"), derived at read time (`lib/tanks/tank-name.ts`,
 * `lib/meters/meter-name.ts`; the columns were retired in 2026081600200 and
 * 2026081600300).
 *
 * The comment trigger cannot do that. It resolves `entity_name` with a plain
 * `select name from tanks`, which is the retired column, so a notification about
 * a tank created since that migration falls through to the raw uuid: "New
 * comment on 0f2c7a10-1111-...". Older rows show the stale free-text name the
 * derivation exists to kill.
 *
 * So the flow derives it on the way out, at each of the three points a stored
 * row becomes something a person reads: the delivery webhook (email and push),
 * the bell's server seed, and the live toast. `getTank`/`getMeter` are the same
 * loaders the tanks and meters pages use, so the name can never disagree with
 * the page the notification links to.
 *
 * Plain module (no `server-only`): the toast hydrates in the browser with the
 * user's own RLS client.
 */

/** Payload keys the comment types carry. */
interface FacilityPayload {
  entity_type?: unknown;
  entity_id?: unknown;
  entity_name?: unknown;
}

/**
 * Whether this payload names a facility whose name is derived rather than
 * stored. Sync, so a caller can skip the round trip for everything else — which
 * is every notification except a comment, reply, mention or like on a tank or a
 * meter. Wells, leases and batteries keep a real `name` column.
 */
export function needsDerivedName(payload: Record<string, unknown>): boolean {
  const p = payload as FacilityPayload;
  const type = typeof p.entity_type === "string" ? p.entity_type : "";
  return (type === "tank" || type === "meter") && Boolean(p.entity_id);
}

/**
 * Return `payload` with `entity_name` derived, or the payload untouched.
 *
 * Never throws and never empties the name: a row that has been deleted, or a
 * read RLS refuses, leaves whatever the trigger wrote. A notification with a
 * stale name is worth more than one that fails to render.
 */
export async function withDerivedFacilityName(
  sb: SupabaseClient,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!needsDerivedName(payload)) return payload;
  const p = payload as FacilityPayload;
  const id = String(p.entity_id);

  try {
    const name =
      p.entity_type === "tank"
        ? (await getTank(sb, id))?.name
        : (await getMeter(sb, id))?.name;
    return name ? { ...payload, entity_name: name } : payload;
  } catch (error) {
    console.error("withDerivedFacilityName failed", error);
    return payload;
  }
}
