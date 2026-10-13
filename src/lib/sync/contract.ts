/**
 * The mobile sync contract. THIS FILE IS THE INTERFACE, and it is frozen: the
 * endpoint, the device's sync engine and the conformance suite are all written
 * against it independently, so a change here invalidates work in three places at
 * once. Change `SYNC_PROTOCOL` when it must change anyway.
 *
 * The design and the reasoning behind every field live in
 * `wildcat-phone/docs/plans/local-first-mobile.md`, Gap 1. In short: the mobile
 * app reads a local SQLite mirror and nothing else, and reconciles through this
 * one endpoint once a minute while it is open. One request carries the device's
 * cursor and whatever it has queued; one response carries what changed and a new
 * cursor.
 *
 * This module is PURE (no server-only imports, no `next/*`) so it can be copied
 * verbatim into the Expo app, the way `settings/org.ts` is. The two copies must
 * stay identical; the webapp's is the original.
 *
 * Four rules this shape exists to enforce:
 *
 *  1. **The cursor is opaque to the client.** The device stores whatever it is
 *     given and hands it back. No clock arithmetic on a handset, whose clock is
 *     wrong in ways an offset cannot model, and the server stays free to change
 *     what a cursor IS (a timestamp today, an LSN later) without an app release.
 *  2. **Every op gets its own result.** Last-write-wins means ops lose, and the
 *     device cannot clear `pending`, show "edit skipped", or decide whether to
 *     retry from a blanket 200.
 *  3. **Retry is safe.** Every op carries a client-generated `id` that is stable
 *     across retries, so a response lost in transit costs a duplicate REQUEST,
 *     never a duplicate ROW.
 *  4. **Windows are resolved once, on the server.** `floorDate` comes back with
 *     the cursor so the initial pull, the backfill and the device's prune all
 *     use the same date. A device computing "30 days ago" for itself is an
 *     off-by-one-day bug at every timezone boundary.
 */

/** Bumped only for a breaking change. The server rejects anything it predates. */
export const SYNC_PROTOCOL = 1;

/**
 * The collections the mirror carries. Ordered parents-first: a device applying a
 * response in this order never holds a reading whose facility it has not seen.
 */
export const SYNC_COLLECTIONS = [
  "leases",
  "wells",
  "tank_batteries",
  "tanks",
  "meters",
  "employees",
  "contractors",
  "service_providers",
  "royalty_owners",
  "gatherers",
  "purchasers",
  "inventory_items",
  "tasks",
  "calendar_events",
  "tank_readings",
  "meter_readings",
  // --- The leases path. Everything a facility page writes. -------------------
  // Behind a server-side switch until 2026090100200 and 2026090100300 are
  // applied: six of these tables have no `updated_at` until the first, and all
  // but `run_tickets` hard-delete, so without the second a device never learns
  // a row was removed. See `EXTENDED_COLLECTIONS` in `collections.ts`.
  "well_tests",
  "well_events",
  "well_service",
  "well_shots",
  "well_pumping",
  "well_equipment",
  "well_filter_changes",
  "disposal_readings",
  "run_tickets",
  "tank_call_ins",
  "production_readings",
  // --- The leases path, second batch (2026-09-03). ---------------------------
  // The rows the allocation engine, the flow graph and the interest derivation
  // read, so those services can run on the device. Parents first: an interest
  // holding names an `org_wi_owners` row, a measurement names its campaign.
  // Every one of these is a COMPLETE SET; see `WINDOWED_COLLECTIONS`.
  "org_wi_owners",
  "royalty_owner_wells",
  "tank_well_allocations",
  "meter_well_allocations",
  "battery_well_allocations",
  "flow_connections",
  "gas_test_campaigns",
  "gas_test_measurements",
  "meter_volume_statements",
  // --- Notes, comments and the org's well info sheet (2026-09-04) -----------
  // The last two read-and-write surfaces that still went to the network on
  // every open, plus the sheet the well page's Info tab renders. Parents first:
  // a tag names its note, a like names its comment.
  //
  // Dark until `2026090400200_notes_comments_sync.sql` is applied — `note_tags`
  // and `facility_comment_likes` have no `updated_at` without it, and the
  // likes table has no `id` for the pull to page on. See `WAVE4_COLLECTIONS`
  // in `collections.ts`.
  "notes",
  "note_tags",
  "facility_comments",
  "facility_comment_likes",
  "well_info_fields",
] as const;

export type SyncCollection = (typeof SYNC_COLLECTIONS)[number];

/**
 * The collections bounded by `floorDate` rather than pulled whole. Everything
 * else is small enough to carry entirely. See Gap 5: one month on the first
 * sync, backfilled to a twelve-month cap, never older.
 *
 * **None of the nine added on 2026-09-03 is windowed**, and that was decided
 * rather than defaulted into. Allocations, interests, flow edges and campaigns
 * are configuration: an effective-dated split written two years ago is what
 * today's barrels are allocated by, so a window cut on `effective_from` would
 * drop the row the engine needs most. `gas_test_measurements` looks windowable
 * (it has `start_at`) and is not: a campaign's split is in force from its
 * measurements' window until the next campaign, indefinitely, and a device that
 * had pruned the measurements would derive a different split from the web. All
 * nine are small per org (hundreds of rows) and come whole.
 */
