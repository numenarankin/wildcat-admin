import "server-only";

/**
 * Read-only calls to Snitcher's REST API (https://api.snitcher.com/v1), for
 * the admin Orion's Snitcher tools. `SNITCHER_API_TOKEN` and
 * `SNITCHER_WORKSPACE_UUID`. Every failure is a value the model can act on,
 * never a throw. Contact reveals spend Snitcher credits and are not offered.
 * Snitcher allows 60 requests a minute per token.
 */

const API = "https://api.snitcher.com/v1";

export type SnitcherResult = { ok: true; data: unknown; total?: number } | { ok: false; error: string };

function config(): { token: string; workspace: string } | null {
  const token = process.env.SNITCHER_API_TOKEN;
  const workspace = process.env.SNITCHER_WORKSPACE_UUID;
  return token && workspace ? { token, workspace } : null;
}

async function call(path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<SnitcherResult> {
  const cfg = config();
  if (!cfg) return { ok: false, error: "Snitcher is not configured: SNITCHER_API_TOKEN and SNITCHER_WORKSPACE_UUID must be set." };
  const url = new URL(`${API}/workspaces/${cfg.workspace}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    return { ok: false, error: `Snitcher unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 429) return { ok: false, error: "Snitcher's rate limit (60 a minute) was hit; wait a minute and ask again." };
  const json = (await res.json().catch(() => null)) as { data?: unknown; total?: number; meta?: { total?: number }; message?: string } | null;
  if (!res.ok) return { ok: false, error: `Snitcher answered ${res.status}: ${json?.message ?? "no detail"}` };
  return { ok: true, data: json?.data ?? json, total: json?.total ?? json?.meta?.total };
}

/** Rows per listing; Snitcher's own maximum. A larger set says so through `total`. */
const PAGE_SIZE = 1000;

/**
 * Identified companies that visited in the date range (Wildcat's zone is the
 * caller's concern; Snitcher takes calendar dates). `visitorState` filters on
 * where the visitor browsed from, e.g. "Texas"; `name` on the company name.
 */
export function listSnitcherCompanies(opts: { dateFrom?: string; dateTo?: string; name?: string; visitorState?: string; page?: number }) {
  if (!opts.visitorState) {
    return call("/organisations", {
      query: { date_from: opts.dateFrom, date_to: opts.dateTo, name: opts.name, size: PAGE_SIZE, page: opts.page },
    });
  }
  // The filtered listing takes its dates as a condition, not as query parameters.
  const conditions: unknown[] = [{ field: "visitor.state", comparison: "equal", value: opts.visitorState }];
  if (opts.name) conditions.push({ field: "company.name", comparison: "contains", value: opts.name });
  if (opts.dateFrom || opts.dateTo) {
    conditions.push({ field: "visited_at", comparison: "between", value: [opts.dateFrom ?? "2000-01-01", opts.dateTo ?? new Date().toISOString().slice(0, 10)] });
  }
  return call("/organisations", { query: { size: PAGE_SIZE, page: opts.page }, body: { filters: { operator: "AND", conditions } } });
}

export function getSnitcherCompany(organisationUuid: string) {
  return call(`/organisations/${encodeURIComponent(organisationUuid)}`);
}

export function listSnitcherCompanySessions(organisationUuid: string, opts: { dateFrom?: string; dateTo?: string }) {
  return call(`/organisations/${encodeURIComponent(organisationUuid)}/sessions`, {
    query: { date_from: opts.dateFrom, date_to: opts.dateTo, size: PAGE_SIZE },
  });
}

export function listSnitcherSessions(opts: { dateFrom?: string; dateTo?: string; url?: string; referrer?: string }) {
  return call("/sessions", { query: { date_from: opts.dateFrom, date_to: opts.dateTo, url: opts.url, referrer: opts.referrer, size: PAGE_SIZE } });
}

/** The people Snitcher knows at a company. Listing is free; revealing an email or phone is not, and is not done here. */
export function listSnitcherContacts(opts: { organisationUuid?: string; domain?: string }) {
  return call("/contacts", { query: { organisation_uuid: opts.organisationUuid, domain: opts.domain, size: PAGE_SIZE } });
}
