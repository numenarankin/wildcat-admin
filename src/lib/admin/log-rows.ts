/**
 * Pure pieces of the platform log readers (`logs.ts`): the shapes, the filter vocabulary, and
 * how errors are grouped into "the same failure".
 */

export const LOG_LEVELS = ["info", "warning", "error", "fatal"] as const;
export const LOG_SOURCES = ["lambda", "edge", "app", "build", "external", "redirect", "firewall"] as const;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export interface LogLine {
  id: string;
  at: string;
  source: string;
  level: string | null;
  message: string | null;
  statusCode: number | null;
  method: string | null;
  path: string | null;
  requestId: string | null;
  userId: string | null;
  userEmail: string | null;
  orgId: string | null;
  /** The server action this line records (`file#export`), or null. */
  action: string | null;
}

export interface LogFilter {
  query?: string;
  level?: string;
  source?: string;
  path?: string;
  status?: StatusClass;
  userEmail?: string;
  /** Part of a server action's name, e.g. wipeTankHistory. */
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
  /** Paging: lines strictly older than this one. */
  before?: { at: string; id: string };
}

/** The `[from, to)` status range of a class, e.g. 5xx → [500, 600). */
export function statusRange(c: StatusClass): [number, number] {
  const base = Number(c[0]) * 100;
  return [base, base + 100];
}

/** A substring for an `ilike`, with its wildcards taken literally. */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Whether a line counts as a failure: logged at error or worse, or answered 5xx. */
export function isFailure(l: Pick<LogLine, "level" | "statusCode">): boolean {
  return l.level === "error" || l.level === "fatal" || (l.statusCode ?? 0) >= 500;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX = /\b[0-9a-f]{12,}\b/gi;
const NUMBER = /\d+/g;

const normalise = (s: string) => s.replace(UUID, ":id").replace(HEX, ":hex").replace(NUMBER, "#");

/**
 * What makes two failures "the same": the route (query dropped, ids and numbers generalised)
 * plus the first line that says what went wrong, generalised the same way. An `app` row's first
 * line names the route kind (`render /app/x/page`), so its error is on the second line. A line
 * with no message (a bare 5xx) is grouped by its status.
 */
export function failureFingerprint(l: Pick<LogLine, "source" | "message" | "path" | "statusCode">): {
  key: string;
  path: string;
  what: string;
} {
  const path = normalise((l.path ?? "").split("?")[0]) || "(no path)";
  const lines = (l.message ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const first = l.source === "app" ? (lines[1] ?? lines[0]) : lines[0];
  const what = first ? normalise(first).slice(0, 200) : `status ${l.statusCode ?? "?"}`;
  return { key: `${path}\n${what}`, path, what };
}

export interface FailureGroup {
  path: string;
  what: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  users: string[];
  sampleRequestId: string | null;
  sampleMessage: string | null;
}

/** Failures grouped by fingerprint, most frequent first (ties: most recent first). */
export function groupFailures(lines: LogLine[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup & { userSet: Set<string> }>();
  for (const l of lines) {
    if (!isFailure(l)) continue;
    const fp = failureFingerprint(l);
    let g = groups.get(fp.key);
    if (!g) {
      g = {
        path: fp.path,
        what: fp.what,
        count: 0,
        firstSeen: l.at,
        lastSeen: l.at,
        users: [],
        userSet: new Set(),
        sampleRequestId: null,
        sampleMessage: null,
      };
      groups.set(fp.key, g);
    }
    g.count += 1;
    if (l.at < g.firstSeen) g.firstSeen = l.at;
    if (l.at >= g.lastSeen) {
      g.lastSeen = l.at;
      g.sampleRequestId = l.requestId ?? g.sampleRequestId;
      g.sampleMessage = l.message ? l.message.slice(0, 500) : g.sampleMessage;
    }
    const who = l.userEmail ?? l.userId;
    if (who) g.userSet.add(who);
  }
  return [...groups.values()]
    .map(({ userSet, ...g }) => ({ ...g, users: [...userSet].sort() }))
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

export interface ActionUsage {
  action: string;
  calls: number;
  users: { user: string; calls: number }[];
  lastCalled: string;
}

/** Calls per server action, most called first; per action, its callers, most calls first. */
export function groupActions(lines: Pick<LogLine, "action" | "at" | "userEmail" | "userId">[]): ActionUsage[] {
  const by = new Map<string, { calls: number; last: string; users: Map<string, number> }>();
  for (const l of lines) {
    if (!l.action) continue;
    let g = by.get(l.action);
    if (!g) by.set(l.action, (g = { calls: 0, last: l.at, users: new Map() }));
    g.calls += 1;
    if (l.at > g.last) g.last = l.at;
    const who = l.userEmail ?? l.userId ?? "(signed out)";
    g.users.set(who, (g.users.get(who) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([action, g]) => ({
      action,
      calls: g.calls,
      lastCalled: g.last,
      users: [...g.users.entries()]
        .map(([user, calls]) => ({ user, calls }))
        .sort((a, b) => b.calls - a.calls || a.user.localeCompare(b.user)),
    }))
    .sort((a, b) => b.calls - a.calls || a.action.localeCompare(b.action));
}
