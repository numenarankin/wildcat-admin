import { NotFoundDetails } from "@/components/not-found-details";

/**
 * The 404, for an address that matches no route and for any page that calls
 * `notFound()`.
 *
 * It renders inside the app shell, so the sidebar, the header and the user's
 * own navigation are all still there: a dead link should cost the reader one
 * click, not eject them from the application. The copy states what happened and
 * nothing else. Nobody reaching this page is amused by it, and an apology in
 * the product's voice reads as evasion when what the reader wants is the way
 * back.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60svh] w-full flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <p className="font-mono text-6xl font-semibold tracking-tight text-tertiary-text tabular-nums">
          404
        </p>

        <h1 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-primary-text">
          Page not found
        </h1>

        <p className="mt-3 text-[15px] leading-relaxed text-secondary-text">
          This address does not match anything in WildcatIQ. The page may have
          been renamed or removed, or the link may be incomplete.
        </p>

        <NotFoundDetails />
      </div>
    </div>
  );
}
