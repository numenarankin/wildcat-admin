"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Main content wrapper. Most routes get a padded, full-width container whose
 * left edge lines up with the header (and its breadcrumb). Full-bleed routes
 * (a project workspace, Orion, Support, Prospecting, Outbound, Calendar, Email) fill the entire area
 * flush to the sidebar, top bar, and screen edges.
 */
export function AppMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const fullBleed =
    /^\/projects\/[^/]+/.test(pathname) ||
    pathname === "/orion" ||
    pathname === "/support" ||
    pathname === "/prospecting" ||
    pathname === "/outbound" ||
    pathname === "/calendar" ||
    pathname === "/email";

  if (fullBleed) {
    // Bound to the viewport minus the h-14 (3.5rem) top bar so the page itself
    // never scrolls — scrolling happens inside the route's own panes (e.g. the
    // Orion conversation history), keeping the top bar and composer in view.
    return (
      <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
        {children}
      </div>
    );
  }

  // The Files page keeps the padded layout but is bound to the viewport so its
  // document viewer/editor and file table scroll inside their own panes rather
  // than growing the whole page (matching the project workspace). Prefix, not
  // equality: every folder and file has its own route under /files, and they
  // are the same surface.
  const fixedHeight = pathname === "/files" || pathname.startsWith("/files/");

  // Left padding lines the content up with the topbar's page-label icon, which
  // sits past the sidebar toggle + separator, not at the header padding edge:
  //   px-4 (16) + trigger (28) + gap-3 (12) + separator (1) + mr-2 (8) + gap-3 (12) = 77px
  //   px-6 (24) + trigger (28) + gap-3 (12) + separator (1) + mr-2 (8) + gap-3 (12) = 85px
  return (
    <div
      className={cn(
        "flex w-full flex-col py-4 px-[77px] md:py-6 md:px-[85px]",
        fixedHeight
          ? "h-[calc(100svh-3.5rem)] min-h-0 overflow-hidden"
          : "flex-1"
      )}
    >
      {children}
    </div>
  );
}
