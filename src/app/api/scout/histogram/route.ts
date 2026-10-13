import { readFileSync } from "node:fs";
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { SCOUT_HISTOGRAMS_PATH } from "@/lib/scout/data-files";
import { isHistogramField, type Histogram } from "@/lib/scout/histogram";

export const runtime = "nodejs";

/**
 * The statewide population behind one range filter.
 *
 * Serves `.scout-data/histograms.json`, written by
 * `scripts/scout-sync-histograms.ts`. The scan that produces it straddles the
 * request pool's 5 s statement timeout (2.0 s to 4.9 s across three consecutive
 * runs, measured 2026-08-21), and its answer only changes when the mirror is
 * reloaded, so it is a sync artifact and this route is a read. Same arrangement
 * as the well points, and the same failure mode: no file means 503, not an empty
 * chart, because a range control drawn over zero wells is a lie about Texas.
 *
 * A GET whose answer depends on nothing but the field name, so it caches at
 * every layer that understands HTTP and one URL serves every user. It is still
 * gated: the mirror connection is service-role and an open Scout route is a
 * scraping endpoint (`nav.test.ts` walks this directory and greps for the call).
 */
let file: Record<string, Histogram> | null = null;

function read(): Record<string, Histogram> {
  // Read once per process. The file is a few kilobytes and never changes under
  // a running server; a new sync ships with a deploy, like the points file.
  file ??= JSON.parse(readFileSync(SCOUT_HISTOGRAMS_PATH, "utf8"));
  return file!;
}

export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const field = new URL(req.url).searchParams.get("field") ?? "";
  if (!isHistogramField(field)) {
    return Response.json({ error: "unknown field" }, { status: 400 });
  }

  try {
    const hit = read()[field];
    if (!hit) {
      return Response.json({ error: "field not synced" }, { status: 503 });
    }
    return Response.json(hit, {
      headers: { "Cache-Control": "private, max-age=3600" },
    });
  } catch (err) {
    console.error("[scout/histogram]", err);
    return Response.json(
      { error: "not synced: run scripts/scout-sync-histograms.ts" },
      { status: 503 }
    );
  }
}
