/**
 * Browser download helpers. The one place in the app that turns bytes into a
 * "Save as…" — an object URL on a temporary anchor, revoked right after. Used
 * by the export menus for the client-side CSV path and for streaming the
 * server-generated XLSX/PDF blobs to disk.
 *
 * Client-only (touches `document` / `URL`).
 */

/** Trigger a browser download of `data` as `filename`. */
export function downloadFile(
  filename: string,
  mime: string,
  data: string | Blob | ArrayBuffer | Uint8Array
): void {
  const blob =
    data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Strip characters that are illegal/awkward in a download filename. */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "export"
  );
}

/**
 * Build a `Content-Disposition` header that cannot throw on a non-ASCII name.
 *
 * HTTP header values are ByteStrings — every character must fit in one byte —
 * and the runtime enforces it by THROWING when the Response is constructed, not
 * by mangling the name. So a single curly quote, accented letter, em dash or
 * ellipsis in a filename turns the whole download into a 500.
 *
 * That is not hypothetical: Orion titles a conversation from its first message
 * and truncates at 48 characters with "…", so every long-titled conversation
 * failed with "character at index 70 has a value of 8230".
 *
 * The fix is the RFC 5987 pair. `filename` carries an ASCII-folded fallback for
 * anything that only understands the original form, and `filename*` carries the
 * real UTF-8 name percent-encoded. Browsers prefer the starred one, which is
 * also what `filenameFromDisposition` above reads first, so the saved file keeps
 * its real name.
 */
export function contentDisposition(
  filename: string,
  disposition: "attachment" | "inline" = "attachment"
): string {
  // Anything outside printable ASCII is dropped (that is the ByteString
  // limit), and quotes/backslashes would end the quoted-string early.
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Parse the `filename` out of a `Content-Disposition` header, if present. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}

/**
 * Fetch an export URL and save the response to disk. Throws on a non-2xx
 * response (e.g. a 403 from the permission gate) so callers can surface it.
 * Uses the server-provided `Content-Disposition` filename, falling back to
 * `fallbackName`.
 */
export async function fetchAndDownload(
  url: string,
  fallbackName: string
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const name =
    filenameFromDisposition(res.headers.get("Content-Disposition")) ??
    fallbackName;
  downloadFile(name, blob.type || "application/octet-stream", blob);
}

/**
 * Fetch a PDF export URL and open the browser print dialog on it. Fetches the
 * bytes (rather than navigating) so it works regardless of the route's
 * `Content-Disposition`, then loads the blob into an offscreen iframe and prints
 * that — keeping the user on the page. Falls back to opening the PDF in a new
 * tab if the iframe can't be printed (e.g. a popup/PDF-viewer quirk). Throws on
 * a non-2xx response so callers can surface a permission error.
 */
export async function fetchAndPrint(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Print failed (${res.status})`);
  }
  const objectUrl = URL.createObjectURL(await res.blob());
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      window.open(objectUrl, "_blank", "noopener");
    }
  };
  iframe.src = objectUrl;
  document.body.appendChild(iframe);
  // Revoke + remove well after the print dialog has taken over the blob.
  setTimeout(() => {
    iframe.remove();
    URL.revokeObjectURL(objectUrl);
  }, 60_000);
}