export const WINDOWED_COLLECTIONS: readonly SyncCollection[] = [
  "tank_readings",
  "meter_readings",
  "well_tests",
  "well_events",
  "well_service",
  "well_shots",
  "well_pumping",
  "well_filter_changes",
  "disposal_readings",
  "run_tickets",
  "tank_call_ins",
  "production_readings",
];

/**
 * The column each windowed collection's `floorDate` is cut on.
 *
 * Named here rather than left to each side to know, because BOTH sides act on
 * it and they must agree: the server cuts its query on this column, and the
 * device prunes rows that have fallen below the floor on the same one. The
 * contract said which collections were windowed and never which column, so the
 * rule lived in two registries with no shared source, and the device's copy was
 * `reading_date` hard-coded for all of them. Of the twelve, two carry that
 * column. The other ten were pruned by nothing at all and the mirror grew
 * without bound, silently.
 *
 * Two properties a reader has to know, both of which cost data if missed:
 *
 *  - **Not every one is a `date`.** `tank_call_ins.called_in_at` is a
 *    timestamptz. Compare on the civil date, per Gap 8.
 *  - **`well_service.date` is NULLABLE.** A row with no value here is not a row
 *    from before the window and must never be cut. The server includes them
 *    unconditionally; the device must not prune them.
 */
export const WINDOW_COLUMNS: Record<string, string> = {
  tank_readings: "reading_date",
  meter_readings: "reading_date",
  well_tests: "test_date",
  well_events: "start_date",
  well_service: "date",
  well_shots: "shot_date",
  well_pumping: "effective_date",
  well_filter_changes: "changed_date",
  disposal_readings: "reading_date",
  run_tickets: "ticket_date",
  tank_call_ins: "called_in_at",
  production_readings: "reading_date",
};

/**
 * `well_equipment` is deliberately NOT windowed, unlike everything else on the
 * leases path. Its only date is `installed_at`, which is nullable and records
 * when a pump was put down a hole rather than when the row was touched, so a
 * window cut on it would drop every piece of equipment nobody recorded a date
 * for. It is a small per-well configuration table, so it comes whole.
 */

// --- Requests ---------------------------------------------------------------

/**
 * Every entity a device may WRITE, mapped to the collection it mirrors.
 *
 * The op type is `${entity}.${action}`, derived from this map rather than
 * written out by hand, so adding a write type is one line here and a compile
 * error everywhere that has to handle it. Hand-maintaining sixty-odd union
 * members was fine for the two reading types and stops being fine at the
 * ~30 entities the leases path needs.
 *
 * **The entity name is not the collection name, and must not be "corrected" to
 * match it.** `tank_reading` mirrors `tank_readings`. The op type is a WIRE
 * string: it is stamped into queued ops that sit in a handset's outbox across
 * app updates, and it is the idempotency ledger's key on the server. Renaming
 * `tank_reading.add` to `tank_readings.add` would strand every op already
 * queued in the field, which is the one class of data loss this whole design
 * exists to prevent. Singular is simply what shipped first.
 *
 * An entity appears here only once the endpoint can actually apply it. A device
 * that sends an op for an entity the server has no spec for gets `rejected` with
 * `invalid`, which is safe but is a bug, not a plan.
 */
