/**
 * The admin side's pages, as the things an admin can be granted.
 *
 * Access to /admin is page-level: a member of the team sees exactly the pages
 * on their `platform_admins.pages` list (migration 2026101300100), the seed
 * admin sees all of them. This catalog is the one source of truth for which
 * keys exist. The sidebar (`app-shared.tsx`) is matched to it by path, each
 * page's guard (`requireAdminPage`) and the proxy read it, and Settings > Team
 * offers exactly these switches.
 *
 * A key is the page's first path segment, so `/projects/<id>` and
 * `/drive/docs/<id>` fall under `projects` and `drive` without a second map.
 *
 * Client-safe: no server imports, so the sidebar and the Team tab share it.
 */

export const ADMIN_PAGE_GROUPS = ["Workspace", "Business", "Engineering"] as const;
export type AdminPageGroup = (typeof ADMIN_PAGE_GROUPS)[number];

export interface AdminPageDef {
  key: AdminPageKey;
  label: string;
  path: string;
  group: AdminPageGroup;
  description: string;
}

export const ADMIN_PAGE_KEYS = [
  "dashboard",
  "orion",
  "projects",
  "tasks",
  "calendar",
  "email",
  "slack",
  "drive",
  "prospecting",
  "outbound",
  "analytics",
  "finance",
  "clients",
  "support",
  "logs",
  "git",
  "settings",
] as const;

export type AdminPageKey = (typeof ADMIN_PAGE_KEYS)[number];

export const ADMIN_PAGE_DEFS: readonly AdminPageDef[] = [
  { key: "dashboard", label: "Dashboard", path: "/dashboard", group: "Workspace", description: "Customer count, revenue and growth at a glance." },
  { key: "orion", label: "Orion", path: "/orion", group: "Workspace", description: "The admin Orion chat over the business." },
  { key: "projects", label: "Projects", path: "/projects", group: "Workspace", description: "Internal projects and their work items." },
  { key: "tasks", label: "Tasks", path: "/tasks", group: "Workspace", description: "The team's task list." },
  { key: "calendar", label: "Calendar", path: "/calendar", group: "Workspace", description: "Shared calendar and events." },
  { key: "email", label: "Email", path: "/email", group: "Workspace", description: "The connected Gmail inbox." },
  { key: "slack", label: "Slack", path: "/slack", group: "Workspace", description: "The connected Slack workspace." },
  { key: "drive", label: "Drive", path: "/drive", group: "Workspace", description: "The connected Google Drive and its docs." },
  { key: "prospecting", label: "Prospecting", path: "/prospecting", group: "Business", description: "The RRC operator map, targets and outreach." },
  { key: "outbound", label: "Outbound", path: "/outbound", group: "Business", description: "Outbound campaigns." },
  { key: "analytics", label: "Analytics", path: "/analytics", group: "Business", description: "Product usage and growth analytics." },
  { key: "finance", label: "Finance", path: "/finance", group: "Business", description: "Revenue, subscriptions and billing." },
  { key: "clients", label: "Clients", path: "/clients", group: "Business", description: "Every customer org and its account." },
  { key: "support", label: "Support", path: "/support", group: "Business", description: "Customer support conversations." },
  { key: "logs", label: "Logs", path: "/logs", group: "Engineering", description: "Platform request and error logs." },
  { key: "git", label: "Git", path: "/git", group: "Engineering", description: "Repository history." },
  { key: "settings", label: "Settings", path: "/settings", group: "Engineering", description: "Team roster, account labels and connections." },
];

export const ALL_ADMIN_PAGES: AdminPageKey[] = [...ADMIN_PAGE_KEYS];

const KEY_SET: ReadonlySet<string> = new Set(ADMIN_PAGE_KEYS);

export function isAdminPageKey(value: string): value is AdminPageKey {
  return KEY_SET.has(value);
}

export function adminPageDef(key: AdminPageKey): AdminPageDef {
  const def = ADMIN_PAGE_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown admin page: ${key}`);
  return def;
}

/**
 * Normalise a stored or submitted list: unknown keys dropped, duplicates
 * collapsed, catalog order. What the database holds and what the UI shows
 * both pass through here, so the two can never disagree about a key.
 */
export function cleanPages(keys: readonly string[]): AdminPageKey[] {
  const wanted = new Set(keys);
  return ADMIN_PAGE_KEYS.filter((k) => wanted.has(k));
}

/**
 * The page a path belongs to, by its first segment; null for a path that is
 * no page (`/`, `/_404`, `/api/...`, `/auth`).
 */
export function pageKeyForPath(pathname: string): AdminPageKey | null {
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  return isAdminPageKey(first) ? first : null;
}

/** Whether `pages` opens `pathname`. A path that is no page is open to every admin. */
export function pagesAllowPath(pages: readonly AdminPageKey[], pathname: string): boolean {
  const key = pageKeyForPath(pathname);
  return key === null || pages.includes(key);
}

/** The pages grouped for display, in catalog order, empty groups dropped. */
export function groupedAdminPages(): Array<{ group: AdminPageGroup; pages: AdminPageDef[] }> {
  return ADMIN_PAGE_GROUPS.map((group) => ({
    group,
    pages: ADMIN_PAGE_DEFS.filter((d) => d.group === group),
  })).filter((g) => g.pages.length > 0);
}

/** A short summary of what is granted, for the trigger button in the roster. */
export function pagesLabel(pages: readonly AdminPageKey[]): string {
  const n = cleanPages(pages).length;
  if (n === 0) return "No pages";
  if (n >= ADMIN_PAGE_KEYS.length) return "All pages";
  return `${n} page${n === 1 ? "" : "s"}`;
}
