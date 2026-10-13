import { slugify } from "@/lib/slug";

/**
 * Name-based URLs for the facilities that are keyed by a uuid.
 *
 * Wells have always been readable — `wells.id` IS the slug — while tanks,
 * meters, batteries and leases route on their primary key, so their pages open
 * at `/production/tanks/6f2a…`. These helpers give those four the same URLs
 * wells have, without a migration and without rewriting the ~80 files that
 * build links from an id: a page resolves either form, and answers a uuid with
 * a redirect to the canonical name.
 *
 * Names are not unique — two leases really do both have a "Tank 1" — so a slug
 * that more than one row would claim carries a short id suffix
 * (`tank-1-6f2a3b`). Only the colliding rows pay for it; a unique name stays
 * clean.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a route param is a raw primary key rather than a name slug. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface NamedRow {
  id: string;
  name: string;
}

/** How many hex characters of the id disambiguate a duplicated name. */
const SUFFIX_LEN = 6;

/** The slug for a row, ignoring its siblings. */
function baseSlug(row: NamedRow): string {
  return slugify(row.name ?? "");
}

/**
 * The URL segment for one row, disambiguated against the rows it shares a page
 * with. Pass the same list the page resolves against, or the suffix and the
 * lookup won't agree.
 */
export function facilitySlug(row: NamedRow, siblings: NamedRow[]): string {
  const base = baseSlug(row);
  const collides = siblings.some(
    (s) => s.id !== row.id && baseSlug(s) === base
  );
  return collides ? `${base}-${row.id.slice(0, SUFFIX_LEN)}` : base;
}

/**
 * Stamp every row with the slug its own detail page will resolve, computed
 * against the list it is stamped with.
 *
 * The slug has to be decided HERE, in the loader that reads the whole set,
 * rather than at the link. A table almost never renders the whole set — the
 * Production page shows the oil tanks, Disposal the water ones, a lease shows
 * its own — and a name that is unique inside one of those subsets can still be
 * duplicated across the org. `facilitySlug` called on a subset would then emit
 * the bare name, which `findByParam` refuses as ambiguous when the page
 * resolves against everything: a 404 on a row that is right there on screen.
 *
 * Stamped once, the slug survives any downstream filtering, because filtering
 * can only remove the rows that made it ambiguous. So a loader that reads the
 * same list its detail page resolves against hands out a slug that page is
 * guaranteed to accept.
 */
export function withFacilitySlugs<T extends NamedRow>(
  rows: T[]
): (T & { slug: string })[] {
  // One pass to count the names, so a few hundred tanks is not a few hundred
  // scans of the list.
  const seen = new Map<string, number>();
  for (const row of rows) {
    const base = baseSlug(row);
    seen.set(base, (seen.get(base) ?? 0) + 1);
  }
  return rows.map((row) => {
    const base = baseSlug(row);
    const slug =
      (seen.get(base) ?? 0) > 1 ? `${base}-${row.id.slice(0, SUFFIX_LEN)}` : base;
    return { ...row, slug };
  });
}

/**
 * Resolve a route param back to a row, accepting either form.
 *
 * An ambiguous bare name returns null rather than picking one: nothing this app
 * links to is ever ambiguous (`facilitySlug` suffixes those), so an ambiguous
 * URL is hand-typed, and quietly opening one of two tanks is worse than a 404.
 */
export function findByParam<T extends NamedRow>(
  rows: T[],
  param: string
): T | null {
  if (isUuid(param)) return rows.find((r) => r.id === param) ?? null;

  const wanted = decodeURIComponent(param).toLowerCase();
  const exact = rows.filter((r) => baseSlug(r) === wanted);
  if (exact.length === 1) return exact[0];

  // `<name>-<id prefix>`, the disambiguated form. Checked second so a real name
  // that happens to end in six hex characters still wins.
  const suffixed = wanted.match(
    new RegExp(`^(.*)-([0-9a-f]{${SUFFIX_LEN}})$`)
  );
  if (suffixed) {
    const [, base, idPrefix] = suffixed;
    const hit = rows.find(
      (r) => baseSlug(r) === base && r.id.toLowerCase().startsWith(idPrefix)
    );
    if (hit) return hit;
  }
  return null;
}