export const WRITE_ENTITIES = {
  tank_reading: "tank_readings",
  meter_reading: "meter_readings",
  task: "tasks",
  calendar_event: "calendar_events",
  inventory_item: "inventory_items",
  employee: "employees",
  contractor: "contractors",
  service_provider: "service_providers",
  royalty_owner: "royalty_owners",
  gatherer: "gatherers",
  purchaser: "purchasers",
  // --- The leases path -------------------------------------------------------
  // Singular, and frozen once shipped: see the note above on why an entity name
  // is a wire string and not a tidier spelling of its collection.
  well_test: "well_tests",
  downtime: "well_events",
  well_service: "well_service",
  well_shot: "well_shots",
  well_pumping: "well_pumping",
  well_equipment: "well_equipment",
  filter_change: "well_filter_changes",
  disposal_reading: "disposal_readings",
  run_ticket: "run_tickets",
  call_in: "tank_call_ins",
  production_reading: "production_readings",
  // --- Allocations and interests (2026-09-03) --------------------------------
  // One ROW each, deliberately. The webapp's allocation writers are keyed by
  // (facility, well) and some replace a facility's whole set
  // (`replaceBatteryAllocations`); the contract stays row-shaped anyway, and a
  // device expresses a set change as a diff of row ops against its mirror
  // (deletes, then adds and edits), in one parent's order. A "replace the set"
  // op would be the one shape whose retry is NOT safe under rule 3: replayed
  // after a later edit it would wipe that edit, where a row op merely loses.
  //
  // `flow_connections` and `org_wi_owners` are mirrored and NOT writable from
  // a device yet.
  tank_allocation: "tank_well_allocations",
  meter_allocation: "meter_well_allocations",
  battery_allocation: "battery_well_allocations",
  lease_interest: "royalty_owner_wells",
  // --- Gas tests and settlements (2026-09-03, wave 3) ------------------------
  // A gas well test is one campaign row plus its measurement rows, each a row
  // op under its own parent (the campaign under its meter, a measurement under
  // its campaign), in that order. A settlement is the gas analogue of a run
  // ticket: soft-deleted, tombstone in the row.
  gas_test_campaign: "gas_test_campaigns",
  gas_test_measurement: "gas_test_measurements",
  meter_volume_statement: "meter_volume_statements",
  // --- The facilities themselves --------------------------------------------
  // Creating a lease, a tank, a meter or a battery. Their collections have been
  // mirrored since the first version, so unlike the leases path these need no
  // migration and are live immediately.
  //
  // `well` is deliberately ABSENT. Every other id here is a uuid the device can
  // mint alone; `wells.id` is a SLUG derived from the name, and the current
  // create resolves collisions by asking the server which slugs are taken
  // (`use-wells.ts:551-563`). A read-then-write cannot happen offline, so an
  // offline well create needs the device to disambiguate against its own mirror
  // and the server to arbitrate a genuine collision. That is a design decision,
  // not a missing registry line, and it is written up in the plan.
  lease: "leases",
  tank: "tanks",
  meter: "meters",
  battery: "tank_batteries",
  /**
   * `wells.id` is a SLUG derived from the name, not a uuid, which makes this the
   * one entity whose id the device cannot mint alone with certainty. It derives
   * the slug from its own mirror (a complete-set collection, so it holds every
   * well the member can see) and the SERVER arbitrates a genuine collision: two
   * handsets creating "Smith 1" offline both mint `smith-1`, and the second
   * insert would otherwise be a duplicate-key rejection that loses a well.
   *
   * On a collision the server mints the next free slug and returns the row under
   * it. The device already handles an id it did not choose - `adoptRow` deletes
   * the local row and stores the returned one - which is the same path an
   * `add` that was `replaced` takes.
   */
  well: "wells",
  // --- Notes and comments (2026-09-04) ---------------------------------------
  // A note's TAGS are row ops under the note, the same shape the allocation
  // tables use: the editor replaces a note's tag set, and the device expresses
  // that as deletes then adds against its mirror rather than as a "replace the
  // set" op whose retry could wipe a later edit.
  //
  // `comment_like` is an add or a delete and never an edit. Its row carries the
  // liker (`user_id`, defaulted to `auth.uid()` and pinned there by RLS), so
  // the device never sends one: a device cannot like on someone else's behalf,
  // and a queued like that drains after a handset changes hands must belong to
  // whoever is signed in when the server applies it, not to whoever was signed
  // in when it was queued.
  note: "notes",
  note_tag: "note_tags",
  facility_comment: "facility_comments",
  comment_like: "facility_comment_likes",
  // `well_info_fields` is mirrored and NOT writable from a device: the sheet is
  // edited in the admin-only Settings tab on the web, and its write policy is
  // `is_org_owner(org_id) or has_capability(org_id, 'admin')`
  // (2026081200300_well_info_fields.sql).
} as const satisfies Record<string, SyncCollection>;

export type WriteEntity = keyof typeof WRITE_ENTITIES;

export type SyncOpAction = "add" | "edit" | "delete";

export type SyncOpType = `${WriteEntity}.${SyncOpAction}`;

/** Split an op type into its parts. Null when the string is not one. */
export function parseOpType(
  type: string,
): { entity: WriteEntity; action: SyncOpAction; collection: SyncCollection } | null {
  const dot = type.lastIndexOf(".");
  if (dot < 0) return null;
  const entity = type.slice(0, dot);
  const action = type.slice(dot + 1);
  if (!Object.prototype.hasOwnProperty.call(WRITE_ENTITIES, entity)) return null;
  if (action !== "add" && action !== "edit" && action !== "delete") return null;
  const key = entity as WriteEntity;
  return { entity: key, action, collection: WRITE_ENTITIES[key] };
}

export interface SyncOp {
  /**
   * Client-generated and stable across retries. This is the idempotency key:
   * the server records it and a second arrival returns the first outcome rather
   * than applying anything again.
   */
  id: string;
  type: SyncOpType;
  /**
   * When the user actually made the change, in epoch ms on the SERVER's clock
   * (the device corrects for its own offset before queueing). This is what
   * arbitrates last-write-wins against the row's `updated_at`, so a handset with
   * a wrong clock must not be able to win or lose every conflict because of it.
   */
  madeAt: number;
  /** The row, shaped per `type`. Validated by the endpoint, never trusted. */
  payload: Record<string, unknown>;
}

