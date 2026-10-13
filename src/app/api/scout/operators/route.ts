// Operator points for Scout's "operators" map mode — every P-5 operator with at
// least one well, placed at its mailing-ZIP centroid.
//
// Archon ships the same payload as a static `public/operators.json`. Here it
// must not be public (it is a full operator list with addresses), so it is
// served from the gitignored `.scout-data/` directory through this gated route.
import { readFile, stat } from "node:fs/promises";
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import {
  SCOUT_OPERATORS_GZ_PATH,
  SCOUT_OPERATORS_PATH,
} from "@/lib/scout/data-files";

export const runtime = "nodejs";

// The payload is ~4 MB (~1 MB gzipped) and changes only on a monthly RRC
// refresh, so both forms are held in memory rather than re-read per request.
// Keyed on the file's mtime so a re-run of scripts/scout-sync-data.mjs is picked
// up without a restart — one `stat` per request, versus a 4 MB read.
const cache = new Map<
  string,
  { mtimeMs: number; etag: string; body: Buffer | string }
>();

async function load<T extends Buffer | string>(
  path: string,
  read: () => Promise<T>
): Promise<{ body: T; etag: string } | null> {
  try {
    const { mtimeMs, size } = await stat(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) {
      return { body: hit.body as T, etag: hit.etag };
    }
    const body = await read();
    const etag = `"${mtimeMs.toString(36)}-${size.toString(36)}"`;
    cache.set(path, { mtimeMs, etag, body });
    return { body, etag };
  } catch {
    cache.delete(path);
    return null;
  }
}

/**
 * `no-cache` + ETag, NOT `max-age`.
 *
 * An earlier `max-age=86400` here meant a browser that had loaded the map kept
 * its copy for a day — so after a re-sync added production figures, the client
 * kept filtering against a payload where every operator read as zero and any
 * production filter blanked the map. Revalidating costs one conditional request
 * and returns 304 (no body) whenever the file hasn't changed.
 *
 * `private` because the response is per-user authorized: no shared cache may
 * hold it for the next, possibly ungated, requester.
 */
const CACHE_CONTROL = "private, no-cache";

export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const wantsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
  const inm = req.headers.get("if-none-match");

  // Prefer the precompressed file; fall back to the raw JSON when the client
  // can't take gzip, or when the sync script predates the .gz output.
  if (wantsGzip) {
    const gz = await load(SCOUT_OPERATORS_GZ_PATH, () =>
      readFile(SCOUT_OPERATORS_GZ_PATH)
    );
    if (gz) {
      if (inm === gz.etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: gz.etag, "Cache-Control": CACHE_CONTROL },
        });
      }
      return new Response(new Uint8Array(gz.body), {
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          ETag: gz.etag,
          "Cache-Control": CACHE_CONTROL,
        },
      });
    }
  }

  const raw = await load(SCOUT_OPERATORS_PATH, () =>
    readFile(SCOUT_OPERATORS_PATH, "utf8")
  );
  if (raw === null) {
    console.error("scout operators read failed", SCOUT_OPERATORS_PATH);
    return Response.json(
      {
        error: "unavailable",
        reason: "missing_data",
        hint: "run scripts/scout-sync-data.mjs",
      },
      { status: 503 }
    );
  }

  if (inm === raw.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: raw.etag, "Cache-Control": CACHE_CONTROL },
    });
  }

  return new Response(raw.body, {
    headers: {
      "Content-Type": "application/json",
      ETag: raw.etag,
      "Cache-Control": CACHE_CONTROL,
    },
  });
}
