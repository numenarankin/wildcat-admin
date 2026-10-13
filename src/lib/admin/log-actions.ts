"use server";

import { requestLogLines } from "@/lib/admin/logs";
import type { LogLine } from "@/lib/admin/log-rows";

/** Every line of one request, for an expanded row on /admin/logs. Gated in the reader. */
export async function loadRequestLines(requestId: string): Promise<LogLine[]> {
  if (typeof requestId !== "string" || !requestId) return [];
  return requestLogLines(requestId);
}