export interface SyncRequest {
  protocol: number;
  /** Opaque, from the previous response. Null on a device that has never synced. */
  cursor: string | null;
  /** Queued writes. Empty on a pull-only tick, which is the common case. */
  ops: SyncOp[];
  /**
   * How far back the device wants windowed collections to reach, as a date the
   * SERVER previously gave it. Null asks for the default window (one month) and
   * is what a first sync sends; the backfill sends progressively older dates
   * until it reaches the twelve-month cap.
   */
  floorDate: string | null;
  /** Rows the client can accept in one response. The server may return fewer. */
  limit?: number;
}

// --- Responses --------------------------------------------------------------

/**
 * What became of one op.
 *
 * The distinction that matters to the outbox is `rejected` against `failed`:
 * rejected is permanent and the op must be dropped, failed is transient and the
 * op stays queued. Getting that backwards either loses a pumper's reading or
 * retries a doomed write eight times.
 */
export type SyncOpResult =
  | { id: string; status: "applied"; row: Record<string, unknown> }
  /** An add that took over a slot already holding an older live reading. */
  | { id: string; status: "replaced"; row: Record<string, unknown> }
  /**
   * Lost the last-write-wins comparison. `row` is the server's version, which
   * the device takes back, and `message` is what the user is shown.
   */
  | {
      id: string;
      status: "skipped";
      reason: "changed-on-server" | "newer-reading-exists";
      row: Record<string, unknown>;
      message: string;
    }
  /**
   * Permanently unacceptable. Drop the op. What happens to the LOCAL row
   * depends on {@link SyncRejectReason}, which is why it is enumerated.
   */
  | { id: string; status: "rejected"; reason: SyncRejectReason; detail?: string }
  /** Transient. The op stays queued and is retried on a later cycle. */
  | { id: string; status: "failed"; reason: string };

export interface SyncChange {
  collection: SyncCollection;
  /** Rows created or updated since the cursor, whole, in the mirror's shape. */
  rows: Record<string, unknown>[];
  /**
   * Ids that are gone. Carried explicitly because RLS on several tables HIDES
   * soft-deleted rows, so their absence from `rows` cannot be distinguished
   * from "unchanged" and a mirror would keep them forever.
   */
  deleted: string[];
}

export interface SyncResponse {
  protocol: number;
  /** Store this and send it next time. Opaque. */
  cursor: string;
  /**
   * There is more to fetch: call again immediately with the new cursor, before
   * counting the sync complete. This is how a first download pages, and how a
   * device that has been offline for a week catches up without a timeout.
   */
  hasMore: boolean;
  changes: SyncChange[];
  /** One entry per op in the request, in any order. */
  results: SyncOpResult[];
  /**
   * The floor the server applied to windowed collections, resolved in the org's
   * timezone. The device stores it and uses it for the backfill and the prune,
   * so all three agree by construction rather than by three date calculations
   * happening to match.
   */
  floorDate: string;
  /**
   * The member's capability keys (see `settings/org.ts`). Carried on every sync
   * so revoking access takes effect on the next cycle: a device holding rows a
   * member may no longer read is the one way a local mirror can leak.
   */
  permissions: string[];
  /** Server time in epoch ms, for the device's clock offset. */
  now: number;
  /**
   * The price snapshot the device prices dollars from, when it has changed.
   *
   * ADDITIVE, 2026-09-03 (no `CURSOR_VERSION` bump: an older device ignores the
   * field, an older cursor simply has no fingerprint and is sent the block).
   * Absent on a pass whose snapshot has the same `fingerprint` as the one the
   * device already holds - the server keeps that fingerprint inside the cursor
   * the way it keeps the collection fingerprints - so a steady tick carries
   * nothing here. See {@link SyncPricesBlock} for what it holds and why.
   */
  prices?: SyncPricesBlock;
}

// --- Prices ------------------------------------------------------------------

/**
 * Everything a device needs to put a dollar figure on a volume, in one block.
 *
 * Volumes derive on the device from mirrored rows. Dollars need two things that
 * cannot be mirrored: the benchmark feed (a live fetch the server makes) and
 * the org's realization model, which is FITTED on its settlement statements -
 * and statements stay off the device by decision
 * (`wildcat-phone/docs/reports/network-reads-leases-path-2026-09-03.md`,
 * "Decisions"). So the server fits the model, as it already does for every
 * priced page, and the sync response carries the result. The device prices
 * locally from the last block it received; prices are ALLOWED to be stale
 * between syncs, and a device flags a figure priced from a block older than
 * its staleness limit rather than blocking on the network for it.
 *
 * The shapes below are structurally the pricing modules' own
 * (`pricing/realization-model.ts`'s `RealizationModel`, `pricing/types.ts`'s
 * `PricePoint`, `pricing/posted-prices.ts`'s `RealizedMonth`), restated here so
 * this file stays free of imports and stays copyable.
 */
