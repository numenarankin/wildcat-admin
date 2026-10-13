import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcAllRows } from "@/lib/supabase/paged-rpc";
import type { TankProduct } from "@/lib/tanks/tanks";
import { bblsFromGauge } from "@/lib/tanks/strapping";
import { tankDisplayName } from "@/lib/tanks/tank-name";
import { isMissingFunction } from "@/lib/supabase/errors";
import { serviceOrgFor } from "@/lib/supabase/service-org";

/**
 * Run-ticket data-access (GBC-5).
 *
 * A run ticket is the source document for product leaving a tank — a sale
 * (`run`), an internal move (`transfer`), or a non-sale removal
 * (`disposition`). Net barrels draw the tank down and feed two seams: the
 * oil-sales figure for stock reconciliation, and the allocation engine's
 * `tank_total` (GBC-2). The pure helpers at the bottom own that math so it is
 * unit-testable without a database.
 *
 * Same idiom as `@/lib/tanks/tanks`: every helper takes the caller's Supabase
 * client first. Passing the request-scoped RLS client (`getSupabaseServer()`) is
 * what enforces org ownership — the `run_tickets` / `purchasers` policies scope
 * reads and writes to `current_org_id()`. Never hand these the service-role
 * admin client (it bypasses RLS).
 */

export type TicketType = "run" | "transfer" | "disposition";

const TICKET_TYPES: readonly TicketType[] = ["run", "transfer", "disposition"];

function asTicketType(v: string | null | undefined): TicketType {
  return TICKET_TYPES.includes(v as TicketType) ? (v as TicketType) : "run";
}

/** A run ticket, with the tank / purchaser names resolved for display. */
export interface RunTicket {
  id: string;
  tankId: string;
  /** Tank name (joined), or "" if unresolved. */
  tankName: string;
  /** Ticket date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** Departure (haul) time as a 24-hour `HH:MM` string, or "" if none. Places
   * the run's two level anchors in time for the tank-level series. */
  departureTime: string;
  ticketNo: string;
  ticketType: TicketType;
  openingGauge: number | null;
  closingGauge: number | null;
  /** Tank level (barrels) BEFORE the haul, derived `opening_gauge × bbl_per_inch`,
   * or null when the ticket carries no opening gauge. Mirrors `TankReading.bbls`. */
  openBbls: number | null;
  /** Tank level (barrels) AFTER the haul, derived `closing_gauge × bbl_per_inch`,
   * or null when the ticket carries no closing gauge. */
  closeBbls: number | null;
  grossBbls: number;
  /** Barrels that actually drew the tank down (net of BS&W) — the CORRECTED
   * barrels printed on the ticket, and what the operator is paid for. */
  netBbls: number;
  /** Observed API gravity in degrees at 60°F, or null when the ticket omits it. */
  apiGravity: number | null;
  /** BS&W as a PERCENT (1.2 = 1.2%), or null when the ticket omits it. */
  bsW: number | null;
  purchaserId: string | null;
  /** Purchaser name (joined), or "" if none. */
  purchaser: string;
  product: TankProduct;
  imageRef: string | null;
  // Settlement economics from the purchaser's run statement (null until settled).
  /** Gross value of the run, USD. */
  grossValue: number | null;
  /** Severance / production taxes on the run, USD. */
  taxes: number | null;
  /** Net value paid on the run, USD. */
  netValue: number | null;
  /** Hauler that moved the oil (the purchaser's transporter); "" if none. */
  transporter: string;
}

/** Fields for creating a run ticket. `purchaser` is a name, resolved to an id. */
export interface RunTicketInput {
  tankId: string;
  date: string;
  /** Departure time as `HH:MM`; blank when unknown. */
  departureTime?: string;
  ticketNo?: string;
  ticketType?: TicketType;
  openingGauge?: number | null;
  closingGauge?: number | null;
  grossBbls: number;
  /** Corrected (net) barrels; when omitted, defaults to `grossBbls`. */
  netBbls?: number | null;
  /** API gravity in degrees. */
  apiGravity?: number | null;
  /** BS&W as a PERCENT (1.2 = 1.2%). */
  bsW?: number | null;
  /** Purchaser name (get-or-created within the org); "" for none. */
  purchaser?: string;
  product?: TankProduct;
  imageRef?: string | null;
  grossValue?: number | null;
  taxes?: number | null;
  netValue?: number | null;
  transporter?: string;
}

