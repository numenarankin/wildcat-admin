"use client";

import { useCallback, useRef, useState } from "react";

import { fmtVol } from "@/lib/scout/format";

/**
 * How many wells one settle may warm. A statewide view can render tens of
 * thousands of dots; warming them all would be the very lag this avoids.
 */
const PREFETCH_CAP = 150;

/** A well's current test-weighted rate, as the public record implies it. */
export interface WellRate {
  /** "ROACH 7" — what a reader recognises; a dot only carries its API. */
  name?: string;
  /** bbl PER MONTH, averaged over the reported months in the trailing year. */
  oil: number;
  /** MCF per month, same basis. */
  gas: number;
  /** `YYYY-MM` the rate came from. */
  cycle: string;
}

/**
 * Rates for map hover, fetched for the hole under the cursor and remembered.
 *
 * A map's source data cannot carry these: the statewide layer holds every hole
 * in Texas, and a dossier map is built from a list with no volumes on it. So the
 * lookup is on demand, one small request per hole, cached for the life of the
 * component. A hole hovered twice is fetched once, and a hole with no record is
 * remembered as "nothing" so it is not asked for again on every pass.
 *
 * The popup renders whatever it has and re-renders when the answer lands, so a
 * slow mirror costs the second line of a tooltip and never the first.
 */
export function useWellRates(): {
  rateFor: (api: string) => WellRate | null;
  request: (api: string) => void;
  prefetch: (apis: string[]) => void;
} {
  const cache = useRef(new Map<string, WellRate | null>());
  const pending = useRef(new Set<string>());
  const [, bump] = useState(0);

  const request = useCallback((raw: string) => {
    const api = raw.replace(/\D/g, "").slice(-8);
    if (api.length < 8) return;
    if (cache.current.has(api) || pending.current.has(api)) return;
    pending.current.add(api);
    void (async () => {
      try {
        const res = await fetch(`/api/scout/well-rate?api=${api}`);
        const json = (await res.json()) as {
          rates?: Record<string, WellRate>;
        };
        cache.current.set(api, json.rates?.[api] ?? null);
      } catch {
        // Remembered as "nothing" rather than retried on every mouse move.
        cache.current.set(api, null);
      } finally {
        pending.current.delete(api);
        bump((n) => n + 1);
      }
    })();
  }, []);

  /**
   * Warm the cache for what is on screen, off the critical path.
   *
   * Called when the map settles after a pan or zoom. It runs in an idle
   * callback, in batches, with a cap: the point is that a hover reads an answer
   * that is already there, NOT that the map goes and fetches a thousand wells.
   * Anything already cached or in flight is skipped, so repeated settles after
   * small pans cost nothing.
   */
  const prefetch = useCallback((raws: string[]) => {
    const wanted = [
      ...new Set(
        raws
          .map((r) => r.replace(/\D/g, "").slice(-8))
          .filter((a) => a.length === 8)
      ),
    ].filter((a) => !cache.current.has(a) && !pending.current.has(a));
    if (wanted.length === 0) return;

    // The route caps a request at 25, and the visible set is capped here so a
    // zoomed-out view does not queue thousands of rows nobody will hover.
    const batches: string[][] = [];
    for (let i = 0; i < Math.min(wanted.length, PREFETCH_CAP); i += 25) {
      batches.push(wanted.slice(i, i + 25));
    }
    for (const batch of batches) batch.forEach((a) => pending.current.add(a));

    const idle =
      typeof window !== "undefined" && "requestIdleCallback" in window
        ? window.requestIdleCallback
        : (fn: () => void) => setTimeout(fn, 200);

    idle(() => {
      void (async () => {
        for (const batch of batches) {
          try {
            const res = await fetch(`/api/scout/well-rate?api=${batch.join(",")}`);
            const json = (await res.json()) as {
              rates?: Record<string, WellRate>;
            };
            for (const api of batch) {
              cache.current.set(api, json.rates?.[api] ?? null);
            }
          } catch {
            for (const api of batch) cache.current.set(api, null);
          } finally {
            batch.forEach((a) => pending.current.delete(a));
          }
        }
        bump((n) => n + 1);
      })();
    });
  }, []);

  const rateFor = useCallback((raw: string) => {
    const api = raw.replace(/\D/g, "").slice(-8);
    return cache.current.get(api) ?? null;
  }, []);

  return { rateFor, request, prefetch };
}

/** "377 bbl/mo · 943 MCF/mo", or null when the record shows neither. */
export function formatRate(rate: WellRate | null): string | null {
  if (!rate) return null;
  const parts: string[] = [];
  if (rate.oil > 0) parts.push(`${fmtVol(Math.round(rate.oil))} bbl/mo`);
  if (rate.gas > 0) parts.push(`${fmtVol(Math.round(rate.gas))} MCF/mo`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