export interface SyncPriceModel {
  betaSelf: number;
  betaCross: number;
  alpha: number;
  months: number;
  measured: boolean;
  scale: number;
}

export interface SyncPriceModels {
  oil: SyncPriceModel;
  gas: SyncPriceModel;
  /** False when EITHER fell back to the prior; the UI marks a figure "est.". */
  measured: boolean;
}

export interface SyncPricePoint {
  /** `YYYY-MM-DD`. */
  date: string;
  price: number;
}

/**
 * One intraday bar: an epoch-SECOND stamp (the unit the upstream chart endpoint
 * speaks, kept as-is so the device's selection rule is the server's verbatim)
 * and that bar's close.
 */
export interface SyncPriceTick {
  at: number;
  price: number;
}

export interface SyncRealizedMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Volume-weighted realized price, USD per unit. */
  price: number;
  /** Units settled that month. */
  volume: number;
}

export interface SyncPricesBlock {
  /** ISO instant the snapshot was taken, on the server's clock. */
  asOf: string;
  /**
   * A stable digest of everything below EXCEPT `asOf`. Two snapshots with the
   * same content have the same fingerprint whenever they were taken, which is
   * what lets an unchanged block go unsent.
   */
  fingerprint: string;
  /**
   * The latest benchmark tick, USD per unit (`getBenchmarkPrice`): what
   * values production "right now", the same print every priced surface reads.
   * Null when the feed had nothing. (Named for the 24h average it once was;
   * the field's shape is unchanged.)
   */
  dayAverage: { oil: number | null; gas: number | null };
  /**
   * Daily benchmark closes, oldest first, covering the last
   * {@link PRICE_HISTORY_MONTHS}: what prices a volume ON A DATE
   * (`realizedPriceByDate` forward-fills business days).
   */
  history: { oil: SyncPricePoint[]; gas: SyncPricePoint[] };
  /**
   * The org's settled months over the fit window, per commodity: the posted
   * price the /prices chart draws and the forward projection anchors on. The
   * same ledger read the fit is made from, so nothing extra is scanned.
   */
  posted: { oil: SyncRealizedMonth[]; gas: SyncRealizedMonth[] };
  /**
   * Intraday benchmark bars over the last {@link PRICE_INTRADAY_DAYS}, oldest
   * first: what the ticker's 24-HOUR MOVE is read off.
   *
   * `history` cannot answer that question. It is daily closes, so differencing
   * its last two points gives a day-over-day SETTLE change, which is a
   * different number from "what has this moved in the last 24 hours" and
   * disagreed with the webapp's topbar chip. The webapp reads the last bar at
   * or before (now - 24h) out of exactly this series (`pricing/quote-change.ts`
   * `closeAtOrBefore`); carrying the series lets a handset apply that same rule
   * offline instead of being sent a pre-computed percentage that would be
   * frozen at the moment of the sync.
   *
   * Optional: a device on a build older than this ignores it, and a device on a
   * newer build than its server falls back to differencing `history`.
   */
  intraday?: { oil: SyncPriceTick[]; gas: SyncPriceTick[] };
  /**
   * The fitted realization: the company's models and one per lease that has
   * settled anything, keyed by lease id. `modelsFor` on the device is the same
   * fallback rule the server applies (a lease with no entry prices at the
   * company's).
   */
  realization: { company: SyncPriceModels; byLease: Record<string, SyncPriceModels> };
}

/**
 * How much benchmark history a block carries. The mirror's windowed
 * collections are capped at twelve months back (`floorDate`), so twelve months
 * of closes would price every mirrored date; the thirteenth is the margin that
 * keeps a date at the cap from falling BEFORE the series starts, where the
 * forward-fill would hand it the series' first close instead of its own.
 */
export const PRICE_HISTORY_MONTHS = 13;

/**
 * How much intraday history a block carries. Five days, matching the webapp's
 * own request: a 24-hour lookback has to clear a closed weekend, or the bar it
 * lands on is the last one of the window and the move reads flat for the wrong
 * reason.
 */
export const PRICE_INTRADAY_DAYS = 5;

// --- Errors -----------------------------------------------------------------

/**
 * `protocol-unsupported` is the app-too-old case and must be actionable rather
 * than a generic 400: the device stops syncing and tells the user to update,
 * instead of retrying a request that can never succeed.
 *
 * `subscription-inactive` (402) is the org's plan, not the device: the
 * subscription is canceled, a payment lapsed, or there never was one. The whole
 * pass is refused, nothing is applied and nothing is pulled, and the device
 * locks itself until a later pass is answered 200. `reason` names which so
 * the lock can say so (`suspended` is Wildcat staff, not billing); it is never a retry hint, since only the office
 * renewing changes the answer.
 */
export type SyncBillingReason = "suspended" | "canceled" | "payment_failed" | "not_subscribed";

export interface SyncError {
  error: string;
  code?:
    | "protocol-unsupported"
    | "no-session"
    | "not-a-member"
    | "subscription-inactive";
  /** Only with `subscription-inactive`. */
  reason?: SyncBillingReason;
}