/** Partial patch of a ticket's editable fields. */
export interface RunTicketPatch {
  date?: string;
  departureTime?: string;
  ticketNo?: string;
  ticketType?: TicketType;
  openingGauge?: number | null;
  closingGauge?: number | null;
  grossBbls?: number;
  netBbls?: number | null;
  apiGravity?: number | null;
  bsW?: number | null;
  purchaser?: string;
  product?: TankProduct;
  imageRef?: string | null;
  grossValue?: number | null;
  taxes?: number | null;
  netValue?: number | null;
  transporter?: string;
}

/** A minimal purchaser record (GBC-13 owns the full entity and extends it). */
export interface Purchaser {
  id: string;
  name: string;
  product: TankProduct | null;
  active: boolean;
}

type Sb = SupabaseClient;

const TICKET_COLS =
  "id, tank_id, ticket_date, departure_time, ticket_no, ticket_type, " +
  "opening_gauge, closing_gauge, gross_bbls, net_bbls, api_gravity, bs_w, " +
  "purchaser_id, product, image_ref, gross_value, taxes, net_value, " +
  "transporter, purchasers(name), " +
  // The ticket shows the tank's DERIVED name, so it joins the two facts that
  // make it (number + effective lease) instead of the retired name column.
  "tanks(tank_no, product, bbl_per_inch, lease:leases!lease_id(name), " +
  "battery_rel:tank_batteries!battery_id(lease:leases!lease_id(name)))";

interface RunTicketRow {
  id: string;
  tank_id: string;
  ticket_date: string;
  departure_time: string | null;
  ticket_no: string | null;
  ticket_type: string | null;
  opening_gauge: number | null;
  closing_gauge: number | null;
  gross_bbls: number | null;
  net_bbls: number | null;
  api_gravity: number | null;
  bs_w: number | null;
  purchaser_id: string | null;
  product: string | null;
  image_ref: string | null;
  gross_value: number | null;
  taxes: number | null;
  net_value: number | null;
  transporter: string | null;
  tanks: {
    tank_no: string | null;
    /** What the tank holds — the letter in its derived name (T / W). */
    product: string | null;
    bbl_per_inch: number | null;
    lease: { name: string | null } | null;
    battery_rel: { lease: { name: string | null } | null } | null;
  } | null;
  purchasers: { name: string | null } | null;
}

function mapTicket(r: RunTicketRow): RunTicket {
  const gross = r.gross_bbls ?? 0;
  // Levels are derived at READ time from the tank's current strapping factor
  // (gauges are stored in inches), so a factor change reprices every ticket.
  const factor = r.tanks?.bbl_per_inch ?? 1;
  return {
    id: r.id,
    tankId: r.tank_id,
    tankName: tankDisplayName(
      r.tanks?.battery_rel?.lease?.name ?? r.tanks?.lease?.name ?? "",
      r.tanks?.tank_no,
      r.tanks?.product === "water" ? "water" : "oil"
    ),
    date: r.ticket_date,
    departureTime: (r.departure_time ?? "").slice(0, 5),
    ticketNo: r.ticket_no ?? "",
    ticketType: asTicketType(r.ticket_type),
    openingGauge: r.opening_gauge,
    closingGauge: r.closing_gauge,
    openBbls:
      r.opening_gauge != null ? bblsFromGauge(r.opening_gauge, factor) : null,
    closeBbls:
      r.closing_gauge != null ? bblsFromGauge(r.closing_gauge, factor) : null,
    grossBbls: gross,
    netBbls: r.net_bbls ?? gross,
    apiGravity: r.api_gravity,
    bsW: r.bs_w,
    purchaserId: r.purchaser_id,
    purchaser: r.purchasers?.name ?? "",
    product: r.product === "water" ? "water" : "oil",
    imageRef: r.image_ref,
    grossValue: r.gross_value,
    taxes: r.taxes,
    netValue: r.net_value,
    transporter: r.transporter ?? "",
  };
}

// --- Pure helpers (the stock / sales / allocation math) --------------------

