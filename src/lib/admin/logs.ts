import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import {
  groupActions,
  groupFailures,
  likePattern,
  statusRange,
  type ActionUsage,
  type FailureGroup,
  type LogFilter,
  type LogLine,
} from "@/lib/admin/log-rows";

/**
 * Readers over `platform_logs` (the app's server logs; see the migration
 * 2026100100100_platform_logs.sql) for /admin/logs and the admin Orion.
 * Service-role reads behind the admin check, like every reader in this
 * folder: the table has RLS on and no policies.
 */

const COLUMNS = "id, at, source, level, message, status_code, method, path, request_id, user_id, org_id, action";
export const MAX_LIMIT = 200;
const SUMMARY_SCAN = 5_000;

interface DbRow {
  id: string;
  at: string;
  source: string;
  level: string | null;
  message: string | null;
  status_code: number | null;
  method: string | null;
  path: string | null;
  request_id: string | null;
  user_id: string | null;
  org_id: string | null;
  action: string | null;
}

/** Migration 2026100100100 or 2026100100200 is not applied to this database. */
export function isMissingTable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /platform_logs/.test(m) && /does not exist|Could not find the table|schema cache/i.test(m);
}

async function requireAdmin(): Promise<void> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

/** Every auth user's email by id, so lines name people. */
async function userEmails(): Promise<Map<string, string>> {
  const { data, error } = await getSupabaseAdmin().auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`auth users: ${error.message}`);
  return new Map(data.users.filter((u) => u.email).map((u) => [u.id, u.email as string]));
}

function idForEmail(emails: Map<string, string>, email: string): string | null {
  const want = email.trim().toLowerCase();
  for (const [id, e] of emails) if (e.toLowerCase() === want) return id;
  return null;
}

const toLine = (r: DbRow, emails: Map<string, string>): LogLine => ({
  id: r.id,
  at: r.at,
  source: r.source,
  level: r.level,
  message: r.message,
  statusCode: r.status_code,
  method: r.method,
  path: r.path,
  requestId: r.request_id,
  userId: r.user_id,
  userEmail: r.user_id ? (emails.get(r.user_id) ?? null) : null,
  orgId: r.org_id,
  action: r.action,
});

/** Lines matching the filter, newest first. An unknown `userEmail` matches nothing. */
export async function searchLogs(filter: LogFilter = {}): Promise<LogLine[]> {
  await requireAdmin();
  const emails = await userEmails();
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), MAX_LIMIT);

  let q = getSupabaseAdmin()
    .from("platform_logs")
    .select(COLUMNS)
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (filter.level) q = q.eq("level", filter.level);
  if (filter.source) q = q.eq("source", filter.source);
  if (filter.path) q = q.ilike("path", likePattern(filter.path));
  if (filter.action) q = q.ilike("action", likePattern(filter.action));
  if (filter.status) {
    const [from, to] = statusRange(filter.status);
    q = q.gte("status_code", from).lt("status_code", to);
  }
  if (filter.since) q = q.gte("at", filter.since);
  if (filter.until) q = q.lte("at", filter.until);
  if (filter.query?.trim()) q = q.textSearch("search", filter.query.trim(), { type: "websearch", config: "simple" });
  if (filter.userEmail?.trim()) {
    const id = idForEmail(emails, filter.userEmail);
    if (!id) return [];
    q = q.eq("user_id", id);
  }
  if (filter.before) {
    const { at, id } = filter.before;
    q = q.or(`at.lt."${at}",and(at.eq."${at}",id.lt."${id}")`);
  }

  const { data, error } = await q;
  if (error) throw new Error(`platform_logs: ${error.message}`);
  return ((data ?? []) as DbRow[]).map((r) => toLine(r, emails));
}

/** Every line of one request, oldest first. */
export async function requestLogLines(requestId: string): Promise<LogLine[]> {
  await requireAdmin();
  const [emails, res] = await Promise.all([
    userEmails(),
    getSupabaseAdmin()
      .from("platform_logs")
      .select(COLUMNS)
      .eq("request_id", requestId)
      .order("at", { ascending: true })
      .limit(500),
  ]);
  if (res.error) throw new Error(`platform_logs: ${res.error.message}`);
  return ((res.data ?? []) as DbRow[]).map((r) => toLine(r, emails));
}

/**
 * Failures (error/fatal lines and 5xx answers) since `since`, grouped into "the same failure"
 * (`groupFailures`). With `userEmail`, only that user's failures. Those come from the `app`
 * rows, the only ones that carry a user.
 */
export async function failureSummary(opts: { since: string; userEmail?: string }): Promise<{
  scanned: number;
  truncated: boolean;
  groups: FailureGroup[];
}> {
  await requireAdmin();
  const emails = await userEmails();
  let q = getSupabaseAdmin()
    .from("platform_logs")
    .select(COLUMNS)
    .gte("at", opts.since)
    .or("level.in.(error,fatal),status_code.gte.500")
    .order("at", { ascending: false })
    .limit(SUMMARY_SCAN);
  if (opts.userEmail?.trim()) {
    const id = idForEmail(emails, opts.userEmail);
    if (!id) return { scanned: 0, truncated: false, groups: [] };
    q = q.eq("user_id", id);
  }
  const { data, error } = await q;
  if (error) throw new Error(`platform_logs: ${error.message}`);
  const lines = ((data ?? []) as DbRow[]).map((r) => toLine(r, emails));
  return { scanned: lines.length, truncated: lines.length === SUMMARY_SCAN, groups: groupFailures(lines) };
}

const USAGE_SCAN = 50_000;

/**
 * Which server actions were called since `since`, how often, and by whom (from the app's
 * tagged action lines). With `userEmail`, only that user's calls.
 */
export async function actionUsage(opts: { since: string; userEmail?: string }): Promise<{
  calls: number;
  truncated: boolean;
  actions: ActionUsage[];
}> {
  await requireAdmin();
  const emails = await userEmails();
  let q = getSupabaseAdmin()
    .from("platform_logs")
    .select("at, action, user_id")
    .not("action", "is", null)
    .gte("at", opts.since)
    .order("at", { ascending: false })
    .limit(USAGE_SCAN);
  if (opts.userEmail?.trim()) {
    const id = idForEmail(emails, opts.userEmail);
    if (!id) return { calls: 0, truncated: false, actions: [] };
    q = q.eq("user_id", id);
  }
  const { data, error } = await q;
  if (error) throw new Error(`platform_logs: ${error.message}`);
  const rows = (data ?? []) as { at: string; action: string; user_id: string | null }[];
  const actions = groupActions(
    rows.map((r) => ({
      at: r.at,
      action: r.action,
      userId: r.user_id,
      userEmail: r.user_id ? (emails.get(r.user_id) ?? null) : null,
    }))
  );
  return { calls: rows.length, truncated: rows.length === USAGE_SCAN, actions };
}
