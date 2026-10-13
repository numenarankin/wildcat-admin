/**
 * Plain-English activity labels for the "Thinking…" indicator, keyed by tool
 * name — what Orion says it is DOING while a tool runs.
 *
 * Why this exists: the indicator used to render the raw identifier
 * (`get_tank_allocation()`, in monospace with parens). Our users are pumpers and
 * owners, not engineers, and a stack of snake_case function calls reads like
 * something has gone wrong. `ACTION_TITLES` in `approval-view.ts` already solved
 * this for the 78 write tools, but only on the approval card, and only in the
 * imperative ("Create a task") — a card asks permission, this line narrates work
 * in progress. Hence a separate map in the present participle.
 *
 * Framework-free on purpose so `__tests__/tool-activity-audit.test.ts` can assert
 * over the live tool catalog that EVERY tool has a label, the same way the
 * approval audit does. A tool without one is a UI regression, not a warning.
 */

/** Present-participle activity label, keyed by tool name. */
export const TOOL_ACTIVITY: Record<string, string> = {
  // --- The ontology layer (reads) ---
  // Deliberately plain: a pumper should not have to learn what a "handle" or an
  // "entity" is to read the thinking line.
  resolve: "Finding what you mean",
  get_object: "Pulling everything on record",
  get_links: "Tracing what connects to what",
  get_measure: "Working out production",
  select_entities: "Gathering the set to look at",
  get_coverage: "Checking how complete the data is",
  allocation_basis: "Checking how the split is set up",
  field_notes: "Reading what the crew wrote",
  context_search: "Searching notes and documents",
  company_analyze: "Running the numbers",
  // Registered before this layer landed and never labelled, so the audit was
  // already failing on it.
  rrc_analyze: "Running the numbers on public records",

  // --- Wells & production (reads) ---
  list_wells: "Looking up your wells",
  get_well: "Looking up a well",
  get_production: "Pulling production numbers",
  get_decline: "Fitting the decline curve",
  get_well_tests: "Pulling well tests",
  get_well_equipment: "Checking a well's equipment",
  get_well_service: "Checking a well's service history",
  get_well_comments: "Reading notes on a well",
  get_injection: "Pulling injection volumes",

  // --- Tanks, batteries, meters (reads) ---
  list_tanks: "Looking up tanks",
  get_tank: "Looking up a tank",
  get_tank_allocation: "Checking how a tank splits between wells",
  list_batteries: "Looking up batteries",
  get_battery: "Looking up a battery",
  list_meters: "Looking up gas meters",
  get_meter: "Looking up a gas meter",
  list_water_meters: "Looking up water meters",
  get_swd_meter: "Looking up a disposal meter",
  get_facilities: "Mapping your facilities",
  list_facility_connections: "Reading facility connections",
  trace_facility_flow: "Tracing the flow",
  get_facility_readouts: "Reading facility levels",
  list_run_tickets: "Looking up run tickets",

  // --- Money (reads) ---
  list_invoices: "Looking up vendor invoices",
  get_invoice: "Reading an invoice",
  list_statements: "Looking up settlement statements",
  extract_statement: "Reading a settlement statement",
  list_revenue: "Looking up revenue",
  get_commodity_prices: "Checking oil and gas prices",
  get_price_history: "Checking price history",
  get_posted_prices: "Checking posted prices",
  get_inventory: "Checking inventory",

  // --- Leases & people (reads) ---
  list_leases: "Looking up leases",
  get_lease: "Looking up a lease",
  get_royalty_owners: "Looking up royalty owners",
  list_people: "Looking up contacts",

  // --- Files & documents (reads) ---
  browse_files: "Browsing your files",
  search_documents: "Searching your documents",
  read_file: "Reading a document",
  read_pdf: "Reading a PDF",
  describe_dataset: "Checking what's in a data file",
  read_las_full: "Reading the well log",
  read_seismic_brief: "Reading the seismic brief",
  get_curves_data: "Pulling log curves",
  get_curve_data: "Pulling a log curve",

  // --- Railroad Commission public records (reads) ---
  // "RRC records" rather than "the mirror": an operator knows the Commission
  // keeps these, and does not need to know which database we read them from.
  rrc_search: "Searching RRC records",
  rrc_data_vintage: "Checking how current the RRC's data is",
  rrc_well: "Looking up a well in RRC records",
  rrc_lease: "Looking up a lease in RRC records",
  rrc_operator: "Looking up an operator",
  rrc_operator_network: "Checking who's behind an operator",
  rrc_disposition: "Checking where the oil and gas went",
  rrc_field: "Looking up a field",
  rrc_county: "Checking activity in a county",
  rrc_wells_near: "Finding nearby wells",
  rrc_lease_minerals: "Reading the county mineral roll for a lease",
  rrc_mineral_owner: "Looking up a mineral owner",
  rrc_owners_near: "Finding mineral owners nearby",
  rrc_disposal: "Finding disposal capacity nearby",
  rrc_survey: "Looking up a land survey",
  rrc_market: "Checking production trends in the State of Texas",
  rrc_leaderboard: "Ranking operators and areas in the State of Texas",
  rrc_permits: "Checking drilling permits",
  rrc_completion: "Reading a completion report",
  // These two start from OUR well or lease rather than from a state key, so
  // they narrate as our record being checked against the Commission's.
  get_well_rrc_record: "Checking our well against RRC records",
  get_lease_rrc_record: "Checking our lease against RRC records",

  // --- The petrophysics reference library (reads) ---
  // "The reference library" rather than "the corpus" or "the knowledge base":
  // what the user cares about is that the answer came out of a book rather than
  // out of the model's head, and three separate navigation steps would read as
  // stalling, so all three narrate as looking something up in it.
  search_docs: "Checking the help docs",
  read_doc: "Reading the help docs",

  geology_kb_index: "Checking the reference library",
  geology_kb_segments: "Finding the right passage",
  geology_kb_read: "Reading the reference library",
  geology_play_extent: "Mapping where the formation is described",

  // --- Everything else (reads) ---
  render_chart: "Drawing a chart",
  scout_set_view: "Moving the map",
  list_tasks: "Looking up tasks",
  list_calendar_events: "Checking the calendar",
  web_search: "Searching the web",
  // First person on purpose: these two are the only tools that act on what the
  // user has told Orion, so the line reads as Orion speaking, not the app.
  recall_memory: "Recalling what you've told me",
  remember: "Making a note to remember",
  search_chat_history: "Searching past conversations",
  read_conversation: "Re-reading an earlier conversation",
  search_messages: "Searching your messages",
  read_message_thread: "Reading a conversation",
  send_team_message: "Sending a message",
  rename_team_conversation: "Renaming a conversation",

  // --- Wells (writes) ---
  create_well: "Adding a well",
  update_well: "Updating a well",
  set_well_type: "Changing a well's type",
  add_well_comment: "Posting a field note",
  add_well_equipment: "Adding equipment to a well",
  update_well_equipment: "Updating well equipment",
  add_well_service: "Logging service on a well",
  create_injection_well: "Adding a disposal well",

  // --- Production (writes) ---
  record_production: "Recording production",
  update_production: "Correcting production",
  record_run_ticket: "Recording a run ticket",
  update_run_ticket: "Correcting a run ticket",
  record_downtime: "Recording downtime",
  record_well_test: "Recording a well test",

  // --- Tanks (writes) ---
  create_tank: "Adding a tank",
  update_tank: "Updating a tank",
  record_tank_reading: "Recording a tank gauge",
  update_tank_reading: "Correcting a tank gauge",
  add_tank_comment: "Posting a note on a tank",
  add_tank_wells: "Connecting wells to a tank",
  set_tank_well_allocation: "Setting a tank's well split",
  save_tank_allocation: "Saving the tank's well split",
  assign_tank_to_lease: "Assigning a tank to a lease",
  set_tank_called_in: "Marking a tank called in",

  // --- Batteries & facilities (writes) ---
  create_battery: "Adding a battery",
  update_battery: "Updating a battery",
  save_battery_tanks: "Setting a battery's tanks",
  add_battery_wells: "Connecting wells to a battery",
  set_battery_well_allocation: "Setting a battery's well split",
  save_battery_allocation: "Saving the battery's well split",
  create_facility_connection: "Connecting two facilities",
  update_facility_connection: "Changing a facility connection",
  save_node_water_split: "Setting a water split",

  // --- Gas meters (writes) ---
  create_meter: "Adding a gas meter",
  update_meter: "Updating a gas meter",
  record_meter_reading: "Recording a meter reading",
  update_meter_reading: "Correcting a meter reading",
  add_meter_wells: "Connecting wells to a meter",
  set_meter_well_allocation: "Setting a meter's well split",
  save_meter_allocation: "Saving the meter's well split",
  add_meter_comment: "Posting a note on a meter",
  assign_meter_to_lease: "Assigning a meter to a lease",
  create_gas_campaign: "Starting a well-test campaign",
  publish_gas_campaign: "Publishing the well-test campaign",

  // --- Water & disposal (writes) ---
  create_water_meter: "Adding a water meter",
  update_water_meter: "Updating a water meter",
  record_swd_meter_reading: "Recording a disposal meter reading",
  update_swd_meter_reading: "Correcting a disposal meter reading",
  record_disposal_readings: "Recording disposal volumes",
  update_disposal_reading: "Correcting a disposal volume",

  // --- Leases & ownership (writes) ---
  create_lease: "Adding a lease",
  update_lease: "Updating a lease",
  assign_well_to_lease: "Assigning a well to a lease",
  grant_lease_interest: "Granting an ownership interest",
  update_lease_interest: "Updating an ownership interest",
  set_operator_interest: "Setting your working interest",

  // --- People (writes) ---
  create_contractor: "Adding a contractor",
  update_contractor: "Updating a contractor",
  create_service_provider: "Adding a service provider",
  update_service_provider: "Updating a service provider",
  create_royalty_owner: "Adding a royalty owner",
  update_royalty_owner: "Updating a royalty owner",
  create_employee: "Adding an employee",
  update_employee: "Updating an employee",
  create_gatherer: "Adding a gatherer",
  update_gatherer: "Updating a gatherer",

  // --- Inventory & books (writes) ---
  create_inventory_item: "Adding an inventory item",
  update_inventory_item: "Updating an inventory item",
  create_transaction: "Recording a transaction",
  update_transaction: "Correcting a transaction",

  // --- Tasks, calendar, files (writes) ---
  create_task: "Creating a task",
  update_task: "Updating a task",
  create_calendar_event: "Adding a calendar event",
  update_calendar_event: "Updating a calendar event",
  create_project: "Creating a project",
  create_folder: "Creating a folder",
  create_document: "Writing a document",
  edit_document: "Updating a document",
  send_support_message: "Sending a message to support",
  list_support_threads: "Checking your support conversations",
  mark_support_thread_read: "Marking a support thread read",
};

