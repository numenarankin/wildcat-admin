"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useRef,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface WellRowProps {
  /**
   * Destination route for this row, or null when it has none yet — a row shown
   * optimistically before its write has landed, which would 404 if opened. Such
   * a row reads normally and simply does not navigate; it becomes a link the
   * moment the caller hands it an href.
   */
  href: string | null;
  /**
   * Warm `href`'s loading shell when the row's link enters the viewport, and
   * warm it again on hover. Pass `false` for a very long list where one request
   * per row is not worth it.
   */
  prefetch?: boolean;
  /**
   * Which cell carries the real `<a href>` — the name cell, by default the
   * first. Pass an index where that is not the primary cell (an icon column).
   * `-1` opts out entirely.
   */
  linkCell?: number;
  className?: string;
  children: React.ReactNode;
}

/**
 * A table row that navigates to `href` when clicked. Keyboard users can focus
 * the row and activate it with Enter or Space.
 *
 * Prefetching is deliberately SHALLOW. These rows link to dynamic detail pages
 * that cost a full server render each — this app's most expensive pages. An
 * earlier version passed `prefetch={true}` to the name-cell `<Link>`, which per
 * the Link docs prefetches "the full route and its data" for a dynamic route:
 * with N rows in view, that fired N complete well-page renders on page load,
 * saturating the server and Supabase so hard that an actual click could sit
 * behind the storm for tens of seconds. The default (`auto`) prefetch fetches
 * only down to the nearest `loading.js` boundary — the spinner shell — which is
 * what makes navigation feel instant without rendering pages nobody asked for.
 * Hover additionally warms the route via `router.prefetch`, an intent signal
 * that scales with the user's pointer instead of with the row count.
 *
 * The name cell gets a real `<Link>` (see `linkCell`). A `<tr onClick>` is
 * invisible to the browser: right-click offers no "open in new tab", and
 * cmd-click and middle-click do nothing. Only an anchor with an `href` carries
 * those, so the primary cell is one — while a plain left click there still
 * defers to the row, keeping one navigation path and the pending state.
 */
export function WellRow({
  href,
  prefetch = true,
  linkCell = 0,
  className,
  children,
}: WellRowProps) {
  const router = useRouter();
  const rowRef = useRef<HTMLTableRowElement>(null);
  const [isPending, startTransition] = useTransition();

  const navigate = useCallback(() => {
    if (isPending || href === null) return; // ignore a second click while the first is in flight
    startTransition(() => {
      router.push(href);
    });
  }, [href, isPending, router]);

  // Wrap the primary cell's contents in the anchor. A modified click (cmd, ctrl,
  // shift, middle) is left to the browser — that IS the new-tab gesture we were
  // missing; a plain click is cancelled here and handled by the row, so there is
  // still exactly one navigation and it still shows the pending state.
  const cells =
    linkCell < 0 || href === null
      ? children
      : Children.map(children, (cell, index) => {
          if (
            index !== linkCell ||
            !isValidElement<{ children?: React.ReactNode }>(cell)
          ) {
            return cell;
          }
          return cloneElement(
            cell,
            undefined,
            <Link
              href={href}
              // `false` disables viewport prefetch entirely; otherwise leave the
              // prop unset so Link uses its default `auto` — the loading-shell
              // prefetch. NEVER pass `true` here: on a dynamic route that is a
              // full page render per row (see the component doc above).
              prefetch={prefetch ? undefined : false}
              // The row is the focus stop (role="link", tabIndex 0); a second
              // stop inside it would double every row for keyboard users.
              tabIndex={-1}
              className="hover:underline"
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
              }}
            >
              {cell.props.children}
            </Link>
          );
        });

  return (
    <TableRow
      ref={rowRef}
      role={href === null ? undefined : "link"}
      tabIndex={href === null ? undefined : 0}
      aria-busy={isPending || undefined}
      onClick={navigate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate();
        }
      }}
      onMouseEnter={() => {
        if (prefetch && href !== null) router.prefetch(href);
      }}
      className={cn(
        href !== null && "cursor-pointer",
        "focus-visible:bg-muted/50 focus-visible:outline-none",
        // Same two idioms the app already uses for "busy": the table's own muted
        // background plus the skeleton pulse (see `DashboardBodySkeleton`).
        isPending && "cursor-wait animate-pulse bg-muted/50",
        className
      )}
    >
      {cells}
    </TableRow>
  );
}
