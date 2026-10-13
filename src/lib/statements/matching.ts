/**
 * Statement identifier matching (GBC): resolve the printed lease / tank / meter
 * identifiers on a settlement line to the org's real entities.
 *
 * Pure so it unit-tests without a database and runs both in the extraction route
 * (to pre-fill matches) and the review UI. A confident match returns the entity
 * id; an ambiguous or absent one returns null, leaving the printed ref for a
 * human to resolve.
 *
 * TWO RULES GOVERN EVERYTHING HERE (docs/plans/statement-lease-matching.md):
 *
 * 1. The device answers before the paper. A line naming a meter or tank we know
 *    settles THAT device's lease, whatever the lease column happens to print.
 *    Structural evidence, not string similarity.
 * 2. Names are compared as EXACT equality on one shared key (`leaseKey`), which
 *    folds case, punctuation and spacing and nothing else. No token reordering,
 *    no subset matching, no edit distance: `Roach Parrott` and `Parrott Roach`
 *    are different leases, and so are `Corbett` and `Roy Corbett`. A false match
 *    is silent and posts money to the wrong lease; a false non-match costs one
 *    click in the review grid. The asymmetry is why this stays strict.
 */

import { canonical, canonicalId } from "@/lib/ai/ingest/normalize";

/** A matchable entity: an id plus the identifiers we compare against. */
export interface MatchTarget {
  id: string;
  /** Primary number (tank_no / meter_no / lease_no). */
  number?: string | null;
  /** Display name. */
  name?: string | null;
}

/**
 * The comparison key for a printed NUMBER (lease_no / tank_no / meter_no).
 *
 * `canonicalId` is the key the ingest dedup already uses, so "the matcher found
 * it" and "the writer would insert it" cannot disagree. It folds case and
 * punctuation ("No. 5", "#5", "5") and strips leading zeros on a pure-numeric
 * identifier ("0486289" = "486289").
 */
export function numberKey(v: string | null | undefined): string {
  return canonicalId(v);
}

/**
 * The comparison key for a printed lease NAME.
 *
 * Four folds, and only four. Each one exists because a purchaser prints the same
 * identifier a different way than the operator typed it, never to bring two
 * different leases together:
 *
 * | fold                              | what it fixes                      |
 * |-----------------------------------|------------------------------------|
 * | case + punctuation (`canonical`)  | `JOHNSON #2` = `Johnson 2`         |
 * | `&` read as `and`                 | `Smith & Jones` = `Smith and Jones`|
 * | leading zeros per numeric token   | `Corbett 02` = `Corbett 2`         |
 * | separators dropped (`leaseKeyCompact`) | `J.M. Smith` = `JM Smith`     |
 *
 * None of them can reach a pair that differs in its WORDS or their order, which
 * is what every confusable pair in this operator's fleet differs by.
 */
export function leaseKey(v: string | null | undefined): string {
  // "&" before `canonical`, which would otherwise fold it away to a space and
  // leave "smith jones" unable to meet "smith and jones".
  const amp = String(v ?? "").toLowerCase().replace(/&/g, " and ");
  return canonical(amp)
    .split(" ")
    .map((t) => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t))
    .join(" ")
    .trim();
}

/**
 * `leaseKey` with the separators taken out, for the second pass only.
 *
 * "J.M. Smith" canonicalizes to `j m smith` and "JM Smith" to `jm smith`: the
 * same name, differing only in where the document put its separators. Compared
 * ONLY after the spaced keys miss, so it can never pre-empt an exact hit, and
 * still exact equality, so it merges only names that differ in nothing but
 * punctuation and spacing.
 */
export function leaseKeyCompact(v: string | null | undefined): string {
  return leaseKey(v).replace(/ /g, "");
}

/** What a printed identifier resolved to: one target, several, or nothing. */
export type Resolution = { id: string } | "ambiguous" | null;

/**
 * Several hits that are all the SAME entity are not ambiguous.
 *
 * The production org carries each meter number twice (the backfill re-created
 * facilities it had already made), so a bare count would flag every gas line as
 * ambiguous when there is only one real meter behind them. Distinct ids are the
 * question; duplicate rows for one id are not.
 */
function dedupeIds(hits: MatchTarget[]): { id: string } | "ambiguous" {
  const ids = [...new Set(hits.map((t) => t.id))];
  return ids.length === 1 ? { id: ids[0] } : "ambiguous";
}

/** Targets whose `field` key equals `key`, ignoring targets with no key. */
function hits(
  targets: MatchTarget[],
  key: string,
  keyOf: (t: MatchTarget) => string
): MatchTarget[] {
  if (!key) return [];
  return targets.filter((t) => keyOf(t) === key);
}

/**
 * The single target a printed identifier names, or why it does not name one.
 *
 * Number first, then name, then the separator-stripped name. Hits are COUNTED at
 * each step rather than taking the first: two leases that fold to one key is a
 * question for the operator, not a coin flip.
 */
export function resolveUnique(
  ref: string,
  targets: MatchTarget[],
  opts: { byName: boolean }
): Resolution {
  const nk = numberKey(ref);
  if (nk) {
    const byNumber = hits(targets, nk, (t) => numberKey(t.number));
    if (byNumber.length > 0) return dedupeIds(byNumber);
  }
  if (!opts.byName) return null;

  const lk = leaseKey(ref);
  if (!lk) return null;
  const byName = hits(targets, lk, (t) => leaseKey(t.name));
  if (byName.length > 0) return dedupeIds(byName);

  const ck = leaseKeyCompact(ref);
  const byCompact = hits(targets, ck, (t) => leaseKeyCompact(t.name));
  if (byCompact.length > 0) return dedupeIds(byCompact);
  return null;
}