// --- Payload and row shapes -------------------------------------------------

/**
 * AMENDMENT, 2026-08-31. The first version of this file typed `payload` and
 * `rows` as `Record<string, unknown>` and said nothing about their contents,
 * which meant an endpoint and a device could both be "contract-compliant" and
 * still fail to interoperate. That is the one failure a frozen interface exists
 * to prevent, so the shapes are named here.
 *
 * These mirror the selects the pull engine already uses
 * (`wildcat-phone/src/lib/offline/collections.ts`), because the stored row has to
 * fit the hooks' existing mappers unchanged.
 */

export interface TankReadingRow {
  id: string;
  tank_id: string;
  /** A `date`, `YYYY-MM-DD`. See Gap 8: it is a civil date, not an instant. */
  reading_date: string;
  reading_time: string | null;
  gauge: number | null;
  pulled_bottom: boolean | null;
  water_hauled: number | null;
  hot_oil: boolean | null;
  comments: string | null;
  updated_at: string;
  deleted_at: string | null;
}

export interface MeterReadingRow {
  id: string;
  meter_id: string;
  reading_date: string;
  reading_time: string | null;
  mcf: number | null;
  orifice: number | null;
  differential: number | null;
  separator: number | null;
  heater: number | null;
  injection_pressure: number | null;
  casing_pressure: number | null;
  reset_time: string | null;
  /**
   * The independent cumulative counter (`2026082700100_meter_cumulative_mcf`).
   * `mcf` is the SPOT rate the pumper reports; this is the meter's own index,
   * and the difference between two of them is a MEASURED volume. Both are
   * carried because they are independent inputs, not two views of one number.
   *
   * It was missing from the first version of this shape, which would have let a
   * partial edit that sets `mcf` null the counter and silently change every gas
   * volume derived from it.
   */
  cumulative_mcf: number | null;
  yesterday_mcf: number | null;
  comments: string | null;
  updated_at: string;
  deleted_at: string | null;
}

/** An add carries the whole row, id included: the DEVICE picks the id. */
export type AddPayload<T> = Omit<T, "updated_at" | "deleted_at">;
/** An edit carries the id and only the fields that changed. */
export type EditPayload<T> = { id: string } & Partial<Omit<T, "id" | "updated_at" | "deleted_at">>;
/** A delete carries the id alone. */
export interface DeletePayload {
  id: string;
}

// --- Decisions the first version left open ----------------------------------

/**
 * Everything below was found undefined by the conformance suite, which was
 * written from this file alone and could not tell what to assert. Each is now
 * decided. Where a decision is arguable, the reasoning is given, because the
 * next person will want to know whether it was chosen or defaulted into.
 */

/**
 * The grace on a last-write-wins comparison. The clock offset resolves to about
 * a second, so a comparison inside this window is treated as a tie and the
 * DEVICE wins: the pumper is the one who looked at the tank.
 *
 * Inclusive, and it applies to both the edit path and the add path.
 */
export const LWW_GRACE_MS = 5_000;

/**
 * **Known limitation, deliberately kept.** `madeAt` is compared against the
 * server row's `updated_at`, which is the PREVIOUS writer's commit time, not the
 * previous writer's `madeAt`. For two devices both offline, that resolves to
 * "last to sync wins" rather than "last to make wins" in some orderings.
 *
 * Kept because it is what the shipped executors already do
 * (`wildcat-phone/src/lib/offline/readings.ts`) and because the case it gets
 * wrong needs two people editing the same reading slot while both are offline,
 * which the offline design doc argues is rare enough to accept.
 *
 * Fixing it properly means storing the writer's `madeAt` on the row and
 * comparing `madeAt` to `madeAt`, which is a migration on both readings tables.
 * Do not "fix" it by stamping `madeAt` into `updated_at`: that would silently
 * break any cursor derived from `updated_at`.
 */
export const LWW_COMPARES_AGAINST = "server updated_at" as const;

/** Response size. `limit` counts `rows` plus `deleted` ids, across the response. */
export const DEFAULT_SYNC_LIMIT = 1_000;
export const MAX_SYNC_LIMIT = 5_000;

/**
 * How long an applied op's id is remembered, so a retry cannot re-apply it.
 * Longer than any plausible offline stretch: a handset out of signal for a week
 * must still be safe to drain. A device must not send an op older than this;
 * past it, replay protection is gone and a retry would insert twice.
 */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

