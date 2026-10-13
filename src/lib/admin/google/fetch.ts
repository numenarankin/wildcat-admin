import "server-only";
import { getGoogleAccessToken } from "@/lib/admin/google/connections";
import { assertNotOrionGmailWrite } from "@/lib/admin/google/orion-guard";
import type { GoogleService } from "@/lib/admin/google/oauth";

/**
 * Every Google API call on the admin side goes through `googleFetch`: a live
 * token for the service (refreshed by `getGoogleAccessToken`), one retry with a
 * forced refresh on 401, backoff on 429 / 5xx, and a typed error otherwise.
 * Plan: docs/plans/google-integration.md section 5.
 */

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Google's `error.errors[0].reason` or `error.status`, e.g. "insufficientPermissions". */
    readonly reason: string | null
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

const RETRIES = 3;

/** Seam for tests: no real waiting. */
export const backoff = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

async function errorFrom(res: Response, service: GoogleService): Promise<GoogleApiError> {
  let reason: string | null = null;
  let detail: string | null = null;
  try {
    const body = (await res.json()) as {
      error?: { message?: string; status?: string; errors?: { reason?: string }[] };
    };
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? null;
    detail = body.error?.message ?? null;
  } catch {
    // Non-JSON body; the status is enough.
  }
  return new GoogleApiError(
    `Google ${service} request failed (${res.status}${detail ? `: ${detail}` : ""}).`,
    res.status,
    reason
  );
}

/** A raw response (for downloads); throws GoogleApiError on failure. */
export async function googleFetchRaw(
  userId: string,
  service: GoogleService,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  // Before the token: a refused write never touches Google at all.
  assertNotOrionGmailWrite(url, init.method);
  let token = await getGoogleAccessToken(userId, service);
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(url, { ...init, headers });
    if (res.ok) return res;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await getGoogleAccessToken(userId, service, { forceRefresh: true });
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < RETRIES - 1) {
      await backoff.wait(500 * 2 ** attempt);
      continue;
    }
    throw await errorFrom(res, service);
  }
}

/** JSON in, JSON out. A 204 resolves to null. */
export async function googleFetch<T>(
  userId: string,
  service: GoogleService,
  url: string,
  init: Omit<RequestInit, "body"> & { json?: unknown } = {}
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const res = await googleFetchRaw(userId, service, url, {
    ...rest,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  if (res.status === 204) return null as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** A URL with query params; undefined values are left out. */
export function googleUrl(base: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

/**
 * What a page shows when a read fails: the reconnect message for a revoked
 * grant or a missing scope, never an empty list. Section 10.
 */
export function googleErrorMessage(error: unknown, label: string): string {
  if (error instanceof GoogleApiError) {
    if (error.status === 403 && error.reason === "insufficientPermissions") {
      return `${label} isn't connected. Connect it in Settings > Connections.`;
    }
    return error.message;
  }
  if (error instanceof Error) {
    if (/needs to be reconnected|revoked|invalid_grant/i.test(error.message)) {
      return "Google needs to be reconnected in Settings > Connections.";
    }
    if (/is not connected/.test(error.message)) {
      return `${label} isn't connected. Connect it in Settings > Connections.`;
    }
    return error.message;
  }
  return `Couldn't reach Google ${label}.`;
}
