/**
 * Entity handles: one stable address for every physical or commercial thing.
 *
 * The schema addresses things three different ways. `wells.id` is a text slug
 * while everything else is a uuid; facilities are four separate tables reached
 * through untyped `facility_type` / `facility_id` pairs; and a "lease" is a row
 * id in one place and an RRC key in another. A model asked to carry those
 * distinctions gets them wrong, and the failure is silent: an id that belongs to
 * a tank passed where a battery id was wanted returns an empty result, not an
 * error.
 *
 * A handle is `type:id`. Every ontology tool takes and returns them, so the
 * type travels with the id and a mismatch is caught at the boundary by name.
 * This is a convention in the tool layer only. Nothing is written, no table
 * changes, and the underlying ids are exactly what the existing loaders expect.
 *
 * Pure and dependency-free, so the parse rules can be checked against a
 * hand-written oracle rather than against a database.
 */

/**
 * Every type a handle can name.
 *
 * Deliberately a closed list. An open one would let a model invent
 * `formation:wolfcamp`, which parses, addresses nothing, and fails somewhere
 * further in where the reason is no longer obvious.
 */
export const ENTITY_TYPES = [
  "well",
  "lease",
  "tank",
  "battery",
  "meter",
  "purchaser",
  "vendor",
  "owner",
  "employee",
  "contractor",
  "gatherer",
  "statement",
  "invoice",
  "file",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface Handle {
  type: EntityType;
  id: string;
}

const TYPES = new Set<string>(ENTITY_TYPES);

export function isEntityType(value: string): value is EntityType {
  return TYPES.has(value);
}

/** `well:smith-3`. The only form any tool should emit. */
export function formatHandle(type: EntityType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Parse a handle, or return null.
 *
 * Null rather than a throw: an unparseable handle is something the model can be
 * told about and retry, and the tools turn it into a value with the list of
 * legal types attached. A throw would end the turn over a typo.
 *
 * Split on the FIRST colon only, so an id that itself contains one survives
 * intact. The type is matched case-insensitively because models capitalise
 * inconsistently; the id is left exactly as written, because slugs and uuids are
 * compared byte for byte against the database and lowercasing one would silently
 * fail to match.
 */
export function parseHandle(raw: string): Handle | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;

  const type = trimmed.slice(0, colon).trim().toLowerCase();
  const id = trimmed.slice(colon + 1).trim();
  if (!id || !isEntityType(type)) return null;
  return { type, id };
}

/**
 * Parse and require one of a set of types.
 *
 * The common case in a tool: `oil` can be measured for a well, a lease, a tank
 * or a battery and for nothing else, and saying which four is more useful than
 * saying the handle was wrong.
 */
export function parseHandleOfType(
  raw: string,
  allowed: readonly EntityType[]
): Handle | null {
  const handle = parseHandle(raw);
  if (!handle) return null;
  return allowed.includes(handle.type) ? handle : null;
}

/** The error body a tool returns for an unusable handle. A value, never a throw. */
export function handleError(
  raw: string,
  allowed: readonly EntityType[] = ENTITY_TYPES
): { ok: false; error: string; expected: string } {
  return {
    ok: false,
    error: `"${raw}" is not a usable entity handle here.`,
    expected: `A handle is "type:id", e.g. "well:smith-3". Types accepted here: ${allowed.join(", ")}. Use resolve() to turn a name into one.`,
  };
}
