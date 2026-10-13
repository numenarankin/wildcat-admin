/**
 * Which of Orion's tools an organization allows, and the pure predicate that
 * decides it. See `docs/plans/orion-tool-permissions.md`.
 *
 * The unit of control is an (area, action) CELL, not a tool: ~20 areas by four
 * actions is a table a person can read, 160+ switches is not. Every tool in the
 * registry maps to exactly one cell here, and a tool that maps to nothing is
 * DENIED, which is what forces a new tool to be classified rather than shipping
 * silently ungated (`tools.registry.test.ts` fails first).
 *
 * This module is pure so the predicate can be tested without a database and
 * imported from client components for the settings table. The loader that reads
 * an org's actual settings lives in `tool-permissions-server.ts`, and the
 * enforcement point is `resilient()` in `tools.ts`.
 */

/**
 * Stamped on every `execute` that `resilient()` has wrapped, so a test can prove
 * no executable tool in the registry escaped the gate.
 */
export const PERMISSION_GATED: unique symbol = Symbol("orion.permissionGated");

export type AiToolAction = "read" | "add" | "edit" | "delete";

export const AI_TOOL_ACTIONS: readonly AiToolAction[] = [
  "read",
  "add",
  "edit",
  "delete",
];

export interface AiToolArea {
  id: string;
  label: string;
  /**
   * Not togglable, and left out of the settings table.
   *
   * Two kinds. Some reach nothing of the company's at all: the public state
   * record, the shared petrophysics library, the open web, the user's own
   * remembered preferences. The rest are how Orion reads and computes over the
   * records the other areas already govern: the ontology's entities, links and
   * measures, and the arithmetic run on them. Switching those off would not
   * withhold anything the per-area switches do not already withhold; it would
   * only make the same data arrive worse.
   */
  alwaysOn?: true;
}

/** Table order, domains first and the cross-cutting areas after them. */
export const AI_TOOL_AREAS: readonly AiToolArea[] = [
  { id: "wells", label: "Wells" },
  { id: "production", label: "Oil & tanks" },
  { id: "batteries", label: "Batteries" },
  { id: "gas", label: "Gas meters" },
  { id: "water", label: "Water & disposal" },
  { id: "facilities", label: "Facilities" },
  { id: "leases", label: "Leases & owners" },
  { id: "people", label: "People & vendors" },
  { id: "inventory", label: "Inventory" },
  { id: "accounting", label: "Accounting & prices" },
  { id: "tasks", label: "Tasks & calendar" },
  { id: "files", label: "Files & documents" },
  { id: "ontology", label: "Data layer", alwaysOn: true },
  { id: "analysis", label: "Analysis", alwaysOn: true },
  { id: "memory", label: "Memory", alwaysOn: true },
  { id: "history", label: "Chat history" },
  { id: "messages", label: "Team messages" },
  { id: "geology", label: "Geology library", alwaysOn: true },
  { id: "docs", label: "Help docs", alwaysOn: true },
  { id: "rrc", label: "Public records (RRC)", alwaysOn: true },
  { id: "web", label: "Web search", alwaysOn: true },
  { id: "support", label: "Support" },
];

export type AiToolAreaId = (typeof AI_TOOL_AREAS)[number]["id"];

export interface ToolCell {
  area: AiToolAreaId;
  action: AiToolAction;
}

/**
 * Tools that carry no company data of their own: they draw a chart the model
 * already has the numbers for, or move the Scout map. Turning them off would
 * change how an answer is PRESENTED rather than what Orion may reach, so they
 * are not togglable and stay on even when the permission read fails.
 */
export const ALWAYS_ON: ReadonlySet<string> = new Set([
  "render_chart",
  "scout_set_view",
]);

/**
 * Every tool in the registry, by cell. Grouped in table order.
 *
 * `record_*` and `add_*` are ADD even when they touch an existing parent (a
 * reading is a new row on a tank that already exists); `save_*`, `set_*`,
 * `assign_*`, `publish_*` and `update_*` are EDIT because they replace a value
 * or a link that is already there. There are no DELETE tools by design
 * (`tools.ts`), so nothing maps to that action yet.
 */
