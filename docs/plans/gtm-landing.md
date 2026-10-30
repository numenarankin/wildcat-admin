# GTM: the Landing tab

Status: BUILT (2026-10-30), not yet live. Verified offline: the derivations
by hand oracles (`src/lib/admin/gtm/*.test.ts`), and end to end against the
migration on a throwaway local database behind PostgREST: the landing's
`/api/track` under every gate, the Snitcher webhook's store, retry, signature
refusals and location read (Snitcher's API answered locally), the page's
readers, and the tracker itself in jsdom. Nothing has been seen in a browser
and no real visit or Snitcher delivery has gone through.

Needs, before it works for real:
- migration `supabase/migrations/2026103000100_gtm_tracking.sql` pushed to the
  GTM project (the user pushes);
- landing deployment: `GTM_SUPABASE_URL`, `GTM_SUPABASE_SECRET_KEY`;
- admin deployment: `GTM_SUPABASE_URL`, `GTM_SUPABASE_SECRET_KEY`,
  `SNITCHER_WEBHOOK_SECRET` (set the same secret on the webhook in Snitcher,
  pointed at `https://<admin host>/api/gtm/snitcher`), `SNITCHER_API_TOKEN`,
  optionally `SNITCHER_WORKSPACE_UUID`; `CRON_SECRET` is already there;
- in Snitcher: an Automation sending "Session started" (and new company /
  company returns) to that webhook;
- the webhook payload does not match Snitcher's docs (seen 2026-10-30: a
  `new_session` event with a `subjects` list, no session id, the company's
  uuid only inside a dashboard link). Every delivery is kept raw in
  `snitcher_deliveries` (migration `2026103100100`) until the parser is
  rewritten to the real shape.

Where it lives. Landing: `src/lib/track/` (config, tracker, geo, types),
`src/app/api/track/route.ts`, `src/components/analytics/{tracker,snitcher-tracker}.tsx`,
the demo hooks in `src/components/screens/demo-active.tsx`. Admin:
`src/lib/admin/gtm/` (db, types, derive, read, actions, snitcher, format),
`src/app/api/gtm/snitcher/route.ts`, `src/app/api/cron/gtm-snitcher-locations/route.ts`
(hourly, `vercel.json`), `src/app/(admin)/gtm/page.tsx`,
`src/components/admin/gtm/`. Page key `gtm` in `src/lib/admin/pages.ts`, so
an admin needs it on their page list. The GTM project is its own Supabase
project with its own migration history in `admin/supabase/migrations`
(Wildcat-project migrations still go in wildcat).

## Goal

Show who comes to wildcatiq.ai, from where, and what they do there: how many
visits and unique visitors the landing gets, where those visitors are, which
companies they are, and which product demos they watch and how far. Over time
this tells us which demos interest people and, joined to the sales pipeline,
which demos drive sales.

## Only production traffic is recorded

Testing must never reach the data. Three independent gates, each enough on
its own:

1. **The tracker never starts off the real domain.** It runs only when
   `location.hostname` is `wildcatiq.ai` or `www.wildcatiq.ai` in a
   production build. Localhost, `*.vercel.app` previews and any other host
   load nothing and send nothing.
2. **`/api/track` drops anything that is not production.** It accepts a
   batch only when `VERCEL_ENV === "production"` and the request's `Origin`
   is one of the two hosts above; anything else gets a `204` and is not
   written, so a misconfigured client cannot leak data in either.
3. **Snitcher runs under the same hostname rule.** Its script is currently
   gated on `NODE_ENV` only, which still loads it on preview deployments; it
   moves behind the same hostname check as the tracker. Snitcher only sees
   visits where its script ran, so its webhook carries production visits only.

Also: a visit to `https://wildcatiq.ai/?notrack=1` sets a local flag that
stops the tracker (and Snitcher) in that browser for good, so the team's own
browsing of the live site stays out too. `?notrack=0` clears it. Visitors
whose browser reports `navigator.webdriver` (automation) are not tracked.

## What is collected

One tracker script in the landing (`src/lib/track/`), started from the root
layout.

- **Identity.** An anonymous visitor id in `localStorage` and a visit id in
  `sessionStorage`, both random UUIDs. No cookies, no fingerprinting.
