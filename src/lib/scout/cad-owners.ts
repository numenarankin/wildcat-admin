/**
 * Browser-side reads of mineral owners, over `/api/scout/cad/owners`.
 *
 * Everything about an owner on /scout comes through here -- the picker's
 * search, the owner panel, and the owner dossier -- the same way `rrc-people.ts`
 * serves a person, and for the same reason: three views of one answer must
 * agree by construction. The map itself does not read an owner's wells here;
 * it asks the focus query with the owner's key (`FocusOpts.owner`), so the
 * dots and the panel come from one roll.
 */

import type { OwnerDossier, OwnerMatch } from "@/lib/scout/rrc-types";

export type { OwnerDossier, OwnerMatch };

/** The key of one owner on one county's roll for one tax year. */
export interface OwnerKey {
  county_no: string;
  tax_year: number;
  owner_id: string;
}

export function ownerPath(k: OwnerKey): string {
  return `${k.county_no}/${k.tax_year}/${encodeURIComponent(k.owner_id)}`;
}

/** Same owner, whichever object carries the key. */
export function sameOwner(a: OwnerKey | null, b: OwnerKey | null): boolean {
  return (
    a != null &&
    b != null &&
    a.county_no === b.county_no &&
    a.tax_year === b.tax_year &&
    a.owner_id === b.owner_id
  );
}

/**
 * key -> dossier, cached as the in-flight promise: the panel and the dossier
 * mount on the same pick, and a roll changes once a year.
 */
const dossiers = new Map<string, Promise<OwnerDossier>>();

async function fetchOwner(k: OwnerKey): Promise<OwnerDossier> {
  const r = await fetch(`/api/scout/cad/owners/${ownerPath(k)}`);
  if (!r.ok) throw new Error(`owner lookup failed: ${r.status}`);
  return (await r.json()) as OwnerDossier;
}

export function getOwner(k: OwnerKey): Promise<OwnerDossier> {
  const key = ownerPath(k);
  const hit = dossiers.get(key);
  if (hit) return hit;
  // A failure drops out of the cache, so the next attempt retries instead of
  // replaying the rejection for the rest of the session.
  const p = fetchOwner(k).catch((err) => {
    dossiers.delete(key);
    throw err;
  });
  dossiers.set(key, p);
  return p;
}

/**
 * Name search for the picker. `signal` is required: these run per keystroke,
 * and a slow answer for "bri" must not land on top of the results for
 * "bridwell".
 */
export async function searchOwners(
  q: string,
  signal: AbortSignal
): Promise<OwnerMatch[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const r = await fetch(`/api/scout/cad/owners?q=${encodeURIComponent(term)}`, {
    signal,
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { hits?: OwnerMatch[] };
  return j.hits ?? [];
}