export const TOOL_CELLS: Readonly<Record<string, ToolCell>> = {
  // Help docs. The product's own documentation, not the company's records:
  // always on, and absent from the settings table, because a workspace that
  // switched help off would only get worse answers to the same questions.
  search_docs: { area: "docs", action: "read" },
  read_doc: { area: "docs", action: "read" },

  // Wells
  list_wells: { area: "wells", action: "read" },
  get_well: { area: "wells", action: "read" },
  get_well_tests: { area: "wells", action: "read" },
  get_well_equipment: { area: "wells", action: "read" },
  get_well_service: { area: "wells", action: "read" },
  get_well_comments: { area: "wells", action: "read" },
  create_well: { area: "wells", action: "add" },
  create_injection_well: { area: "wells", action: "add" },
  add_well_equipment: { area: "wells", action: "add" },
  add_well_service: { area: "wells", action: "add" },
  add_well_comment: { area: "wells", action: "add" },
  record_well_test: { area: "wells", action: "add" },
  record_downtime: { area: "wells", action: "add" },
  update_well: { area: "wells", action: "edit" },
  update_well_equipment: { area: "wells", action: "edit" },
  set_well_type: { area: "wells", action: "edit" },

  // Oil & tanks
  get_production: { area: "production", action: "read" },
  list_tanks: { area: "production", action: "read" },
  get_tank: { area: "production", action: "read" },
  get_tank_allocation: { area: "production", action: "read" },
  list_run_tickets: { area: "production", action: "read" },
  create_tank: { area: "production", action: "add" },
  record_production: { area: "production", action: "add" },
  record_tank_reading: { area: "production", action: "add" },
  record_run_ticket: { area: "production", action: "add" },
  add_tank_wells: { area: "production", action: "add" },
  add_tank_comment: { area: "production", action: "add" },
  update_tank: { area: "production", action: "edit" },
  update_tank_reading: { area: "production", action: "edit" },
  update_production: { area: "production", action: "edit" },
  update_run_ticket: { area: "production", action: "edit" },
  set_tank_called_in: { area: "production", action: "edit" },
  save_tank_allocation: { area: "production", action: "edit" },
  set_tank_well_allocation: { area: "production", action: "edit" },
  assign_tank_to_lease: { area: "production", action: "edit" },

  // Batteries
  list_batteries: { area: "batteries", action: "read" },
  get_battery: { area: "batteries", action: "read" },
  create_battery: { area: "batteries", action: "add" },
  add_battery_wells: { area: "batteries", action: "add" },
  update_battery: { area: "batteries", action: "edit" },
  save_battery_tanks: { area: "batteries", action: "edit" },
  save_battery_allocation: { area: "batteries", action: "edit" },
  set_battery_well_allocation: { area: "batteries", action: "edit" },

  // Gas meters
  list_meters: { area: "gas", action: "read" },
  get_meter: { area: "gas", action: "read" },
  create_meter: { area: "gas", action: "add" },
  record_meter_reading: { area: "gas", action: "add" },
  create_gas_campaign: { area: "gas", action: "add" },
  add_meter_wells: { area: "gas", action: "add" },
  add_meter_comment: { area: "gas", action: "add" },
  update_meter: { area: "gas", action: "edit" },
  update_meter_reading: { area: "gas", action: "edit" },
  save_meter_allocation: { area: "gas", action: "edit" },
  set_meter_well_allocation: { area: "gas", action: "edit" },
  publish_gas_campaign: { area: "gas", action: "edit" },
  assign_meter_to_lease: { area: "gas", action: "edit" },

  // Water & disposal
  list_water_meters: { area: "water", action: "read" },
  get_swd_meter: { area: "water", action: "read" },
  get_injection: { area: "water", action: "read" },
  create_water_meter: { area: "water", action: "add" },
  record_swd_meter_reading: { area: "water", action: "add" },
  record_disposal_readings: { area: "water", action: "add" },
  update_water_meter: { area: "water", action: "edit" },
  update_swd_meter_reading: { area: "water", action: "edit" },
  update_disposal_reading: { area: "water", action: "edit" },
  save_node_water_split: { area: "water", action: "edit" },

  // Facilities
  get_facilities: { area: "facilities", action: "read" },
  list_facility_connections: { area: "facilities", action: "read" },
  trace_facility_flow: { area: "facilities", action: "read" },
  get_facility_readouts: { area: "facilities", action: "read" },
  create_facility_connection: { area: "facilities", action: "add" },
  update_facility_connection: { area: "facilities", action: "edit" },

  // Leases & owners
  list_leases: { area: "leases", action: "read" },
  get_lease: { area: "leases", action: "read" },
  get_royalty_owners: { area: "leases", action: "read" },
  create_lease: { area: "leases", action: "add" },
  create_royalty_owner: { area: "leases", action: "add" },
  grant_lease_interest: { area: "leases", action: "add" },
  update_lease: { area: "leases", action: "edit" },
  update_lease_interest: { area: "leases", action: "edit" },
  update_royalty_owner: { area: "leases", action: "edit" },
  set_operator_interest: { area: "leases", action: "edit" },
  assign_well_to_lease: { area: "leases", action: "edit" },

  // People & vendors
  list_people: { area: "people", action: "read" },
  create_employee: { area: "people", action: "add" },
  create_contractor: { area: "people", action: "add" },
  create_service_provider: { area: "people", action: "add" },
  create_gatherer: { area: "people", action: "add" },
  update_employee: { area: "people", action: "edit" },
  update_contractor: { area: "people", action: "edit" },
  update_service_provider: { area: "people", action: "edit" },
  update_gatherer: { area: "people", action: "edit" },

  // Inventory
  get_inventory: { area: "inventory", action: "read" },
  create_inventory_item: { area: "inventory", action: "add" },
  update_inventory_item: { area: "inventory", action: "edit" },

  // Accounting & prices
  list_invoices: { area: "accounting", action: "read" },
  get_invoice: { area: "accounting", action: "read" },
  list_statements: { area: "accounting", action: "read" },
  extract_statement: { area: "accounting", action: "read" },
  list_revenue: { area: "accounting", action: "read" },
  get_commodity_prices: { area: "accounting", action: "read" },
  get_price_history: { area: "accounting", action: "read" },
  get_posted_prices: { area: "accounting", action: "read" },
  create_transaction: { area: "accounting", action: "add" },
  update_transaction: { area: "accounting", action: "edit" },

  // Tasks & calendar
  list_tasks: { area: "tasks", action: "read" },
  list_calendar_events: { area: "tasks", action: "read" },
  create_task: { area: "tasks", action: "add" },
  create_calendar_event: { area: "tasks", action: "add" },
  update_task: { area: "tasks", action: "edit" },
  update_calendar_event: { area: "tasks", action: "edit" },

  // Files & documents
  browse_files: { area: "files", action: "read" },
  read_file: { area: "files", action: "read" },
  read_pdf: { area: "files", action: "read" },
  read_note: { area: "files", action: "read" },
  read_las_full: { area: "files", action: "read" },
  read_seismic_brief: { area: "files", action: "read" },
  search_documents: { area: "files", action: "read" },
  describe_dataset: { area: "files", action: "read" },
  get_curve_data: { area: "files", action: "read" },
  get_curves_data: { area: "files", action: "read" },
  create_folder: { area: "files", action: "add" },
  create_project: { area: "files", action: "add" },
  create_document: { area: "files", action: "add" },
  create_note: { area: "files", action: "add" },
  edit_document: { area: "files", action: "edit" },

  // Data layer (the ontology tools: entities, links, measures)
  resolve: { area: "ontology", action: "read" },
  select_entities: { area: "ontology", action: "read" },
  get_object: { area: "ontology", action: "read" },
  get_links: { area: "ontology", action: "read" },
  get_measure: { area: "ontology", action: "read" },
  get_coverage: { area: "ontology", action: "read" },
  allocation_basis: { area: "ontology", action: "read" },
  context_search: { area: "ontology", action: "read" },
  field_notes: { area: "ontology", action: "read" },

  // Analysis
  get_decline: { area: "analysis", action: "read" },
  company_analyze: { area: "analysis", action: "read" },

  // Memory
  recall_memory: { area: "memory", action: "read" },
  remember: { area: "memory", action: "add" },

  // Chat history
  search_chat_history: { area: "history", action: "read" },
  read_conversation: { area: "history", action: "read" },

  // Team messages
  search_messages: { area: "messages", action: "read" },
  read_message_thread: { area: "messages", action: "read" },
  send_team_message: { area: "messages", action: "add" },
  rename_team_conversation: { area: "messages", action: "edit" },

  // Geology library
  geology_kb_index: { area: "geology", action: "read" },
  geology_kb_read: { area: "geology", action: "read" },
  geology_kb_segments: { area: "geology", action: "read" },
  geology_play_extent: { area: "geology", action: "read" },

  // Public records (RRC)
  rrc_search: { area: "rrc", action: "read" },
  rrc_well: { area: "rrc", action: "read" },
  rrc_lease: { area: "rrc", action: "read" },
  rrc_operator: { area: "rrc", action: "read" },
  rrc_operator_network: { area: "rrc", action: "read" },
  rrc_field: { area: "rrc", action: "read" },
  rrc_county: { area: "rrc", action: "read" },
  rrc_survey: { area: "rrc", action: "read" },
  rrc_completion: { area: "rrc", action: "read" },
  rrc_permits: { area: "rrc", action: "read" },
  rrc_disposal: { area: "rrc", action: "read" },
  rrc_disposition: { area: "rrc", action: "read" },
  rrc_market: { area: "rrc", action: "read" },
  rrc_leaderboard: { area: "rrc", action: "read" },
  rrc_wells_near: { area: "rrc", action: "read" },
  rrc_lease_minerals: { area: "rrc", action: "read" },
  rrc_mineral_owner: { area: "rrc", action: "read" },
  rrc_owners_near: { area: "rrc", action: "read" },
  rrc_data_vintage: { area: "rrc", action: "read" },
  rrc_analyze: { area: "rrc", action: "read" },
  get_well_rrc_record: { area: "rrc", action: "read" },
  get_lease_rrc_record: { area: "rrc", action: "read" },

  // Web search
  web_search: { area: "web", action: "read" },

  // Support
  list_support_threads: { area: "support", action: "read" },
  send_support_message: { area: "support", action: "add" },
  mark_support_thread_read: { area: "support", action: "edit" },
};

