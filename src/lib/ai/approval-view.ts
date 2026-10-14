/**
 * Pure, framework-free rendering of a proposed Orion write into a plain-English
 * view a non-technical operator can read — a title, the record's fields as
 * labelled rows, and any batch of rows as a small table. NEVER raw JSON, never
 * tool names or field keys.
 *
 * Extracted from the `ApprovalCard` component so (a) the copy/logic can be unit-
 * tested without React and (b) a Layer-0 conformance test can assert that EVERY
 * write tool has a registered human-readable title (the "70-year-old operator"
 * bar) — `hasRegisteredApprovalTitle`.
 */

/** Plain-English action title for a single-record write, keyed by tool name. */
export const ACTION_TITLES: Record<string, string> = {
  add_well_comment: "Post a field note",
  create_task: "Create a task",
  update_task: "Update a task",
  create_well: "Register a new well",
  update_well: "Update well details",
  create_lease: "Create a lease",
  update_lease: "Update lease details",
  assign_well_to_lease: "Assign a well to a lease",
  assign_tank_to_lease: "Assign a tank to a lease",
  assign_meter_to_lease: "Assign a meter to a lease",
  grant_lease_interest: "Grant an owner interest on a lease",
  update_lease_interest: "Update an interest holding",
  set_operator_interest: "Set the operator's interest on a lease",
  create_meter: "Create a gas meter",
  update_meter: "Update gas meter details",
  record_meter_reading: "Record a gas meter reading",
  update_meter_reading: "Correct a gas meter reading",
  add_meter_wells: "Add wells to a gas meter",
  set_meter_well_allocation: "Set a well's meter allocation %",
  save_meter_allocation: "Save a gas meter's allocation",
  create_gas_campaign: "Create a gas well-test campaign",
  publish_gas_campaign: "Publish a gas well-test campaign",
  add_meter_comment: "Post a note on a gas meter",
  create_injection_well: "Create an injection (SWD) well",
  set_well_type: "Change a well's type",
  update_disposal_reading: "Correct a disposal reading",
  create_water_meter: "Create a water (SWD) meter",
  update_water_meter: "Update water meter details",
  record_swd_meter_reading: "Record a water meter reading",
  update_swd_meter_reading: "Correct a water meter reading",
  create_tank: "Create a tank",
  update_tank: "Update tank details",
  record_tank_reading: "Record a tank gauge reading",
  update_tank_reading: "Correct a tank gauge reading",
  add_tank_comment: "Post a note on a tank",
  add_tank_wells: "Add wells to a tank",
  set_tank_well_allocation: "Set a well's tank allocation %",
  save_tank_allocation: "Save a tank's allocation",
  update_run_ticket: "Correct a run ticket",
  create_battery: "Create a tank battery",
  update_battery: "Update tank battery details",
  save_battery_tanks: "Set a battery's tanks",
  add_battery_wells: "Add wells to a battery",
  set_battery_well_allocation: "Set a well's battery allocation %",
  save_battery_allocation: "Save a battery's allocation",
  create_facility_connection: "Draw a flow connection",
  update_facility_connection: "Change a flow connection",
  save_node_water_split: "Set a node's water split",
  update_production: "Correct a production reading",
  update_well_equipment: "Fix an equipment row",
  create_calendar_event: "Add a calendar event",
  update_calendar_event: "Update a calendar event",
  create_contractor: "Add a contractor",
  update_contractor: "Update a contractor",
  create_service_provider: "Add a service provider",
  update_service_provider: "Update a service provider",
  create_royalty_owner: "Add a royalty owner",
  update_royalty_owner: "Update a royalty owner",
  create_employee: "Add an employee",
  update_employee: "Update an employee",
  create_gatherer: "Add a gatherer",
  update_gatherer: "Update a gatherer",
  create_project: "Create a project",
  set_tank_called_in: "Call in a tank for pickup",
  send_support_message: "Send a message to support",
  mark_support_thread_read: "Mark a support thread read",
  send_team_message: "Send a message to a coworker",
  rename_team_conversation: "Rename a group conversation",
  create_folder: "Create a folder",
  create_inventory_item: "Add an inventory item",
  update_inventory_item: "Update an inventory item",
  create_transaction: "Record a ledger entry",
  update_transaction: "Update a ledger entry",
  create_document: "Create a document",
  edit_document: "Edit a document",
  enrich_target: "Research a target (website, decision-makers, contacts)",
  add_to_sequence: "Add a target to the sequence (calls to the P-5 phone)",
};

/** Batch writes: the array field, plus the verb + singular noun for the title. */
export const BATCH_ACTIONS: Record<
  string,
  { key: string; verb: string; noun: string; plural?: string }
> = {
  record_production: {
    key: "readings",
    verb: "Record",
    noun: "production reading",
  },
  add_well_equipment: { key: "fields", verb: "Add", noun: "equipment item" },
  add_well_service: { key: "rows", verb: "Log", noun: "service record" },
  record_run_ticket: { key: "tickets", verb: "Log", noun: "run ticket" },
  record_downtime: { key: "events", verb: "Log", noun: "downtime period" },
  record_well_test: { key: "tests", verb: "Record", noun: "well test" },
  record_disposal_readings: {
    key: "readings",
    verb: "Record",
    noun: "disposal reading",
  },
  add_targets: { key: "operators", verb: "Add", noun: "target" },
  queue_for_enrichment: {
    key: "operators",
    verb: "Queue",
    noun: "target for enrichment",
    plural: "targets for enrichment",
  },
  add_to_sequence: {
    key: "contacts",
    verb: "Add to the sequence",
    noun: "contact",
  },
};

