import { LoadingScreen } from "@/components/ui/loading-screen";

/**
 * The loading UI for EVERY route. A `loading.tsx` wraps its segment and all
 * nested segments in a Suspense boundary, and a nested segment inherits the
 * nearest one above it — so this single file covers all pages. Do not add
 * per-route `loading.tsx` files unless a route genuinely needs a different
 * skeleton; a second one silently overrides this and the app stops being
 * consistent.
 */
export default function Loading() {
  return <LoadingScreen />;
}
