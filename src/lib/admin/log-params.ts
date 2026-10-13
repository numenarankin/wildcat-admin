import {
  LOG_LEVELS,
  LOG_SOURCES,
  STATUS_CLASSES,
  type LogFilter,
  type StatusClass,
} from "@/lib/admin/log-rows";

/** The /admin/logs URL as a filter. Unknown values are ignored, never an error. */

export const LOG_RANGES = ["1h", "24h", "7d", "30d"] as const;
export type LogRange = (typeof LOG_RANGES)[number];
export const DEFAULT_LOG_RANGE: LogRange = "24h";
const RANGE_MS: Record<LogRange, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};
export const PAGE_SIZE = 100;

export interface LogParams {
  range: LogRange;
  level?: string;
  source?: string;
  status?: StatusClass;
  path?: string;
  user?: string;
  action?: string;
  q?: string;
  /** `<iso at>|<id>` of the last line on the previous page. */
  before?: string;
}

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const oneOf = <T extends string>(list: readonly T[], v: string | undefined): T | undefined =>
  v && (list as readonly string[]).includes(v) ? (v as T) : undefined;

export function parseLogParams(raw: Raw): LogParams {
  return {
    range: oneOf(LOG_RANGES, one(raw.range)) ?? DEFAULT_LOG_RANGE,
    level: oneOf(LOG_LEVELS, one(raw.level)),
    source: oneOf(LOG_SOURCES, one(raw.source)),
    status: oneOf(STATUS_CLASSES, one(raw.status)),
    path: one(raw.path),
    user: one(raw.user),
    action: one(raw.action),
    q: one(raw.q),
    before: one(raw.before),
  };
}

export function toLogFilter(p: LogParams, nowMs: number): LogFilter {
  const cursor = p.before?.split("|");
  const before =
    cursor?.length === 2 && !Number.isNaN(Date.parse(cursor[0])) && cursor[1] ? { at: cursor[0], id: cursor[1] } : undefined;
  return {
    since: new Date(nowMs - RANGE_MS[p.range]).toISOString(),
    level: p.level,
    source: p.source,
    status: p.status,
    path: p.path,
    userEmail: p.user,
    action: p.action,
    query: p.q,
    limit: PAGE_SIZE,
    before,
  };
}

/** The URL for these params, leaving out defaults and blanks. */
export function logParamsHref(p: Partial<LogParams>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (!v || (k === "range" && v === DEFAULT_LOG_RANGE)) continue;
    sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `/logs?${s}` : "/logs";
}
