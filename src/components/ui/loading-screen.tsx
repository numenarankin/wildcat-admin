import { Spokes } from "@/components/ui/spokes";
import { cn } from "@/lib/utils";

/**
 * The app's one page-level loading state: the spinner, centered in the content
 * area. Rendered by `src/app/loading.tsx`, so every route gets it while its
 * server component streams — there is no second page spinner to drift from it.
 *
 * `flex-1` claims the height the shell's content column has left (the chain runs
 * SidebarProvider `min-h-svh` → SidebarInset `flex-1` → AppMain `flex-1`), so
 * "centered" means centered in the screen below the top bar. The `min-h` is the
 * fallback for the bare routes (auth / onboarding / invite) that render outside
 * the shell and so have no flex parent to stretch into.
 *
 * Those two properties are also the constraint on where this may go: it claims a
 * whole content area, so it belongs to a region — a route, a modal body, a map
 * container, the slot a table will fill. Dropping it into a row of controls
 * (a header's button group, a toolbar) forces that row to half the viewport and
 * puts a page spinner where a button was. Disable the control instead and let
 * the spinner sit in the region below it.
 */
export function LoadingScreen({
  className,
  label = "Loading",
}: {
  className?: string;
  /** Screen-reader label; the spinner itself is decorative. */
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-[50svh] w-full flex-1 items-center justify-center",
        className
      )}
    >
      <Spokes className="size-8 text-muted-foreground" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}
