import "server-only";
import { cache } from "react";
import { memoScope } from "@/lib/cache/request-cache";

/**
 * Memoize a value for the whole RENDER, across layout and page.
 *
 * `withRequestScope` cannot do this. The root layout and the page it wraps are
 * separate async subtrees: the layout opens its own scope (`src/app/layout.tsx:66`)
 * and the page opens another via `scopedPage`, and AsyncLocalStorage propagates
 * into continuations created INSIDE a `run()`, not into a sibling call started
 * outside it. So the session resolved once per subtree, i.e. twice per
 * navigation, and the layout's own comment concedes it ("The page render is a
 * separate scope; it dedupes its own").
 *
 * React's `cache()` is scoped to the render pass, which is exactly the span that
 * covers both. Layering the two is deliberate rather than redundant:
 *
 *   - In a page/layout render, `cache()` collapses layout and page to one call.
 *   - Outside a render (Route Handler, Server Action, cron script) `cache()`
 *     silently re-invokes on every call, verified against Next 16 in
 *     `request-cache.ts:20-25`. There the inner `memoScope` still dedupes,
 *     which is why the ALS layer stays.
 *
 * Neither layer alone covers both cases. Use this for request-invariant reads
 * on the auth path; anything that a write can change mid-request must not go
 * through here, for the same reason `memo` is read-only.
 */
export function memoRender<T>(key: string, load: () => Promise<T>): () => Promise<T> {
  // `cache()` keys on the function identity plus its arguments, so one wrapper
  // per key is created at module scope by the callers below, never per call.
  return cache(() => memoScope(key, load));
}
