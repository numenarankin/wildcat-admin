/**
 * Upload size ceiling, shared by the client-side pre-flight checks (data-entry
 * dropzone) and the `uploadFiles` server action.
 *
 * All queued files POST as a single multipart request, so the binding limit is
 * the COMBINED size, not any one file. The Next request limits in
 * `next.config.ts` (`serverActions.bodySizeLimit` +
 * `experimental.proxyClientMaxBodySize`) are set deliberately ABOVE this value
 * so a legitimately full-size upload never trips the framework's multipart
 * truncation — which surfaces to the user as the opaque "Unexpected end of
 * form" error. Keep those config values > MAX_UPLOAD_BYTES if you change this.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/** `MAX_UPLOAD_BYTES` rendered for user-facing copy, e.g. "100 MB". */
export const MAX_UPLOAD_LABEL = "100 MB";

/**
 * Seismic volume ceiling (`docs/plans/seismic.md`, "Upload"). Volumes never
 * touch a server action body: the browser sends them straight to Storage over
 * TUS, so the Next request limits above do not bind here. The Storage project's
 * global file size limit must be at least this.
 */
export const MAX_SEISMIC_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB

/** `MAX_SEISMIC_BYTES` rendered for user-facing copy. */
export const MAX_SEISMIC_LABEL = "50 GB";

/** Human-readable byte size, e.g. `2.4 GB`, `1.5 MB`, `320 KB`, `12 B`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