- **Session.** Entry path, referrer, source (UTM source, else the
  referrer's kind: search, social, direct, other), all five UTM fields,
  device (desktop / tablet / mobile from the viewport and user agent),
  viewport size, and location (country, state, city, latitude, longitude)
  added by `/api/track` from Vercel's `x-vercel-ip-*` headers.
- **Engaged time.** Counts only while the tab is visible and focused and the
  visitor has moved, scrolled, clicked or typed in the last 30 seconds.
  Wall-clock time is not stored as engagement.
- **Scroll.** Position as % of the document (`(scrollY + innerHeight) /
  scrollHeight`), never pixels. The visit's maximum is kept on the session;
  milestones 25 / 50 / 75 / 90 / 100 fire once each per page per visit (the
  database enforces once).
- **Clicks.** One capture listener on the document: position as % of the
  document, and the element's tag, id, class and first 80 characters of
  visible text. Values typed into inputs are never read.
  - **Rage click:** 3 or more clicks within 1 second and 30 px of each
    other, recorded once per burst.
  - **Dead click:** the click lands on nothing interactive (no link, button,
    input, label, `role="button"` or `[data-track]` ancestor) and neither the
    URL nor the DOM changes within 500 ms.
  - **Hover dwell:** the pointer rests 1 second or more on a link, button or
    `[data-track]` element; the dwell time is stored.
- **Demos.** `DemoActiveProvider` (`src/components/screens/demo-active.tsx`)
  already knows when a demo comes into view and restarts it when it leaves.
  It reports a play's start; each scripted demo reports its progress through
  one shared hook (`useDemoProgress(demo, step, steps)`) as the % of its
  steps reached. Per play: demo, play number within the visit, furthest %
  reached, whether it finished a loop, and time watched. Watching is passive,
  so a demo's time counts whenever the tab is visible and focused, with no
  idle cutoff (the visit's engaged time keeps the 30 s rule). Plays are
  counted per page: the home page's Orion demo and the Orion page's are two
  rows. A demo with no steps (Dashboard, Reports, Flow map) records plays and
  watch time, and its progress stays empty rather than reading 0%.

Events queue in memory and go to `/api/track` every 5 seconds and on
`pagehide` (via `sendBeacon`). Every event carries a client-made id, so a
batch sent twice writes once. `/api/track` truncates text fields, rejects
malformed batches, and limits each IP to a fixed number of batches a minute.

**Snitcher.** Its webhook (session started, new company, company returns)
posts to a public route in admin, `/api/gtm/snitcher`, which verifies the
HMAC-SHA256 `Signature` header against the webhook secret, upserts the
company, and stores the delivery once by Snitcher's session id (Snitcher
retries up to five times). Snitcher's tracker ignores `setAnonymousId`, so
our tracker instead reads the id Snitcher's script stores in the browser
(`radar_device_id`) and sends it with every batch; it lands on
`visitors.snitcher_visitor_id` (migration `2026103100200`). That is the
`visitor_uuid` on every Snitcher session, so the location read links the
company to that visitor and the
Snitcher session to our visit that started within 30 minutes of it, and
through it the company joins to
the visitor and everything they did. The webhook location is the company's
headquarters; the visitor's own location comes from our session.

**Snitcher's visitor location.** The webhook carries city, region and country
but no coordinates; Snitcher's REST API has them on each session
(`location.latitude` / `longitude`, with city and state). After storing a
delivery, the webhook route calls `GET /v1/workspaces/{workspace}/organisations/{organisation}/sessions`
(Bearer `SNITCHER_API_TOKEN`), filtered to the session's date, and copies the
matching session's location onto the `snitcher_sessions` row. There is no
single-session endpoint, so the match is by session id within that list. One
call per delivery sits well inside the 60 requests a minute limit. If the
call fails or finds no match, the row is kept with its location empty and
`location_fetched_at` unset, and a later webhook for the same company, or a
sweep of unset rows, fills it in. Before relying on the match, one real
delivery has to confirm the webhook's session and company ids are the same
UUIDs the API returns (Snitcher's webhook example shows short ids like
`sess_123`). Our own session's Vercel coordinates stay the map's source for
every visit; Snitcher's are the cross-check, and the fallback when a visit
has no session of ours (the tracker blocked, Snitcher's script not).

## Storage

Six tables in the GTM project, in the migration above. RLS is on with no
policies, and `anon` / `authenticated` have no grants: only server code with
the GTM secret key reads or writes.

| Table | One row per | Holds |
|---|---|---|
| `companies` | Snitcher organisation | name, domain, industry, size, HQ city/state/country, first/last seen, raw payload |
| `visitors` | browser | first/last seen, visit count, linked company |
| `sessions` | visit | entry path, referrer, source, UTMs, device, viewport, country/state/city, latitude/longitude, engaged ms, max scroll % |
| `events` | pageview, scroll milestone, click, rage click, dead click, hover | time, path, scroll %, x/y %, element tag/id/class/text, hover ms |
| `demo_views` | play of one demo | play number, started at, furthest %, completed, watched ms |
| `snitcher_sessions` | Snitcher session | company, our session, event, start, pages viewed, referrer, visitor city/state/country/latitude/longitude (from the API), when that was fetched, raw payload |

About 10 to 15 KB per visit, so roughly 150 MB a year at 1,000 visits a month.

## The page

`/gtm` in admin, behind `requireAdminPage`, in the admin chrome. A segmented
tab switch on the left of the toolbar (the one `/analytics` uses,
`analytics-workspace.tsx`); Landing is the first and only tab. A range control (7 / 30 / 90 days, default 30) applies to
everything below it.

**Summary stats** across the top in one compact row, the dashboard's
`AdminSummaryStats` style: Visits, Unique visitors, Identified companies,
Texas share (of visits), Top city. Each with its change against the previous
period of the same length.

**Below the stats, a View dropdown** (Visitors / Map / Demos), the way
Recon's View selector swaps the area under its bar. One view at a time.

- **Visitors (default).** One row per visitor, `CustomersTable` styling,
  sortable, newest first: company (or "Anonymous"), location, visits,
  engaged time, max scroll, demos watched, last seen. A row opens the
  visitor panel.
- **Map.** The Prospecting map's base (`src/components/admin/prospecting/targets-map.tsx`:
  Mapbox, `MapControls` basemaps, Texas county lines, opens on Texas bounds,
  clusters when zoomed out). Its own date range filter (Last 7 days, Last
  30 days, Last 90 days, or a custom start and end), defaulting to the last
  7 days, independent of the page's range. One blue dot per visitor seen in
  that range, at the location of their latest visit in it. Dots in the same city sit on the same point, so the
  cluster count shows how many. Clicking a dot opens the visitor panel.
  Locations are city-level from the IP address, never the visitor's exact
  position.
- **Demos.** One row per demo: plays, unique viewers, average furthest %,
  completion rate, average time watched. This is the table that will later
  gain a column for how many viewers became pipeline.

**Visitor panel** (`SwipeUpModal`, as the target modal opens): everything we
hold on that visitor, in tabs.

- Summary: company (from Snitcher) or Anonymous, location, first and last
  seen, visits, total engaged time, device, source of first visit.
- Visits: each session with its date, entry path, referrer, engaged time and
  max scroll.
- Activity: the chosen visit's timeline: pageviews, scroll milestones,
  clicks (with rage and dead flagged), hovers.
- Demos: each demo they watched, how many times, the furthest % and whether
  they finished it.

## Limits chosen here

Named so they can be changed in one place: 30 s idle cutoff for engaged
time; 5 s send interval; 80-character element text; 1 s hover threshold;
rage = 3 clicks / 1 s / 30 px; dead = 500 ms with no change; 30-day default
range for the page, 7-day default range for the Map.

## Build order

1. Push the migration; add the GTM env vars to both deployments.
2. Landing: the tracker and `/api/track`, with the three production gates.
3. Admin: the Snitcher webhook route, its signature check, and the follow-up
   API call for the session's location (needs `SNITCHER_API_TOKEN`).
4. Admin: readers (`src/lib/admin/gtm/`), then the page: stats, Visitors,
   visitor panel, Map, Demos.
5. Verify each gate refuses non-production traffic, then a real visit to
   wildcatiq.ai lands in every table.