/**
 * Does this tool have a hand-written, plain-English approval title? Every write
 * tool MUST — a Layer-0 test enforces it, so a new write tool can't ship with an
 * approval card a field operator can't read. (Field labels fall back to
 * auto-humanization, which is fine; the title is the curated part.)
 */
export function hasRegisteredApprovalTitle(name: string): boolean {
  return name in ACTION_TITLES || name in BATCH_ACTIONS;
}

/** Friendlier labels than a raw key name; anything unlisted is auto-humanized. */
const LABELS: Record<string, string> = {
  body: "Note",
  name: "Name",
  title: "Title",
  method: "Method",
  ticketNo: "Ticket #",
  ticketType: "Type",
  grossBbls: "Gross (bbl)",
  netBbls: "Corrected (bbl)",
  apiGravity: "API gravity",
  bsW: "BS&W (%)",
  transporter: "Transport company",
  oilProduction: "Oil (bbl)",
  gasProduction: "Gas (MCF)",
  saltWater: "Water (bbl)",
  oilStock: "Oil stock (bbl)",
  oilSales: "Oil sales (bbl)",
  volumeMcf: "Gas (MCF)",
  eventType: "Type",
  startDate: "From",
  endDate: "To",
  daysApplied: "Days offline",
  testDate: "Test date",
  durationDays: "Duration (days)",
  startAt: "Start",
  endAt: "End",
  oilBbls: "Oil (bbl)",
  gasMcf: "Gas (MCF)",
  waterBbls: "Water (bbl)",
  preTestShutInDays: "Prior shut-in (days)",
  dateDrilled: "Drilled",
  categoryCode: "Category code",
  invoiceNumber: "Invoice #",
  counterparty: "Counterparty",
  allDay: "All day",
  unitCost: "Unit cost",
  wellIds: "Wells",
  content: "Content",
  operatorNo: "Operator #",
};

/** Money-valued keys get a $ and thousands separators. */
const MONEY_KEYS = new Set([
  "amount",
  "cost",
  "unitCost",
  "price",
  "grossValue",
  "netValue",
  "deducts",
  "taxes",
  "fees",
  "value",
  "lastPayment",
]);

/**
 * Ids the conversation already establishes — noise (esp. UUIDs) in the card. Any
 * key that IS "id" or ends in "Id" (wellId, leaseId, batteryId, readingId,
 * campaignId, ownerId, …) is hidden generically, so a new tool can never surface a
 * raw uuid to the operator just because its param wasn't added to a list.
 */
function isHiddenKey(key: string): boolean {
  return key === "id" || /Id$/.test(key);
}

function isEmpty(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

export function humanizeKey(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Render one value as readable text (— for empty). */
function formatValue(key: string, v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    if (v.every((x) => typeof x !== "object" || x == null)) {
      return v.join(", ");
    }
    return `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  if (typeof v === "number") {
    return MONEY_KEYS.has(key) ? formatMoney(v) : v.toLocaleString();
  }
  if (typeof v === "string") {
    return v.length > 240 ? `${v.slice(0, 240)}…` : v;
  }
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

export interface FieldRow {
  label: string;
  value: string;
}

export interface ApprovalView {
  title: string;
  fields: FieldRow[];
  table?: { columns: string[]; rows: string[][]; total: number };
}

const MAX_TABLE_ROWS = 8;
const MAX_TABLE_COLS = 6;

/** Scalar (non-array) fields of an object as labelled rows, ids + blanks dropped. */
function scalarFields(
  obj: Record<string, unknown>,
  skip: Set<string>,
): FieldRow[] {
  return Object.entries(obj)
    .filter(([k, v]) => !skip.has(k) && !isHiddenKey(k) && !isEmpty(v))
    .map(([k, v]) => ({ label: humanizeKey(k), value: formatValue(k, v) }));
}

/** Build a compact table from a batch of record objects. */
function buildTable(items: Record<string, unknown>[]): {
  columns: string[];
  rows: string[][];
  total: number;
} {
  const keys: string[] = [];
  for (const it of items) {
    for (const k of Object.keys(it)) {
      if (!isHiddenKey(k) && !keys.includes(k)) keys.push(k);
    }
  }
  // Keep only keys that carry a value in at least one row, capped for width.
  const dataKeys = keys
    .filter((k) => items.some((it) => !isEmpty(it[k])))
    .slice(0, MAX_TABLE_COLS);
  const rows = items
    .slice(0, MAX_TABLE_ROWS)
    .map((it) => dataKeys.map((k) => formatValue(k, it[k])));
  // Header row is humanized for display ("Date", "Gas (MCF)"), keyed on raw keys.
  const columns = dataKeys.map((k) => humanizeKey(k));
  return { columns, rows, total: items.length };
}

/** Turn a raw tool call into a plain-English, non-technical view. */
export function describeApproval(name: string, input: unknown): ApprovalView {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  const batch = BATCH_ACTIONS[name];
  const batchVal = batch ? obj[batch.key] : undefined;
  if (batch && Array.isArray(batchVal) && batchVal.length > 0) {
    const items = batchVal as Record<string, unknown>[];
    const n = items.length;
    return {
      title: `${batch.verb} ${n} ${n === 1 ? batch.noun : (batch.plural ?? `${batch.noun}s`)}`,
      fields: scalarFields(obj, new Set([batch.key])),
      table: buildTable(items),
    };
  }

  return {
    title: ACTION_TITLES[name] ?? humanizeToolName(name),
    fields: scalarFields(obj, new Set()),
  };
}