/**
 * Match a printed number to a target by its `number`. Returns the target id, or
 * null when nothing matches OR when the number names two different entities.
 */
export function matchByNumber(
  ref: string,
  targets: MatchTarget[]
): string | null {
  const hit = resolveUnique(ref, targets, { byName: false });
  return hit && hit !== "ambiguous" ? hit.id : null;
}

/**
 * Match a printed lease to a lease by number first, then by name. Leases are
 * printed as a name ("CORBETT") and/or a number ("5028872"); try both. Ambiguous
 * resolves to null, same as no match: both mean "a human has to say".
 */
export function matchLease(ref: string, targets: MatchTarget[]): string | null {
  const hit = resolveUnique(ref, targets, { byName: true });
  return hit && hit !== "ambiguous" ? hit.id : null;
}

/**
 * Is this proposed lease already on file?
 *
 * The SAME question `matchLease` answers, asked by the writer: a row whose
 * number or name resolves to an existing lease (or to two, which is a question
 * rather than a licence to create a third) is not new. Sharing this predicate is
 * what keeps "the matcher found nothing" and "the writer would insert" the same
 * set. When they were separate, a card could be proposed and then silently
 * skipped at approval, creating nothing.
 */
export function leaseIsOnFile(
  row: { leaseNo?: string | null; name?: string | null },
  existing: MatchTarget[]
): boolean {
  const asks = [row.leaseNo ?? "", row.name ?? ""].filter(Boolean);
  return asks.some((ask) => resolveUnique(ask, existing, { byName: true }) !== null);
}

/**
 * Printed lease refs the operator has already resolved by hand, keyed by
 * `leaseKey`, built from this org's reviewed statement history.
 *
 * This is where recall grows without the comparison getting looser: a ref that
 * only a human could connect to a lease stays connected the next time the same
 * purchaser prints it. A key that history resolved to two different leases is
 * `"ambiguous"` and resolves nothing: an operator changing their mind, or two
 * leases genuinely printing alike, is not a majority vote.
 */
export function buildLeaseAliases(
  rows: { leaseRef: string; leaseId: string }[]
): Map<string, string | "ambiguous"> {
  const out = new Map<string, string | "ambiguous">();
  for (const r of rows) {
    const key = leaseKey(r.leaseRef);
    if (!key || !r.leaseId) continue;
    const prev = out.get(key);
    if (prev === undefined) out.set(key, r.leaseId);
    else if (prev !== r.leaseId) out.set(key, "ambiguous");
  }
  return out;
}

/** Everything the lease ladder reads off one settlement line. */
export interface LeaseLadderLine {
  /** Already resolved (a stored id, or the reviewer's own pick). Wins outright. */
  leaseId: string | null;
  /** The lease as PRINTED. Kept even when it resolves nothing. */
  leaseRef: string;
  /** The tank/meter this line settles, once resolved. */
  pointId: string | null;
}

/** The org's side of the ladder: its leases, its devices, its history. */
export interface LeaseLadderContext {
  leases: MatchTarget[];
  /** tank/meter id -> the lease it sits on. */
  leaseByPoint: ReadonlyMap<string, string>;
  /** `buildLeaseAliases` output. Optional: the ladder works without history. */
  aliases?: ReadonlyMap<string, string | "ambiguous">;
}

/**
 * The lease a settlement line belongs to, by the ladder:
 *
 *   1. an id it already carries (stored, or the reviewer's pick)
 *   2. the lease of the tank/meter it settles
 *   3. the printed name, as an exact key match
 *   4. a ref the operator resolved by hand on an earlier statement
 *
 * Rung 2 is the one that matters: a gas line printing meter `123` settles that
 * meter's lease even when its lease column reads `JOHNSON #2` and the lease on
 * file is `Johnson 2`. It is also what the POSTING path already does
 * (`pointLeaseId`), so extraction and the ledger agree on what "this lease's
 * line" means.
 *
 * `ambiguous` is a question for the operator, never a coin flip and never a
 * reason to create a lease. It is deliberately NOT rescued by an alias: when two
 * leases on file fold to one key, the operator gets asked every time, because
 * the alternative is silently picking one of two real leases.
 */
export function resolveLeaseId(
  line: LeaseLadderLine,
  ctx: LeaseLadderContext
): { leaseId: string | null; ambiguous: boolean } {
  if (line.leaseId) return { leaseId: line.leaseId, ambiguous: false };

  const viaPoint = line.pointId ? ctx.leaseByPoint.get(line.pointId) : undefined;
  if (viaPoint) return { leaseId: viaPoint, ambiguous: false };

  const byName = resolveUnique(line.leaseRef, ctx.leases, { byName: true });
  if (byName === "ambiguous") return { leaseId: null, ambiguous: true };

  // An alias pointing at a lease that has since been deleted is stale history,
  // not an answer.
  const known = new Set(ctx.leases.map((l) => l.id));
  const alias = ctx.aliases?.get(leaseKey(line.leaseRef));
  const aliasId = alias && alias !== "ambiguous" && known.has(alias) ? alias : null;

  if (byName) {
    // History and the name pointing at two different leases is exactly the case
    // where guessing is worst. Ask.
    if (aliasId && aliasId !== byName.id) return { leaseId: null, ambiguous: true };
    return { leaseId: byName.id, ambiguous: false };
  }
  if (aliasId) return { leaseId: aliasId, ambiguous: false };
  if (alias === "ambiguous") return { leaseId: null, ambiguous: true };
  return { leaseId: null, ambiguous: false };
}
