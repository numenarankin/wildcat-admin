/**
 * Wildcat's own zone (Central), for every admin date. A FIXED zone, not the
 * viewer's: admin cells server-render, the server is UTC, and formatting in
 * the browser's zone made the server and client disagree, which is a
 * hydration mismatch on every row.
 */
export const ADMIN_TIME_ZONE = "America/Chicago";