/**
 * Where tombstones travel, which differs BY TABLE and is not a free choice:
 *
 * - The readings tables' RLS returns soft-deleted rows, so a delete travels as
 *   an ordinary row in `rows` with `deleted_at` set.
 * - RLS on `tanks`, `meters`, `wells` and `tank_batteries` HIDES them, so their
 *   removals travel as ids in `deleted`.
 * - **Everything on the leases path is HARD deleted** (`run_tickets` and
 *   `meter_volume_statements` are the exceptions, and their RLS does not hide
 *   the tombstone, so they are in the list below). There is no row and no column for a tombstone to ride in at all, so
 *   the server reads their removals out of the `sync_tombstones` side table
 *   (`2026090100300_sync_tombstones.sql`) and sends them as ids in `deleted`.
 *   Adding `deleted_at` to those eighteen tables instead would have been the
 *   obvious fix and a serious bug: every existing webapp query against them is
 *   written without a `deleted_at is null` filter, so a delete would have looked
 *   like it worked on the phone and silently done nothing on the web.
 *
 * A device must handle both SHAPES (a row carrying `deleted_at`, and an id in
 * `deleted`) or it keeps ghost rows. Where the server sourced an id from is its
 * own business. Note that as of 2026-08-31 there are zero soft-deleted readings
 * in production, so the first path has never had live data through it.
 */
export const TOMBSTONES_IN_ROWS: readonly SyncCollection[] = [
  "tank_readings",
  "meter_readings",
  "run_tickets",
  // Both soft-delete under a read policy that does NOT add `deleted_at is
  // null` (2026073000500_notes.sql, 2026072900000_facility_comments.sql), so a
  // removal travels as the row carrying its own tombstone. `note_tags`,
  // `facility_comment_likes` and `well_info_fields` hard-delete and are absent
  // here on purpose: their ids come out of `sync_tombstones`.
  "notes",
  "facility_comments",
  // Soft-deletes (`deleted_at` / `deleted_by`, `2026070602000_meters.sql:73-74`)
  // under the uniform production policy, which does not hide the tombstone. The
  // gas analogue of `run_tickets`, and the one member of the 2026-09-03 batch
  // that does not hard delete.
  "meter_volume_statements",
];

/**
 * The collections that arrive COMPLETE in every response, and must therefore
 * REPLACE what the device holds rather than merge into it.
 *
 * This was missing from the first version and it is a data-correctness bug, not
 * a nicety. `leases`, `inventory_items`, the six rosters, `tasks` and
 * `calendar_events` have no `deleted_at` column at all: a row is HARD deleted,
 * so its removal cannot travel as a tombstone in `deleted` and cannot be
 * inferred from its absence either, unless absence is meaningful. Making the set
 * complete is what makes absence meaningful. A device that merges these keeps
 * deleted leases and departed employees on screen forever, and nothing ever
 * corrects it.
 *
 * The windowed collections are the opposite: they arrive as a delta and MERGE,
 * because sending every reading in the window on every tick is the cost this
 * whole design exists to avoid.
 *
 * So the two rules, which are about different things and must not be conflated:
 * `COMPLETE_SET_COLLECTIONS` decides merge versus replace;
 * {@link TOMBSTONES_IN_ROWS} decides how a delete travels.
 *
 * **They used to be exact complements and are not any more**, which is what this
 * paragraph was left here to say. When the only windowed collections were the
 * two readings tables, "windowed" and "tombstones ride in rows" named the same
 * pair, and it was easy to read either list as the other. Adding the leases path
 * broke that: twelve collections are windowed, and only three carry their
 * tombstones in rows. The other nine are hard deletes whose removals reach the
 * device as ids in `deleted`, sourced from `sync_tombstones`.
 *
 * So read each list for what it says. A collection being windowed tells you
 * nothing about how its deletes travel, and vice versa.
 */
export const COMPLETE_SET_COLLECTIONS: readonly SyncCollection[] = SYNC_COLLECTIONS.filter(
  (c) => !WINDOWED_COLLECTIONS.includes(c)
);

/**
 * Why an op was permanently refused. Enumerated, not free text, because the
 * DEVICE has to decide what happens to its local row and cannot read prose:
 *
 * - `gone` — the row or its parent no longer exists. Drop the local row too.
 * - `invalid` — the payload was malformed or failed validation. Drop the op;
 *   KEEP the local row and let the next pull correct it.
 * - `unauthorized` — the member may not write this. Drop the op, keep the row,
 *   and expect the pull to remove it if they may not read it either.
 *
 * The first version had a free-text `reason`, which left "no longer on the
 * server" and "failed validation" indistinguishable, so a device had to guess.
 * `detail` carries the prose for logs and support.
 */
export type SyncRejectReason = "gone" | "invalid" | "unauthorized";