/**
 * Cells that are OFF until an admin turns them on, rather than the other way
 * round.
 *
 * The default for everything else is on, because it is what Orion could already
 * do. These are the ones where the tool speaks to somebody: a message posted to
 * a coworker or a ticket opened with Wildcat support goes out under the user's
 * name and cannot be taken back, so an org opts into that rather than
 * discovering it. An explicit `enabled: true` row overrides this.
 */
export const DEFAULT_OFF: ReadonlySet<string> = new Set([
  "messages:add",
  "messages:edit",
  "support:read",
  "support:add",
  "support:edit",
]);

/** The areas nobody can switch off, by id. */
export const ALWAYS_ON_AREAS: ReadonlySet<string> = new Set(
  AI_TOOL_AREAS.filter((a) => a.alwaysOn).map((a) => a.id),
);

/** The areas the settings table renders, in table order. */
export const TOGGLEABLE_AREAS: readonly AiToolArea[] = AI_TOOL_AREAS.filter(
  (a) => !a.alwaysOn,
);

/** `area:action`, the key a stored row and a table cell share. */
export function cellKey(area: string, action: AiToolAction): string {
  return `${area}:${action}`;
}

/**
 * An org's answer to "may Orion use this tool".
 *
 * `all` is the unrestricted set (the catalog probe, and local dev with no
 * Supabase, matching how `getCurrentPermissions` grants everything there).
 * `none` is the fail-closed set used when the org or the settings row cannot be
 * read at all. `cells` carries only the cells an admin has turned OFF, so an org
 * that never opens the table stores nothing and behaves as it always has.
 */
