import type { GmailFilter, GmailThreadPage, GmailThreadView } from "@/lib/admin/google/gmail/types";

/**
 * /email's reads from the browser, through the GET routes rather than server
 * actions so they run in parallel (see `api/admin/google/gmail/thread`).
 */

export type GmailResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function getJson<T>(url: string): Promise<GmailResult<T>> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.headers.get("content-type")?.includes("application/json")) return (await res.json()) as GmailResult<T>;
    return { ok: false, error: res.status === 404 ? "Not found." : "Couldn't reach Email." };
  } catch {
    return { ok: false, error: "Couldn't reach Email." };
  }
}

export function fetchGmailThreads(input: { filter: GmailFilter; q?: string; pageToken?: string }) {
  const params = new URLSearchParams({ filter: input.filter });
  if (input.q) params.set("q", input.q);
  if (input.pageToken) params.set("pageToken", input.pageToken);
  return getJson<GmailThreadPage>(`/api/admin/google/gmail/threads?${params}`);
}

/** `historyId` from the list row lets the server answer from its cache. */
export function fetchGmailThread(id: string, historyId?: string) {
  const h = historyId ? `&h=${encodeURIComponent(historyId)}` : "";
  return getJson<GmailThreadView>(`/api/admin/google/gmail/thread?id=${encodeURIComponent(id)}${h}`);
}
