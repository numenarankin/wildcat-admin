// Vector-tile endpoint for Scout's well dots.
//
// Mapbox GL JS v3 has no `addProtocol` (that is a MapLibre API), so tiles are
// served as standard {z}/{x}/{y} MVT from this route rather than read in the
// browser. Tiles are clustered on the fly from the synced points file — see
// src/lib/scout/live-tiler.ts.
//
// GATED: tiles are the whole dataset in map form, so this route re-checks
// the platform-admin gate on every request instead of trusting that the page hid the link.
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { liveTile } from "@/lib/scout/live-tiler";

export const runtime = "nodejs";

/**
 * Per-request trace, one line per phase, so a tile that never completes shows
 * which phase it stopped in. `[recon-tile] z/x/y +ms phase`.
 */
function trace(tile: string, t0: number, phase: string) {
  console.log(`[recon-tile] ${tile} +${Math.round(performance.now() - t0)}ms ${phase}`);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ z: string; x: string; y: string }> }
) {
  const t0 = performance.now();
  const { z, x, y } = await ctx.params;
  const tile = `${z}/${x}/${y}`;
  trace(tile, t0, "received");
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) {
    trace(tile, t0, `denied ${denied.status}`);
    return denied;
  }
  trace(tile, t0, "auth ok");

  const zi = Number.parseInt(z, 10);
  const xi = Number.parseInt(x, 10);
  const yi = Number.parseInt(y.replace(/\.(mvt|pbf)$/, ""), 10);
  if ([zi, xi, yi].some(Number.isNaN)) {
    return new Response("bad tile coordinates", { status: 400 });
  }

  // A fresh copy owns a plain ArrayBuffer, which is what `Response` accepts.
  let data: Uint8Array<ArrayBuffer> | null;
  try {
    const buf = await liveTile(zi, xi, yi);
    data = buf ? new Uint8Array(buf) : null;
  } catch (err) {
    console.error(`[recon-tile] ${tile} tile read FAILED`, err);
    return new Response("tile error", { status: 500 });
  }
  if (!data) {
    trace(tile, t0, "empty -> 204");
    return new Response(null, { status: 204 });
  }
  trace(tile, t0, `built ${data.byteLength} B`);

  // Raw MVT, no hand-set `Content-Encoding: gzip`: compression is the
  // server's job. Pre-gzipped bodies were the only responses that never
  // reached the browser on localhost (empty 204 tiles did), which stalled the
  // map on its first idle forever.
  trace(tile, t0, "returning 200");
  return new Response(data, {
    headers: {
      "Content-Type": "application/vnd.mapbox-vector-tile",
      // Private: the response is per-user authorized, so no shared cache may
      // keep it for the next (possibly ungated) requester.
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