/** A ticket's effective net barrels: its net, or its gross when net is unset. */
export function ticketNetBbls(ticket: {
  grossBbls: number;
  // Nullable on purpose: a ticket with only a gross figure falls back to gross.
  netBbls?: number | null;
}): number {
  const net = ticket.netBbls;
  return Number.isFinite(net) && net != null ? net : ticket.grossBbls;
}

/**
 * Corrected (net) barrels SUGGESTED from the gross volume and BS&W: the sediment
 * and water deducted off the gross, `gross × (1 − bsw/100)`. `bsw` is a PERCENT
 * (1.2 = 1.2%), matching the column and the entry form.
 *
 * This is only ever a suggestion the entry form pre-fills — the printed ticket
 * wins, so a hand-typed or AI-extracted net is never overwritten by it, and a
 * real ticket's net usually differs slightly because it also carries a
 * temperature/VCF correction this formula does not model.
 *
 * Returns null when either input is missing or non-finite, or when `bsw` is
 * outside 0–100 (a fraction like 0.012 that was never normalized would otherwise
 * silently produce a near-gross figure).
 */
export function suggestedCorrectedBbls(
  gross: number | null | undefined,
  bsw: number | null | undefined
): number | null {
  if (gross == null || !Number.isFinite(gross)) return null;
  if (bsw == null || !Number.isFinite(bsw)) return null;
  if (bsw < 0 || bsw > 100) return null;
  // Two decimals is the precision a run ticket prints barrels to.
  return Math.round(gross * (1 - bsw / 100) * 100) / 100;
}

/** True when an entered net diverges from the BS&W-implied figure by > 0.5%. */
export function correctedBblsDiverges(
  entered: number | null | undefined,
  suggested: number | null | undefined
): boolean {
  if (entered == null || !Number.isFinite(entered)) return false;
  if (suggested == null || !Number.isFinite(suggested)) return false;
  if (suggested === 0) return entered !== 0;
  return Math.abs(entered - suggested) / Math.abs(suggested) > 0.005;
}

/**
 * The barrels a run hauled off the tank — the single volume the Runs UI shows.
 * It's the level drop derived from the gauges (`openBbls − closeBbls`, the gauge
 * difference × the tank's strapping rate); a gauge-less ticket falls back to the
 * printed `grossBbls`. Runs report ONE barrels figure this way; net (after BS&W)
 * is a settlement concept and lives with the statements, not on the run.
 */
export function hauledBbls(ticket: {
  openBbls?: number | null;
  closeBbls?: number | null;
  grossBbls?: number;
}): number {
  const { openBbls, closeBbls } = ticket;
  if (openBbls != null && closeBbls != null) {
    const drop = openBbls - closeBbls;
    if (Number.isFinite(drop)) return drop;
  }
  return ticket.grossBbls ?? 0;
}

/**
 * Sum net barrels across tickets, optionally restricted to some ticket types.
 * With no filter this is the total product that left the tank.
 */
export function sumTicketBbls(
  tickets: Pick<RunTicket, "ticketType" | "grossBbls" | "netBbls">[],
  types?: TicketType[]
): number {
  return tickets.reduce((sum, t) => {
    if (types && !types.includes(t.ticketType)) return sum;
    return sum + ticketNetBbls(t);
  }, 0);
}

/**
 * Oil sales sourced from run tickets: net barrels of `run` (sale) tickets for
 * oil. This is the ticket-sourced oil-sales figure the reconciliation uses.
 */
export function oilSalesFromTickets(
  tickets: Pick<RunTicket, "ticketType" | "product" | "grossBbls" | "netBbls">[]
): number {
  return tickets.reduce(
    (sum, t) =>
      t.ticketType === "run" && t.product === "oil"
        ? sum + ticketNetBbls(t)
        : sum,
    0
  );
}

/**
 * Draw an opening stock down by every ticket's net barrels (all product
 * physically off the tank — runs, transfers, and dispositions). This is the
 * "a ticket draws down tank stock" rule.
 */
export function applyTicketsToStock(
  openingBbls: number,
  tickets: Pick<RunTicket, "ticketType" | "grossBbls" | "netBbls">[]
): number {
  return openingBbls - sumTicketBbls(tickets);
}

// --- Purchasers ------------------------------------------------------------

