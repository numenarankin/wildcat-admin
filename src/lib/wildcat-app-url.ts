/**
 * The customer app (WildcatIQ proper), which this admin app sits beside.
 *
 * The admin side used to be a subtree of the customer app, so a link to a
 * customer page was a relative path. Now the two are separate deployments on
 * separate origins, and anything that sends a person to the customer app (a
 * customer's password-reset link, the billing portal's return, "Back to app")
 * must name that origin. `NEXT_PUBLIC_` because the sidebar renders it in the
 * browser.
 *
 * `getAppUrl()` (lib/env) stays THIS app's origin: Google and Slack OAuth
 * callbacks and the connect popup's postMessage target must come back here.
 */
export function getWildcatAppUrl(): string {
  return (process.env.NEXT_PUBLIC_WILDCAT_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** An absolute URL to `path` in the customer app. */
export function wildcatAppUrl(path: string): string {
  return `${getWildcatAppUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
