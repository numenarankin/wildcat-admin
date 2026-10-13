import path from "node:path";
import type { NextConfig } from "next";

/**
 * The Wildcat admin app: the insiders' side that used to live at /admin inside
 * the customer app. It shares the customer app's Supabase project, so every
 * read and write here lands in the same database.
 */
const nextConfig: NextConfig = {
  turbopack: {
    // `~/dev` holds several unrelated projects, each with its own lockfile.
    // Turbopack would otherwise root itself at the outermost one.
    root: path.resolve(import.meta.dirname),
  },
  // The Prospecting map reads its synced RRC artifacts off disk by absolute
  // path (src/lib/scout/data-files.ts), which file tracing cannot see, so
  // they are named here or the deploy ships without them (the Targets HQ
  // county read takes the Texas county outlines the same way). Named, not
  // `.scout-data/**`, so the sync script's US.txt stays out.
  outputFileTracingIncludes: {
    "/prospecting": ["./.scout-data/*.json", "./.scout-data/*.json.gz", "./public/tx-counties.json"],
    "/api/scout/**": ["./.scout-data/*.json", "./.scout-data/*.json.gz"],
  },
  experimental: {
    serverActions: {
      // Support replies and Drive uploads carry attachments through Server
      // Actions, which buffer the whole body. Same ceiling as the customer app.
      bodySizeLimit: "110mb",
    },
    // `src/proxy.ts` matches nearly every route, so its body-clone limit must
    // rise with `bodySizeLimit` or large bodies are truncated mid-stream.
    proxyClientMaxBodySize: "110mb",
  },
};

export default nextConfig;