/** All purchasers in the org (RLS-scoped), ordered by name. */
export async function listPurchasers(sb: Sb): Promise<Purchaser[]> {
  const { data, error } = await sb
    .from("purchasers")
    .select("id, name, product, active")
    .order("name");
  if (error) throw new Error(`listPurchasers: ${error.message}`);
  return (
    (data ?? []) as {
      id: string;
      name: string | null;
      product: string | null;
      active: boolean | null;
    }[]
  ).map((p) => ({
    id: p.id,
    name: p.name ?? "",
    product: p.product === "oil" || p.product === "water" ? p.product : null,
    active: p.active ?? true,
  }));
}

/**
 * Resolve a purchaser name to an id, creating the (minimal) record on first use.
 * Returns null for a blank name. Org scoping is by RLS; `org_id`/`created_by`
 * come from defaults, never the caller.
 */
export async function getOrCreatePurchaser(
  sb: Sb,
  name: string
): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;

  const { data: existing, error: findErr } = await sb
    .from("purchasers")
    .select("id")
    .eq("name", clean)
    .limit(1)
    .maybeSingle();
  if (findErr) throw new Error(`getOrCreatePurchaser (find): ${findErr.message}`);
  if (existing) return (existing as { id: string }).id;

  const { data, error } = await sb
    .from("purchasers")
    .insert({ name: clean })
    .select("id")
    .single();
  if (error) throw new Error(`getOrCreatePurchaser (create): ${error.message}`);
  return (data as { id: string }).id;
}

// --- Run tickets: reads ----------------------------------------------------

/** A tank's run tickets (excluding soft-deleted), newest first. */
export async function listTankTickets(
  sb: Sb,
  tankId: string
): Promise<RunTicket[]> {
  const { data, error } = await sb
    .from("run_tickets")
    .select(TICKET_COLS)
    .eq("tank_id", tankId)
    .is("deleted_at", null)
    .order("ticket_date", { ascending: false });
  if (error) throw new Error(`listTankTickets: ${error.message}`);
  return ((data ?? []) as unknown as RunTicketRow[]).map(mapTicket);
}

/**
 * Tickets for a SET of tanks, keyed by tank id — the bulk form of
 * {@link listTankTickets}, so well-test derivation can build many tanks' level
 * series (hauls included as excluded-segment anchors) in one round trip.
 */
export async function listTicketsByTank(
  sb: Sb,
  tankIds: string[],
  /** ISO day. Tickets from each tank's anchor gauge before it forward, so a
   *  haul between that gauge and the window still explains the level change
   *  it caused. Unset: whole history. */
  from?: string
): Promise<Map<string, RunTicket[]>> {
  const out = new Map<string, RunTicket[]>();
  const ids = [...new Set(tankIds.filter(Boolean))];
  if (ids.length === 0) return out;

  // Through the RPC (2026081800500), which resolves the org and the capability
  // ONCE. Read as a plain PostgREST query the row-security predicate ran per
  // row, across every ticket on every tank — 8 calls and 1,912ms of a 4,045ms
  // dashboard render. Same fix, and same shape, as the readings twins.
  //
  // Paged, unlike the query it replaces: PostgREST caps a response at 1,000 rows
  // and applies that cap to a function's rows too, so the unpaged read this
  // replaces would have silently truncated once an org passed 1,000 tickets.
  // Pages go out together (`rpcAllRows`), not one after another.
  // `p_org` is passed ONLY by the service role (2026090900300), which has no
  // `current_org_id()` and was getting every gauge and no hauls — each haul
  // then read as negative production in every cron-built series. A signed-in
  // caller resolves its own org inside the function and names no `p_org`, so
  // its call still matches the windowed overload exactly.
  const org = serviceOrgFor(sb);
  const scoped = org ? { p_org: org } : {};
  let { rows, error } = await rpcAllRows<FlatTicketRow>(
    sb,
    "run_tickets_for_tanks",
    from ? { ids, p_from: from, ...scoped } : { ids, ...scoped },
    { chunkKey: "ids" }
  );
  if (error && from && isMissingFunction(error)) {
    // Windowed overload not pushed yet (2026090900200), or not yet taking
    // `p_org`: whole history instead.
    ({ rows, error } = await rpcAllRows<FlatTicketRow>(
      sb,
      "run_tickets_for_tanks",
      { ids, ...scoped },
      { chunkKey: "ids" }
    ));
  }
  if (error) {
    if (isMissingFunction(error)) {
      // The function is missing until that migration is pushed. The old query
      // is slow, not wrong, so fall back to it rather than to a blank page.
      return listTicketsByTankFallback(sb, ids);
    }
    throw new Error(`listTicketsByTank: ${error.message}`);
  }
  for (const row of rows) {
    const t = mapTicket(nestTicketRow(row));
    const list = out.get(t.tankId);
    if (list) list.push(t);
    else out.set(t.tankId, [t]);
  }
  return out;
}

