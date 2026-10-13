/**
 * Browser-side reads of the RRC mirror's people, over `/api/scout/rrc/people`.
 *
 * Everything about a person on /scout comes through here — the picker's search,
 * the map's person filter, and the principal panel — so all three agree by
 * construction. That matters because they are three views of one answer: the
 * panel lists the operators, the map draws their wells, and the picker says how
 * many there are.
 *
 * The mirror is the whole of Scout's data now: 184,725 officer rows against
 * Archon's 172,071 (123,007 distinct people against 116,739), a trigram index
 * on the name, and each officer's city and state. When this was the only
 * migrated read, a person the mirror knew and Archon did not could resolve to
 * operators the map could not draw; the rest of /scout reads the same database
 * now, so that gap is closed.
 */

import type { PersonDossier, PersonMatch } from "@/lib/scout/rrc-types";

export type { PersonDossier, PersonMatch };

/**
 * name -> dossier, cached as the in-flight promise.
 *
 * The map effect re-runs on every keystroke in a Min/Max box and the panel
 * mounts on the same selection, so without this one pick costs several
 * identical round trips. A person's affiliations are a monthly-refresh fact;
 * caching them for the session is not staleness worth paying for.
 */
const dossiers = new Map<string, Promise<PersonDossier>>();

async function fetchPerson(name: string): Promise<PersonDossier> {
  const r = await fetch(
    `/api/scout/rrc/people?name=${encodeURIComponent(name)}`
  );
  if (!r.ok) throw new Error(`person lookup failed: ${r.status}`);
  const j = (await r.json()) as { person?: PersonDossier };
  return j.person ?? { name, affiliations: [] };
}

export function getPerson(name: string): Promise<PersonDossier> {
  const hit = dossiers.get(name);
  if (hit) return hit;
  // A failure drops out of the cache, so the next attempt retries instead of
  // replaying the rejection for the rest of the session.
  const p = fetchPerson(name).catch((err) => {
    dossiers.delete(name);
    throw err;
  });
  dossiers.set(name, p);
  return p;
}

/** The operator numbers behind a person — the map's whole use for them. */
export async function getPersonOperators(name: string): Promise<number[]> {
  const { affiliations } = await getPerson(name);
  return [...new Set(affiliations.map((a) => a.operator_number))];
}

/**
 * Name search for the picker. `signal` is required rather than optional: these
 * run per keystroke, and a slow answer for "bor" must not land on top of the
 * results for "borderline".
 */
export async function searchPeople(
  q: string,
  signal: AbortSignal
): Promise<PersonMatch[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const r = await fetch(
    `/api/scout/rrc/people?q=${encodeURIComponent(term)}`,
    { signal }
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { hits?: PersonMatch[] };
  return j.hits ?? [];
}
