import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import {
  getApprovedPermits,
  getPendingQueue,
  PERMIT_MAP_CAP,
} from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

/**
 * The pending-permit queue as GeoJSON, for the map's Permits mode.
 *
 * Whole, not by viewport: ~500 applications is one small payload, and the
 * queue's value is being able to see the whole state's activity at once.
 *
 * Permits with no resolvable position are dropped. 9 of the 544 pending
 * applications report no location in any of the four forms the feed carries,
 * and there is nowhere on a map to put them; `total` still counts them, so the
 * key reports the size of the queue rather than the number of dots.
 */
export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  /*
   * The pending queue is served WHOLE and the decided history is not.
   *
   * Pending is ~515 applications and is the point of the mode, so it is always
   * complete and always drawn. The decided set is heading for ~51,000 once the
   * full published history is loaded, which is 7 MB of GeoJSON nobody asked
   * for; it is scoped to the viewport and capped newest-first.
   */
  const parts = (new URL(req.url).searchParams.get("bbox") ?? "")
    .split(",")
    .map(Number);
  const box =
    parts.length === 4 && parts.every((n) => Number.isFinite(n))
      ? { west: parts[0], south: parts[1], east: parts[2], north: parts[3] }
      : undefined;

  // Permits mode's date range (`YYYY-MM-DD`, inclusive) on the issue date.
  // Anything else is ignored rather than guessed at.
  const isDate = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const params = new URL(req.url).searchParams;
  const dates = { since: isDate(params.get("since")), until: isDate(params.get("until")) };

  try {
    const [pendingRows, approvedRows] = await Promise.all([
      getPendingQueue(),
      getApprovedPermits(box, undefined, dates),
    ]);
    // TWO collections, not one.
    //
    // The ~10,500 already-decided permits are clustered on the map and the ~515
    // pending ones are not, because pending is the thing this mode exists to
    // surface: fold them into the same clustered source and a fortnight's live
    // activity disappears inside a decade of history. Separate sources is what
    // lets one be clustered and the other always drawn.
    const rows = [
      ...approvedRows.map((r) => ({
        ...r,
        kind: (r.drilled ? "drilled" : "approved") as "drilled" | "approved",
      })),
      ...pendingRows.map((r) => ({ ...r, kind: "pending" as const })),
    ];
    const features = rows
      .filter((r) => r.surface_lat != null && r.surface_lon != null)
      .map((r) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [r.surface_lon, r.surface_lat],
        },
        properties: {
          doc: r.universal_doc_no,
          op: r.operator_name,
          opNo: r.operator_number,
          lease: r.lease_name,
          well: r.well_number,
          county: r.county_name,
          district: r.district_name,
          depth: r.total_depth,
          purpose: r.filing_purpose,
          state: r.current_state_code,
          submitted: r.submit_date,
          days: r.days_pending,
          horiz: r.horizontal ? 1 : 0,
          src: r.location_source,
          api: r.api_sequence_number,
          kind: r.kind,
        },
      }));

    const of = (kind: string) =>
      features.filter((f) => f.properties.kind === kind);
    return Response.json(
      {
        pending: { type: "FeatureCollection", features: of("pending") },
        history: {
          type: "FeatureCollection",
          features: features.filter((f) => f.properties.kind !== "pending"),
        },
        total: pendingRows.length,
        approved: approvedRows.length,
        drilled: approvedRows.filter((r) => r.drilled).length,
        // Said out loud so the caller can tell "this is the area" from "this is
        // the newest slice of the area".
        capped: approvedRows.length >= PERMIT_MAP_CAP,
      },
      // Twice-daily feed behind a nightly sync, so a minute of caching costs
      // nothing and stops a mode toggle re-querying.
      { headers: { "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    console.error("[scout/rrc/pending]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