/**
 * One row of {@link listTicketsByTank}'s RPC. A function returns a table, so the
 * three joins the PostgREST embed used to nest (`purchasers(name)` and the
 * two-hop lease walk behind a tank's display name) come back flat.
 */
interface FlatTicketRow {
  id: string;
  tank_id: string;
  ticket_date: string;
  departure_time: string | null;
  ticket_no: string | null;
  ticket_type: string | null;
  opening_gauge: number | null;
  closing_gauge: number | null;
  gross_bbls: number | null;
  net_bbls: number | null;
  api_gravity: number | null;
  bs_w: number | null;
  purchaser_id: string | null;
  product: string | null;
  image_ref: string | null;
  gross_value: number | null;
  taxes: number | null;
  net_value: number | null;
  transporter: string | null;
  purchaser_name: string | null;
  tank_no: string | null;
  /** The TANK's product (2026082600400), not `product` above, which is the
   *  ticket's. It is the letter in the tank's derived name. */
  tank_product: string | null;
  bbl_per_inch: number | null;
  tank_lease_name: string | null;
  battery_lease_name: string | null;
}

/** Rebuild the embedded shape {@link mapTicket} reads, so one mapper serves both
 *  the RPC and the fallback query and they cannot drift apart. */
function nestTicketRow(r: FlatTicketRow): RunTicketRow {
  return {
    ...r,
    tanks: {
      tank_no: r.tank_no,
      /* Null until 2026082600400 is applied — the fallback below is the whole
         answer to a missing FUNCTION, but an older function that returns
         without this column would name every tank with a T. Oil is the right
         guess there: it is what every tank was named before the letter split. */
      product: r.tank_product ?? null,
      bbl_per_inch: r.bbl_per_inch,
      lease: { name: r.tank_lease_name },
      // `mapTicket` prefers the battery's lease and falls back to the tank's, so
      // this stays null (not an object holding a null name) when the tank hangs
      // off no battery — otherwise the fallback would never be reached.
      battery_rel: r.battery_lease_name
        ? { lease: { name: r.battery_lease_name } }
        : null,
    },
    purchasers: { name: r.purchaser_name },
  };
}

/** {@link listTicketsByTank} before 2026081800500 — the read that pays the
 *  row-security predicate per row, kept for the window before the migration is
 *  pushed. */
async function listTicketsByTankFallback(
  sb: Sb,
  ids: string[]
): Promise<Map<string, RunTicket[]>> {
  const out = new Map<string, RunTicket[]>();
  const { data, error } = await sb
    .from("run_tickets")
    .select(TICKET_COLS)
    .in("tank_id", ids)
    .is("deleted_at", null)
    .order("ticket_date", { ascending: false });
  if (error) throw new Error(`listTicketsByTank: ${error.message}`);

  for (const row of (data ?? []) as unknown as RunTicketRow[]) {
    const t = mapTicket(row);
    const list = out.get(t.tankId);
    if (list) list.push(t);
    else out.set(t.tankId, [t]);
  }
  return out;
}

/** Every run ticket in the org (excluding soft-deleted), newest first. */
export async function listAllRunTickets(sb: Sb): Promise<RunTicket[]> {
  const { data, error } = await sb
    .from("run_tickets")
    .select(TICKET_COLS)
    .is("deleted_at", null)
    .order("ticket_date", { ascending: false });
  if (error) throw new Error(`listAllRunTickets: ${error.message}`);
  return ((data ?? []) as unknown as RunTicketRow[]).map(mapTicket);
}

