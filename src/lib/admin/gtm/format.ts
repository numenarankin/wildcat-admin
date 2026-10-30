/** Display formats for the GTM page. Client-safe. */
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";

export const count = new Intl.NumberFormat("en-US");
export const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

// "10/30/26, 2:05 PM", in Wildcat's own zone (see `ADMIN_TIME_ZONE`).
const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  timeZone: ADMIN_TIME_ZONE,
});
const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: ADMIN_TIME_ZONE });

export const fmtDateTime = (iso: string) => dateTime.format(new Date(iso));
export const fmtClock = (iso: string) => clock.format(new Date(iso));

/** "4m 12s", "1h 03m", "35s". */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The landing's demo slugs as the site names them. */
const DEMO_NAMES: Record<string, string> = {
  dashboard: "Dashboard",
  orion: "Orion",
  mobile: "Mobile app",
  recon: "Recon",
  "log-analysis": "Log analysis",
  documents: "Documents",
  reports: "Reports",
  filings: "Filings",
  "flow-map": "Flow map",
};

export function demoName(demo: string): string {
  if (DEMO_NAMES[demo]) return DEMO_NAMES[demo];
  const bare = demo.replace(/^solutions:/, "").replace(/-/g, " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** "/" reads as Home; every other path as itself. */
export const pageName = (path: string) => (path === "/" ? "Home" : path);
