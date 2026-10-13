/**
 * Stage 0's cache. Lazy, on first touch, invalidated by new data. No cron.
 *
 * See well-log-agent.md, Stage 0: "the first query against a well pays the cost,
 * everything after is a read." Caching is architecture here rather than an
 * optimization, because parsing now sits in the request path — a cache miss is
 * the difference between a fast turn and a slow one, so what invalidates it has
 * to be explicit and testable rather than assumed.
 *
 * The key is the well plus the file. The three invalidation triggers from the
 * architecture doc are handled differently on purpose:
 *
 *   - A NEW LAS changes `lasHash`, which changes the key. Nothing to invalidate;
 *     the old entry is simply never asked for again.
 *   - A NEW RRC RECORD or a NEW USER FACT does not change the key, so the entry
 *     carries a stamp for each and is discarded when the caller's current stamp
 *     disagrees. The caller computes those stamps cheaply (a max(updated_at), a
 *     hash of the facts) without paying for a re-parse to find out.
 *
 * That split matters: it means "is my cache valid" costs two scalar reads, not a
 * parse. A cache whose validity check costs as much as a miss is not a cache.
 */
import type { HeaderFacts } from "./contracts";
import type { ZoneEvaluation } from "./state";

/** Bump when the state object's shape changes; every entry becomes a miss. */
export const STATE_VERSION = 1;

export interface CacheStamps {
  /** Hash of the LAS file. Also part of the key. */
  las: string;
  /** Changes when this well's RRC records change. */
  rrc: string;
  /** Changes when the user tells us something new about this well. */
  facts: string;
}

export interface CacheEntry {
  version: number;
  stamps: CacheStamps;
  snapshot: ZoneEvaluation;
  /**
   * Stored alongside the snapshot because Stage 1 needs location and elevation
   * to start its RRC branches, and those are header facts rather than state —
   * without this, a cache hit would still have to re-read the file to hand
   * Stage 1 what it needs, which is most of what the cache exists to avoid.
   */
  header: HeaderFacts;
  storedAt: number;
}

export interface EvaluationCache {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export function cacheKey(api: string, lasHash: string): string {
  return `${api}:${lasHash}`;
}

/**
 * Whether a cached entry may be used, and if not, why.
 *
 * Returns a reason string rather than a boolean so the miss lands in the
 * trajectory log as itself. "Cache miss" is not diagnostic; "cache miss: rrc
 * stamp changed" tells you a W-2 landed.
 */
export function staleness(entry: CacheEntry, stamps: CacheStamps): string | null {
  if (entry.version !== STATE_VERSION) return `state version ${entry.version} -> ${STATE_VERSION}`;
  if (entry.stamps.las !== stamps.las) return "las changed";
  if (entry.stamps.rrc !== stamps.rrc) return "rrc record changed";
  if (entry.stamps.facts !== stamps.facts) return "user facts changed";
  return null;
}

/**
 * In-memory cache. Real enough to test invalidation against, and the correct
 * default for a single-process deployment; swap for a Postgres-backed one when
 * there is more than one.
 */
export class MemoryEvaluationCache implements EvaluationCache {
  private readonly entries = new Map<string, CacheEntry>();

  async get(key: string): Promise<CacheEntry | null> {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
