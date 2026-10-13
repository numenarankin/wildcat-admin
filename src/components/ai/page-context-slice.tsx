"use client";

import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import type { ContextSlice } from "@/lib/ai/page-context";

/**
 * Publish a slice from a server-rendered page, for as long as it is mounted.
 * A server component cannot call the hook; it renders this instead.
 */
export function PageContextSlice({ sliceKey, slice }: { sliceKey: string; slice: ContextSlice | null }) {
  usePageContextSlice(sliceKey, slice);
  return null;
}