/**
 * Net barrels off a tank over `[from, to]` (inclusive dates), broken out by
 * ticket type. This is the allocation engine's `tank_total` ticket seam
 * (GBC-2): `tank_total = Δ stock + these`. Omitting the range totals all
 * tickets on the tank.
 */
export async function tankTicketTotals(
  sb: Sb,
  tankId: string,
  from?: string,
  to?: string
): Promise<{
  run: number;
  transfer: number;
  disposition: number;
  total: number;
}> {
  let q = sb
    .from("run_tickets")
    .select("ticket_type, gross_bbls, net_bbls")
    .eq("tank_id", tankId)
    .is("deleted_at", null);
  if (from) q = q.gte("ticket_date", from);
  if (to) q = q.lte("ticket_date", to);
  const { data, error } = await q;
  if (error) throw new Error(`tankTicketTotals: ${error.message}`);

  const rows = (data ?? []) as {
    ticket_type: string | null;
    gross_bbls: number | null;
    net_bbls: number | null;
  }[];
  const tickets = rows.map((r) => ({
    ticketType: asTicketType(r.ticket_type),
    grossBbls: r.gross_bbls ?? 0,
    netBbls: r.net_bbls ?? r.gross_bbls ?? 0,
  }));
  return {
    run: sumTicketBbls(tickets, ["run"]),
    transfer: sumTicketBbls(tickets, ["transfer"]),
    disposition: sumTicketBbls(tickets, ["disposition"]),
    total: sumTicketBbls(tickets),
  };
}

// --- Run tickets: writes ---------------------------------------------------

function writePayload(
  input: RunTicketInput | RunTicketPatch,
  purchaserId: string | null | undefined
): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if ("tankId" in input && input.tankId !== undefined) p.tank_id = input.tankId;
  if (input.date !== undefined) p.ticket_date = input.date;
  if (input.departureTime !== undefined)
    p.departure_time = input.departureTime || null;
  if (input.ticketNo !== undefined) p.ticket_no = input.ticketNo || null;
  if (input.ticketType !== undefined) p.ticket_type = input.ticketType;
  // Only the raw gauges (inches) are stored; the barrel levels are derived at
  // read time from the tank's current strapping factor.
  if (input.openingGauge !== undefined) p.opening_gauge = input.openingGauge;
  if (input.closingGauge !== undefined) p.closing_gauge = input.closingGauge;
  if (input.grossBbls !== undefined) p.gross_bbls = input.grossBbls;
  if (input.grossBbls !== undefined || input.netBbls !== undefined) {
    // Net defaults to gross when the ticket carries only a gross figure.
    const net = input.netBbls;
    p.net_bbls =
      net != null && Number.isFinite(net) ? net : (input.grossBbls ?? null);
  }
  if (input.apiGravity !== undefined) p.api_gravity = input.apiGravity;
  if (input.bsW !== undefined) p.bs_w = input.bsW;
  if (input.product !== undefined) p.product = input.product;
  if (input.imageRef !== undefined) p.image_ref = input.imageRef;
  if (input.grossValue !== undefined) p.gross_value = input.grossValue;
  if (input.taxes !== undefined) p.taxes = input.taxes;
  if (input.netValue !== undefined) p.net_value = input.netValue;
  if (input.transporter !== undefined) p.transporter = input.transporter || null;
  if (purchaserId !== undefined) p.purchaser_id = purchaserId;
  return p;
}

/**
 * Create a run ticket; resolves the purchaser name to a (minimal) purchaser
 * record. Returns the new id. `org_id`/`created_by` are RLS defaults.
 */
export async function createRunTicket(
  sb: Sb,
  input: RunTicketInput
): Promise<{ id: string }> {
  const purchaserId = input.purchaser
    ? await getOrCreatePurchaser(sb, input.purchaser)
    : null;
  const payload = {
    tank_id: input.tankId,
    ticket_date: input.date,
    departure_time: input.departureTime || null,
    ticket_no: input.ticketNo || null,
    ticket_type: input.ticketType ?? "run",
    opening_gauge: input.openingGauge ?? null,
    closing_gauge: input.closingGauge ?? null,
    gross_bbls: input.grossBbls,
    net_bbls:
      input.netBbls != null && Number.isFinite(input.netBbls)
        ? input.netBbls
        : input.grossBbls,
    api_gravity: input.apiGravity ?? null,
    bs_w: input.bsW ?? null,
    purchaser_id: purchaserId,
    product: input.product ?? "oil",
    image_ref: input.imageRef ?? null,
    gross_value: input.grossValue ?? null,
    taxes: input.taxes ?? null,
    net_value: input.netValue ?? null,
    transporter: input.transporter || null,
  };
  const { data, error } = await sb
    .from("run_tickets")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw new Error(`createRunTicket: ${error.message}`);
  return { id: (data as { id: string }).id };
}

