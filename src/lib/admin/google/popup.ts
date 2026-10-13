import "server-only";
import { getAppUrl } from "@/lib/env";

/**
 * The Google (and Slack) OAuth round trip runs in a popup, like Dropbox's
 * (`lib/cloud/oauth-popup.ts` on main): the callback hands its outcome to the
 * opener on this origin and closes, so Settings keeps its state. The message
 * is addressed to `getAppUrl()`, never `"*"`.
 */

export const GOOGLE_POPUP_MESSAGE = "wildcat-admin-google-oauth";

export const GOOGLE_SETTINGS_PATH = "/settings?section=connections";

export function wantsPopup(value: unknown): boolean {
  return value === true || value === "1";
}

/** Who a popup round trip belongs to: Google by default, Slack passes its own. */
export interface PopupTarget {
  /** The `source` the opener listens for. */
  source: string;
  /** The query parameter a full-page fallback carries the error in. */
  errorParam: string;
  title: string;
}

const GOOGLE_POPUP: PopupTarget = { source: GOOGLE_POPUP_MESSAGE, errorParam: "google_error", title: "Google" };

/** A page that reports `error` (null = success) to the opener and closes. */
export function popupResponse(error: string | null, target: PopupTarget = GOOGLE_POPUP): Response {
  const payload = JSON.stringify({ source: target.source, error });
  const origin = JSON.stringify(getAppUrl().replace(/\/$/, ""));
  const fallback = JSON.stringify(
    `${GOOGLE_SETTINGS_PATH}${error ? `&${target.errorParam}=${encodeURIComponent(error)}` : ""}`
  );

  const html = `<!DOCTYPE html>
<meta charset="utf-8">
<title>${target.title}</title>
<body style="font:14px system-ui;padding:2rem">Finishing up…</body>
<script>
  (function () {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${payload}, ${origin});
        window.close();
        return;
      }
    } catch (e) {}
    window.location.replace(${fallback});
  })();
</script>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
    },
  });
}