/**
 * Verb for the fallback, so an unmapped tool still reads as an activity rather
 * than as code. The conformance test means this should never ship, but "Looking
 * up something" beats `get_foo()` on the day someone adds a tool in a hurry.
 */
const FALLBACK_VERBS: Record<string, string> = {
  add: "Adding",
  assign: "Assigning",
  browse: "Browsing",
  create: "Adding",
  describe: "Checking",
  edit: "Updating",
  extract: "Reading",
  get: "Looking up",
  grant: "Granting",
  list: "Looking up",
  publish: "Publishing",
  read: "Reading",
  recall: "Recalling",
  record: "Recording",
  render: "Drawing",
  save: "Saving",
  search: "Searching",
  send: "Sending",
  set: "Setting",
  update: "Updating",
};

/** `get_tank_allocation` -> "Looking up tank allocation". */
export function humanizeToolActivity(name: string): string {
  const [verb, ...rest] = name.split("_");
  const label = FALLBACK_VERBS[verb];
  if (!label) return `Working on ${name.replace(/_/g, " ")}`;
  if (rest.length === 0) return label;
  return `${label} ${rest.join(" ")}`;
}

/** The line to show while this tool runs. Never a raw tool name. */
export function toolActivity(name: string): string {
  return TOOL_ACTIVITY[name] ?? humanizeToolActivity(name);
}

/** Whether the tool has an explicit label (what the conformance test asserts). */
export function hasToolActivity(name: string): boolean {
  return (
    typeof TOOL_ACTIVITY[name] === "string" && TOOL_ACTIVITY[name].length > 0
  );
}