/**
 * Rules that have no constant to hang off, stated so both sides implement the
 * same thing:
 *
 * 1. **The cursor carries the floor it was issued with.** A backfill asks for
 *    rows committed long ago, which sit BELOW any cursor, so an endpoint that
 *    filters on the cursor alone answers a backfill with nothing, forever. When
 *    a request's `floorDate` is older than the one inside the cursor, windowed
 *    collections are rescanned from the new floor. This is the subtlest trap in
 *    the protocol.
 * 2. **Parents before children, across pages as well as within one.** A reading
 *    must never arrive in an earlier page than its facility.
 * 3. **A cursor the server cannot read is treated as never-synced** (a
 *    downgrade, a restore from backup, a cursor from another environment). Full
 *    resync is the only safe direction; a silent partial sync is not.
 * 4. **A collection the member cannot currently read does not advance the
 *    cursor.** Otherwise revoking and later restoring access leaves a permanent
 *    hole: the rows changed while revoked are below the cursor and never arrive.
 * 5. **`floorDate` is clamped**, never widened past the twelve-month cap, and an
 *    unparseable one is treated as null (the default window).
 * 6. **A delete's `applied` result returns the tombstone** as its row, WHERE
 *    THERE IS ONE. Only the soft-deleting collections have a tombstone to
 *    return (`TOMBSTONES_IN_ROWS`); the other nineteen entities remove the row
 *    outright, so an `applied` hard delete returns `{ id }` and nothing else.
 *
 *    This was underspecified and it is not cosmetic. The rule as first written
 *    said "returns the tombstone", full stop, which a device reasonably reads as
 *    "store the row you get back". An endpoint with no tombstone to hand over
 *    then returns the row as it last STOOD, live-looking and carrying no
 *    `deleted_at`, and a device that stores it has resurrected the row it just
 *    deleted. It self-corrects when the same response also carries the
 *    collection's complete set, and does NOT self-correct on the path that
 *    matters: a response lost in transit, the op resent, answered from the
 *    idempotency ledger, and a pull with nothing new to say. Found by the
 *    conformance suite, which drove exactly that retry.
 *
 * 6a. **A delete competes in last-write-wins like any other write.** A delete
 *    queued before an edit that reached the server first is `skipped` /
 *    `changed-on-server`, not applied.
 *
 *    The offline design doc says "delete: always applied", and justified it by
 *    the delete being undoable on the web. That is true of a soft delete and
 *    false of the nineteen entities that hard-delete: there, an op that lost
 *    the comparison would destroy a later edit with no way back, so losing has
 *    to mean losing. The device takes the server's row instead, which is
 *    recoverable in the direction that matters. Also found by the conformance
 *    suite, as a silent disagreement between two implementations that each
 *    believed they complied.
 * 7. **Editing a row already deleted on the server** returns
 *    `skipped` / `changed-on-server` with the tombstone. The delete stands.
 * 8. **A protocol mismatch in EITHER direction** is refused with
 *    `protocol-unsupported`; a newer client is as unservable as an older one.
 * 9. **Transport:** 200 for any response with per-op results (a rejected op is
 *    not a failed request), 400 `protocol-unsupported`, 401 `no-session`,
 *    402 `subscription-inactive`, 403 `not-a-member`. A session that expires
 *    mid-batch fails the REQUEST, not the individual ops, so nothing is
 *    half-applied on a stale token. A 402 refuses the request whole the same
 *    way: the queued ops stay queued and spend no attempt, and the next 200
 *    (after the office renews) carries them.
 * 10. **An op with no result stays queued and spends no attempt.** "One entry
 *    per op" is a promise the server makes; when it is broken the device must
 *    not guess. Retrying is safe (rule 3) and discarding is not.
 * 11. **`now` is the server's time at the moment it answered.** A device
 *    deriving its clock offset must assume the midpoint of the round trip
 *    (`now - (sentAt + receivedAt) / 2`), or it bakes in half the latency and
 *    every `madeAt` it stamps afterwards is early by that much.
 * 12. **A device with no clock offset must re-stamp its queued ops once it has
 *    one.** `madeAt` is specified on the SERVER's clock, but the handset that
 *    most needs it — never synced, or offline since install, which is exactly
 *    when the outbox is full — has no offset and can only stamp device time.
 *    `LWW_GRACE_MS` is five seconds and does not save a phone that is minutes
 *    out. Re-stamp on the first successful sync, preserving the ORDER the ops
 *    were made in.
 * 13. **`limit` is optional and devices should omit it.** "Rows the client can
 *    accept" is not a quantity a phone knows; the server's default is better
 *    informed. It exists for the conformance suite, which needs to force paging.
 * 14. **Op types are derived from `WRITE_ENTITIES`, never written by hand**, and
 *     an entity belongs in that map only when the endpoint has a spec that can
 *     apply it. The entity half of the string is a wire identifier and is frozen
 *     once shipped: it is stamped into ops queued on handsets and into the
 *     server's idempotency ledger, so renaming one strands queued writes.
 * 15. **`prices` is optional and versioned by its fingerprint.** A device keeps
 *     the last block it was sent and prices from it until a later response
 *     carries another; the server omits the block on a pass whose snapshot has
 *     the fingerprint it last sent this cursor (recorded inside the cursor, so a
 *     cursor from before the block existed is simply sent one). A device that
 *     has never received a block has no price and shows a dash, never a zero,
 *     and never waits on the network for it. The block is carried only to a
 *     member who may read production (`view_well_production`), which is the
 *     gate on every priced route it replaces.
 */
export const SYNC_RULES_VERSION = 1;