export type ToolPermissions =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "cells"; disabled: ReadonlySet<string> };

export const ALL_TOOLS_ALLOWED: ToolPermissions = { kind: "all" };
export const NO_TOOLS_ALLOWED: ToolPermissions = { kind: "none" };

/** Build a permission set from the rows stored for one org. */
export function permissionsFromRows(
  rows: { area: string; action: string; enabled: boolean }[],
): ToolPermissions {
  const disabled = new Set<string>(DEFAULT_OFF);
  for (const row of rows) {
    const key = cellKey(row.area, row.action as AiToolAction);
    if (row.enabled) disabled.delete(key);
    else disabled.add(key);
  }
  return { kind: "cells", disabled };
}

/**
 * The one predicate. An unclassified tool is denied under every set except the
 * explicit `all`, so forgetting to classify a new tool fails loudly in tests and
 * safely in production.
 */
export function isToolAllowed(name: string, perms: ToolPermissions): boolean {
  if (perms.kind === "all") return true;
  if (ALWAYS_ON.has(name)) return true;
  const cell = TOOL_CELLS[name];
  if (!cell) return false;
  if (ALWAYS_ON_AREAS.has(cell.area)) return true;
  if (perms.kind === "none") return false;
  return !perms.disabled.has(cellKey(cell.area, cell.action));
}

/** The disabled areas, for the line the prompt shows Orion. */
export function disabledCells(perms: ToolPermissions): string[] {
  if (perms.kind !== "cells") return [];
  return [...perms.disabled].sort();
}

/**
 * Which (area, action) pairs actually have tools. The settings table renders a
 * pair with none as a dash rather than an off switch, so "turned off" and "no
 * such tool" do not look alike. Today that is the whole delete column.
 */
export function populatedCells(): ReadonlySet<string> {
  const cells = new Set<string>();
  for (const cell of Object.values(TOOL_CELLS)) {
    if (ALWAYS_ON_AREAS.has(cell.area)) continue;
    cells.add(cellKey(cell.area, cell.action));
  }
  return cells;
}