/**
 * Bulk-insert many run tickets in one round trip per chunk — the fast path for an
 * approval landing hundreds/thousands of tickets (looping `createRunTicket` made
 * that as many sequential inserts, each with its own purchaser lookup). Each
 * distinct purchaser name is get-or-created ONCE. Returns the count created.
 */
export async function createRunTickets(
  sb: Sb,
  inputs: RunTicketInput[]
): Promise<{ created: number }> {
  if (inputs.length === 0) return { created: 0 };
  const purchaserCache = new Map<string, string | null>();
  const resolvePurchaser = async (name?: string): Promise<string | null> => {
    if (!name) return null;
    if (purchaserCache.has(name)) return purchaserCache.get(name) ?? null;
    const id = await getOrCreatePurchaser(sb, name);
    purchaserCache.set(name, id);
    return id;
  };

  const payloads: Record<string, unknown>[] = [];
  for (const input of inputs) {
    const purchaserId = await resolvePurchaser(input.purchaser);
    payloads.push({
      tank_id: input.tankId,
      ticket_date: input.date,
      departure_time: input.departureTime || null,
      ticket_no: input.ticketNo || null,
      ticket_type: input.ticketType ?? "run",
      opening_gauge: input.openingGauge ?? null,
      closing_gauge: input.closingGauge ?? null,
      gross_bbls: input.grossBbls,
      net_bbls:
        input.netBbls != null && Number.isFinite(input.netBbls)
          ? input.netBbls
          : input.grossBbls,
      api_gravity: input.apiGravity ?? null,
      bs_w: input.bsW ?? null,
      purchaser_id: purchaserId,
      product: input.product ?? "oil",
      image_ref: input.imageRef ?? null,
      gross_value: input.grossValue ?? null,
      taxes: input.taxes ?? null,
      net_value: input.netValue ?? null,
      transporter: input.transporter || null,
    });
  }

  const CHUNK = 500;
  let created = 0;
  for (let i = 0; i < payloads.length; i += CHUNK) {
    const { data, error } = await sb
      .from("run_tickets")
      .insert(payloads.slice(i, i + CHUNK))
      .select("id");
    if (error) throw new Error(`createRunTickets: ${error.message}`);
    created += data?.length ?? 0;
  }
  return { created };
}

/**
 * Update a ticket, scoped to its tank. `updatedBy` stamps the audit trail (the
 * DB trigger stamps `updated_at`). A `purchaser` name is re-resolved to an id.
 */
export async function updateRunTicket(
  sb: Sb,
  tankId: string,
  id: string,
  patch: RunTicketPatch & { updatedBy?: string | null }
): Promise<void> {
  const purchaserId =
    patch.purchaser !== undefined
      ? await getOrCreatePurchaser(sb, patch.purchaser)
      : undefined;
  const update = writePayload(patch, purchaserId);
  if (patch.updatedBy !== undefined) update.updated_by = patch.updatedBy;
  if (Object.keys(update).length === 0) return;

  const { error } = await sb
    .from("run_tickets")
    .update(update)
    .eq("id", id)
    .eq("tank_id", tankId);
  if (error) throw new Error(`updateRunTicket: ${error.message}`);
}

/**
 * Soft-delete a ticket (stamps `deleted_at/by`), scoped to its tank. Tickets are
 * never hard-deleted so the sales/stock audit stays whole.
 */
export async function softDeleteRunTicket(
  sb: Sb,
  tankId: string,
  id: string,
  deletedBy: string | null = null
): Promise<void> {
  const { error } = await sb
    .from("run_tickets")
    .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
    .eq("id", id)
    .eq("tank_id", tankId);
  if (error) throw new Error(`softDeleteRunTicket: ${error.message}`);
}
