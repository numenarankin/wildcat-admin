/**
 * Proactive ingest: the record types Orion can propose from an uploaded
 * document, and the metadata each carries. Pure module (no server imports) so it
 * is safe to import from the client modal as well as server code.
 *
 * See docs/plans/data-entry-write-coverage.md and
 * docs/plans/data-entry-destination-catalog.md (the source for the belongs/
 * notHere copy below, which the extract prompt renders as its destination
 * catalog).
 */

/** A structured record type an uploaded document might contain. */
export type IngestType =
  // Directory / people
  | "contractors"
  | "serviceProviders"
  | "gatherers"
  | "purchasers"
  | "royaltyOwners"
  | "employees"
  // Leases & interest
  | "leases"
  | "leaseInterest"
  | "leaseUseGas"
  // Wells (entities)
  | "wells"
  | "injectionWells"
  // Well data
  | "production"
  | "wellEquipment"
  | "service"
  | "downtime"
  | "wellTests"
  | "shots"
  | "wellNotes"
  | "gasTests"
  // Tanks
  | "tanks"
  | "tankReadings"
  | "runTickets"
  | "batteries"
  // Meters & gas
  | "meters"
  | "meterReadings"
  | "meterVolumes"
  // Disposal
  | "disposalReadings"
  // Accounting
  | "transactions"
  // Inventory
  | "inventory"
  // Dedicated document types (whole-document, handled by one extractor + writer)
  | "oilRunStatement"
  | "gasSettlementStatement"
  | "vendorInvoice";

export const INGEST_TYPES: readonly IngestType[] = [
  "contractors",
  "serviceProviders",
  "gatherers",
  "purchasers",
  "royaltyOwners",
  "employees",
  "leases",
  "leaseInterest",
  "leaseUseGas",
  "wells",
  "injectionWells",
  "production",
  "wellEquipment",
  "service",
  "downtime",
  "wellTests",
  "shots",
  "wellNotes",
  "gasTests",
  "tanks",
  "tankReadings",
  "runTickets",
  "batteries",
  "meters",
  "meterReadings",
  "meterVolumes",
  "disposalReadings",
  "transactions",
  "inventory",
  "oilRunStatement",
  "gasSettlementStatement",
  "vendorInvoice",
];

export interface IngestTypeMeta {
  type: IngestType;
  /** Nouns for modal copy ("Add these 10 production readings"). */
  singular: string;
  plural: string;
  /**
   * Capability that gates writing this type, re-checked when the user approves.
   * People/vendors share `manage_people` (see the People permission
   * decision in the plan).
   */
  capability: string;
  /**
   * The write-skill whose on/off toggle governs whether this type is proposed.
   * Several types can share one skill (people-records covers several).
   */
  skillId: string;
  /** well-scoped types need a well (verbatim match, else a picker). */
  needsWell: boolean;
  /** One line: what data belongs in this destination. Rendered into the prompt. */
  belongs: string;
  /** One line: what does NOT belong here (names the confusable sibling). */
  notHere: string;
}

export const INGEST_TYPE_META: Record<IngestType, IngestTypeMeta> = {
  contractors: {
    type: "contractors",
    singular: "contractor",
    plural: "contractors",
    capability: "manage_people",
    skillId: "people-records",
    needsWell: false,
    belongs:
      "Individual field crew the operator hires (pumpers, roustabouts, welders, electricians, lease hands).",
    notHere:
      "Not a vendor company (serviceProviders), a gas gatherer (gatherers), a mineral owner (royaltyOwners), or payroll staff (employees).",
  },
  serviceProviders: {
    type: "serviceProviders",
    singular: "service provider",
    plural: "service providers",
    capability: "manage_people",
    skillId: "people-records",
    needsWell: false,
    belongs:
      "Vendor COMPANIES that provide a service (well servicing, trucking, chemical, wireline, workover).",
    notHere:
      "Not an individual crew member (contractors) or a gas gatherer/purchaser (gatherers).",
  },
  gatherers: {
    type: "gatherers",
    singular: "gatherer",
    plural: "gatherers",
    capability: "manage_people",
    skillId: "people-records",
    needsWell: false,
    belongs:
      "The midstream company that gathers/buys the operator's gas or hauls its product; assigned to tanks and meters.",
    notHere:
      "Not a field-service vendor (serviceProviders) or the gas-volume settlement itself (meterVolumes).",
  },
  purchasers: {
    type: "purchasers",
    singular: "purchaser",
    plural: "purchasers",
    capability: "manage_statements",
    skillId: "oil-run-statements",
    needsWell: false,
    belongs:
      "A crude-oil PURCHASER (buyer) that pays the operator for its oil — the company named on a run/settlement statement, with its contact (phone, email, contact name). Filed to the purchasers directory used by statements and run tickets.",
    notHere:
      "Not the hauler/transporter (that is recorded on the run, never a contact) and not a gas gatherer (gatherers) — those are separate.",
  },
  royaltyOwners: {
    type: "royaltyOwners",
    singular: "royalty owner",
    plural: "royalty owners",
    capability: "manage_people",
    skillId: "people-records",
    needsWell: false,
    belongs: "The IDENTITY of a mineral/royalty owner (name, contact info).",
    notHere:
      "Not that owner's share of a lease (percentages, interest type) — that is leaseInterest.",
  },
  employees: {
    type: "employees",
    singular: "employee",
    plural: "employees",
    capability: "manage_people",
    skillId: "people-records",
    needsWell: false,
    belongs: "The operator's own payroll staff (pumper, foreman, office).",
    notHere:
      "Not a 1099 field contractor hired per job (contractors) or a vendor company (serviceProviders).",
  },
  leases: {
    type: "leases",
    singular: "lease",
    plural: "leases",
    capability: "manage_leases",
    skillId: "record-updates",
    needsWell: false,
    belongs: "A lease record itself: its number, name, and county.",
    notHere:
      "Not who owns interest in the lease (leaseInterest) or the monthly lease-use gas (leaseUseGas).",
  },
  leaseInterest: {
    type: "leaseInterest",
    singular: "interest holding",
    plural: "interest holdings",
    capability: "manage_leases",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "A party's ownership share in a lease: working and net revenue interest and its type, for the operator or a royalty owner.",
    notHere:
      "Not the owner's identity/contact (royaltyOwners) or the lease itself (leases).",
  },
  leaseUseGas: {
    type: "leaseUseGas",
    singular: "lease-use gas figure",
    plural: "lease-use gas figures",
    capability: "manage_gas_production",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "The monthly volume of gas consumed on a lease (lease-use / fuel gas), per well.",
    notHere:
      "Not metered sales gas (meterReadings / meterVolumes) or produced gas (production).",
  },
  wells: {
    type: "wells",
    singular: "well",
    plural: "wells",
    capability: "add_wells",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "Creating a producing well as an entity, so readings, equipment, service, and interest can attach to it.",
    notHere:
      "Not a disposal/injection well (injectionWells) or any per-day data about the well (production, downtime, wellTests).",
  },
  injectionWells: {
    type: "injectionWells",
    singular: "injection well",
    plural: "injection wells",
    capability: "add_injection_wells",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "Creating a salt-water-disposal / injection well (a well with no oil tank), so disposalReadings can attach.",
    notHere:
      "Not a producing well (wells) or the injection volumes themselves (disposalReadings).",
  },
  production: {
    type: "production",
    singular: "production reading",
    plural: "production readings",
    capability: "manage_oil_production",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "Daily volumes measured AT A WELL, from a production-history document or manual entry. One row per reading date.",
    notHere:
      "Not tank gauge inches (tankReadings), daily meter MCF (meterReadings), hauled oil/water (runTickets), or injection volumes (disposalReadings). NEVER derive production from a financial settlement (a purchaser statement or meterVolumes) — a settlement is not a production source.",
  },
  wellEquipment: {
    type: "wellEquipment",
    singular: "equipment row",
    plural: "equipment rows",
    capability: "manage_well_equipment",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "The well's current PHYSICAL configuration as label/value pairs (pump, rods, tubing, casing, perfs, surface unit).",
    notHere: "Not dated jobs done to the well (service) or header facts.",
  },
  service: {
    type: "service",
    singular: "service record",
    plural: "service records",
    capability: "manage_well_service",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "Dated job/service events performed ON a well (repairs, workovers, acid/chemical jobs, tests, cleanouts).",
    notHere:
      "Not the well's physical spec (wellEquipment), downtime periods (downtime), or production volumes.",
  },
  downtime: {
    type: "downtime",
    singular: "downtime event",
    plural: "downtime events",
    capability: "manage_oil_production",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "Periods a well was offline (downtime or deliberate shut-in). One row per period.",
    notHere: "Not a repair job (service) or a rate check (wellTests).",
  },
  wellTests: {
    type: "wellTests",
    singular: "well test",
    plural: "well tests",
    capability: "manage_allocation",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "Periodic rate checks on a well; volumes are totals over the test window.",
    notHere: "Not daily production (production) or downtime (downtime).",
  },
  shots: {
    type: "shots",
    singular: "fluid-level shot",
    plural: "fluid-level shots",
    // A diagnostic shot log lives in the well-config domain, matching the
    // well_shots RLS write policy.
    capability: "manage_well_equipment",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "A dated acoustic / sonolog / Echometer FLUID-LEVEL SHOT down the annulus: how many FEET below surface the fluid column stands, and the pump setting depth it is judged against.",
    notHere:
      "Not a rate check measuring volumes (wellTests), not a job done to the well (service), and not the well's standing pump spec (wellEquipment) — a shot is a measurement, not a component.",
  },
  wellNotes: {
    type: "wellNotes",
    singular: "note",
    plural: "notes",
    capability: "manage_notes",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "Free PROSE the operator wants kept against the well: a pumper's memo, a field observation, a letter, an instruction — written text that no structured destination holds.",
    notHere:
      "Not a summary of records already extracted elsewhere, and never a substitute for a structured row: a dated job is service, an outage is downtime, a spec is wellEquipment. Only prose that fits nowhere else belongs here.",
  },
  gasTests: {
    type: "gasTests",
    singular: "gas test",
    plural: "gas tests",
    capability: "manage_gas_production",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "This well's SHUT-IN READING on a gas meter's open test campaign: the meter's rate (MCF/day) over a window during which this one well alone was shut in, so its share of the meter's commingled gas can be inferred from the drop.",
    notHere:
      "Not the meter's all-wells-online BASELINE (that is recorded on the meter page and cannot be filed from here), not a pumper's daily meter volume (meterReadings), not a gatherer settlement (gasSettlementStatement), and not an oil/water rate check (wellTests).",
  },
  tanks: {
    type: "tanks",
    singular: "tank",
    plural: "tanks",
    capability: "manage_oil_production",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "Creating a tank as an entity, so gauge readings and run tickets can reference it by number/name.",
    notHere:
      "Not readings on the tank (tankReadings), oil/water hauled off it (runTickets), or the battery grouping (batteries).",
  },
  tankReadings: {
    type: "tankReadings",
    singular: "tank gauge reading",
    plural: "tank gauge readings",
    capability: "manage_oil_production",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "A single gauge level measured on one tank at a point in time — ONE level per row (inches; barrels derived at write time).",
    notHere:
      "Not a run ticket (a run row carries TWO levels: an opening before a haul and a closing after); not well-level volumes (production).",
  },
  runTickets: {
    type: "runTickets",
    singular: "run ticket",
    plural: "run tickets",
    capability: "manage_oil_production",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "Oil (or water) physically removed from a TANK on a ticket — ONE row carrying an opening level (before the haul) and a closing level (after); openingGauge is higher than closingGauge.",
    notHere:
      "Not a single-level gauge reading (tankReadings), a gatherer's gas settlement (meterVolumes), or the ledger entry for the sale (transactions).",
  },
  batteries: {
    type: "batteries",
    singular: "tank battery",
    plural: "tank batteries",
    capability: "manage_oil_production",
    skillId: "record-updates",
    needsWell: false,
    belongs: "Creating a tank battery: the named grouping that tanks belong to.",
    notHere: "Not the tanks themselves (tanks).",
  },
  meters: {
    type: "meters",
    singular: "meter",
    plural: "meters",
    capability: "manage_gas_production",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "Creating a gas meter as an entity, so daily readings and gatherer statements can reference it by number/name.",
    notHere:
      "Not the pumper's daily reading (meterReadings) or the gatherer settlement (meterVolumes).",
  },
  meterReadings: {
    type: "meterReadings",
    singular: "meter reading",
    plural: "meter readings",
    capability: "manage_gas_production",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "The pumper's daily gas volume (MCF) off a specific meter — the source-of-truth reading.",
    notHere:
      "Not the gatherer's settlement statement (meterVolumes), lease-use gas (leaseUseGas), or well-level gas (production).",
  },
  meterVolumes: {
    type: "meterVolumes",
    singular: "gas volume statement",
    plural: "gas volume statements",
    capability: "manage_gas_production",
    skillId: "record-updates",
    needsWell: false,
    belongs:
      "A gatherer's gas SETTLEMENT for a meter: a financial/documentation record of settled sales volume and value.",
    notHere:
      "Not the pumper's daily reading (meterReadings), a purchaser revenue statement, or a ledger entry (transactions). NEVER a production source — do not turn its volume into production or a reading.",
  },
  disposalReadings: {
    type: "disposalReadings",
    singular: "disposal reading",
    plural: "disposal readings",
    capability: "manage_disposal",
    skillId: "record-updates",
    needsWell: true,
    belongs:
      "Volumes INJECTED into a disposal/SWD well, plus its pressures. One row per reading.",
    notHere:
      "Not water PRODUCED at a producing well (the saltWater field on production) or water hauled off a tank (runTickets).",
  },
  transactions: {
    type: "transactions",
    singular: "transaction",
    plural: "transactions",
    capability: "manage_statements",
    skillId: "bookkeeping",
    needsWell: false,
    belongs:
      "Single entries in the accounting ledger (a check, an expense paid, an oil-sale deposit received).",
    notHere:
      "Not a multi-line purchaser statement or a gatherer gas settlement (meterVolumes).",
  },
  inventory: {
    type: "inventory",
    singular: "inventory item",
    plural: "inventory items",
    capability: "manage_inventory",
    skillId: "inventory-management",
    needsWell: false,
    belongs:
      "Materials and parts on hand (tubulars, chemicals, fittings, equipment stock).",
    notHere:
      "Not a well's installed equipment (wellEquipment) or a purchase transaction for the item (transactions).",
  },
  oilRunStatement: {
    type: "oilRunStatement",
    singular: "oil run",
    plural: "oil runs",
    // The statement lands in the revenue/accounting domain, so it gates on
    // accounting. Tank/meter creation and lease-tie are best-effort within the
    // write (each has its own RLS check) so an accounting-only user still files
    // the statement even if they can't create devices.
    capability: "manage_statements",
    skillId: "oil-run-statements",
    needsWell: false,
    belongs:
      "A crude-oil purchaser RUN / SETTLEMENT statement: a buyer's document listing oil RUNS (hauls) off a tank or meter with barrels, price, gross, taxes, net, the transporter, and the purchaser. Filed as a revenue statement with the PDF attached; every run becomes a settlement line.",
    notHere:
      "Its runs are NOT production readings (production) and NOT plain field run tickets (runTickets) — a settlement is a financial document. Gas gatherer settlements are gasSettlementStatement, not this.",
  },
  gasSettlementStatement: {
    type: "gasSettlementStatement",
    singular: "gas settlement",
    plural: "gas settlements",
    // Files a financial gas settlement on a meter; gates on accounting. Meter /
    // gatherer creation and the lease-tie are best-effort within the write (each
    // has its own RLS check) so an accounting-only user still files it.
    capability: "manage_statements",
    skillId: "gas-settlement-statements",
    needsWell: false,
    belongs:
      "A natural-gas purchaser/plant SETTLEMENT statement: a gatherer's document settling gas off a METER over a period, paying the producer for residue gas + plant products (NGLs) minus fees, with the gross/residue volumes (MCF/MMBtu). Filed as a meter settlement; the gatherer is created and tied to the meter, the meter to its lease.",
    notHere:
      "Not a daily meter reading (meterReadings) or well production (production) — a settlement is a financial document. Crude oil settlements are oilRunStatement, not this.",
  },
  vendorInvoice: {
    type: "vendorInvoice",
    singular: "vendor invoice",
    plural: "vendor invoices",
    // Money going OUT. Gates on the invoice capability added with the storage
    // tables, not on `manage_statements` (which is revenue coming in). Vendor
    // creation is best-effort inside the write, with its own RLS check, so a
    // payables-only user still files the invoice.
    capability: "manage_invoices",
    skillId: "vendor-invoices",
    needsWell: false,
    belongs:
      "A vendor's INVOICE or signed FIELD TICKET billing the operator for work done: the vendor and invoice number, the property it was worked on, and the charge lines with quantity, rate, amount, service dates, and any AFE / cost center / ticket number. Filed as a payable with the document attached; every charge line is kept.",
    notHere:
      "Not a revenue statement — those pay the operator and are oilRunStatement / gasSettlementStatement. Not a bank or ledger entry (transactions): an invoice is owed, not paid. The dated job it describes may ALSO be a `service` record on a well page, but the money belongs here.",
  },
};

/**
 * Dedicated whole-document types: when a document (or one segment of it) is
 * classified as one of these, the scan routes it EXCLUSIVELY to the mapped
 * ingest type (a dedicated extractor + writer) instead of the generic per-type
 * fan-out. This is what "detect the document type first, then use its dedicated
 * skill" means: an oil run statement is filed by the oil-run-statement flow and
 * never also scattered into production / run tickets / transactions.
 *
 * Keyed by the CLASSIFIER's page category (`classify-pages.ts`), and by
 * `categorizeDocument`'s category on the whole-document fallback — the two
 * deliberately use the same strings so routing is a lookup, not a translation.
 * Triage never routes here; it only ever runs on text already decided NOT to be
 * a dedicated type. Extend this map to add future dedicated docs.
 */
export const DEDICATED_DOCUMENT_SKILLS: Record<string, IngestType> = {
  oilRunStatement: "oilRunStatement",
  // An aggregated revenue statement files the SAME records as a run statement —
  // the leases it settles, the purchaser, the money — so it shares that writer.
  // The two categories are kept apart for what they do NOT share: only a run
  // statement is read at run grain, because only a run statement HAS runs. See
  // `computeRunStatementBackfill`, which is gated on the run category alone.
  revenueStatement: "oilRunStatement",
  gasSettlementStatement: "gasSettlementStatement",
  vendorInvoice: "vendorInvoice",
};

/**
 * For a dedicated document, the FULL set of destinations one comprehensive
 * extraction should propose — NOT just the headline type. A crude run/settlement
 * statement yields the leases it settles (create missing), the oil runs (which
 * tie each tank to its lease and record the purchaser), and the revenue
 * transactions. The skill prompt asks the model for all of these in one pass, so
 * the output is complete instead of a single narrow type. Filtered to the
 * enabled types at scan time.
 */
export const DEDICATED_DOCUMENT_TARGETS: Record<string, IngestType[]> = {
  oilRunStatement: ["leases", "purchasers", "oilRunStatement", "transactions"],
  revenueStatement: ["leases", "purchasers", "oilRunStatement", "transactions"],
  gasSettlementStatement: [
    "gatherers",
    "meters",
    "leases",
    "gasSettlementStatement",
    "transactions",
  ],
  // JUST THE INVOICE. One destination, deliberately.
  //
  // The other dedicated documents fan out because a settlement statement really
  // is several records (a lease, a purchaser, runs, revenue). An invoice is one
  // record: the invoice. Asking the same pass to also mint a vendor and a
  // service history entry gave the model three jobs, and the failure mode was
  // not a bad vendor row — it was the whole scan coming back empty because one
  // sub-goal could not be satisfied.
  //
  // Vendor creation and the service record are worth having and can come back
  // as follow-ups once this path is boringly reliable. Reading a document and
  // filling one shape is the deterministic core; everything else is a bonus
  // that must not be able to take the core down with it.
  //
  // Never `transactions`: an invoice is a payable that has not been paid, and
  // filing a ledger entry here double-counts it when the payment lands.
  vendorInvoice: ["vendorInvoice"],
};

/**
 * Which skill files drive each dedicated document's ANALYZE and VALIDATE agents.
 * The analyze skill turns the transcribed text into records; the validate skill
 * audits them against that document's requirements. Keyed by document category
 * (the categorize agent's output), so the harness routes to the right pair.
 */
export const DEDICATED_DOCUMENT_PROMPTS: Record<
  string,
  { analyze: string; validate: string }
> = {
  oilRunStatement: {
    analyze: "oil-run-statement",
    validate: "validate",
  },
  // Same prompt pair as the run statement: the oil-run skill already emits the
  // lease / purchaser / transaction rows an aggregated statement carries, and
  // returns no runs when the document itself itemises none.
  revenueStatement: {
    analyze: "oil-run-statement",
    validate: "validate",
  },
  gasSettlementStatement: {
    analyze: "gas-settlement-statement",
    validate: "gas-settlement-statement-validate",
  },
  vendorInvoice: {
    analyze: "vendor-invoice",
    validate: "vendor-invoice-validate",
  },
};

/**
 * Render the destination catalog for the prompt: one line per enabled type with
 * "what belongs / what does not". Generated from `INGEST_TYPE_META` so it can
 * never list a type the writer cannot handle, and never omits one it can.
 */
export function renderDestinationCatalog(
  types: readonly IngestType[]
): string {
  return types
    .map((t) => {
      const m = INGEST_TYPE_META[t];
      return `- ${t} (${m.plural}): ${m.belongs} ${m.notHere}`;
    })
    .join("\n");
}

/**
 * Why an upload's AI scan produced (or didn't produce) records. Returned to the
 * client so a surface like Data Entry can tell "found records" apart from "found
 * nothing", "you're out of AI credits", and other gated-off states, instead of
 * collapsing every case into one ambiguous "All done". Ordered loosely from
 * best to worst outcome; `summariseIngestScan` defines the real precedence.
 */
export type IngestScanStatus =
  | "records" // proposals were produced; approval cards will open
  | "all_on_file" // records were found, but every one is already on file (deduped away)
  | "no_records" // scan ran end to end but found nothing addable
  | "no_credits" // the org's AI credit balance is exhausted; it must top up
  | "ai_unavailable" // AI gate closed for another reason (billing/config)
  | "scan_disabled" // the org turned off "scan uploaded documents"
  | "no_skills" // no data-entry skills are enabled, so nothing can be proposed
  | "unreadable" // a file's bytes could not be parsed at all
  | "error"; // an unexpected failure while analysing

/** Batch-level outcome of an upload's AI scan, for user-facing messaging. */
/**
 * What one document's scan actually DID, carried back to the browser.
 *
 * The pipeline logs richly on the server, which is no help to someone watching
 * an upload spin in a tab. A scan that finds nothing is indistinguishable from a
 * scan that mis-routed unless it can say which category it chose, which
 * destinations it was allowed to fill, and where the time went — so it says.
 */
export interface IngestScanTrace {
  fileName: string;
  /** Wall-clock for the whole scan of this file. */
  ms: number;
  /** How the document was routed once read. */
  route: "greasebook" | "structured" | "dedicated" | "generic" | "none";
  /** The categorizer's verdict, when a category call was made. */
  category?: string;
  /** Destinations the route was allowed to fill (after the skill toggles). */
  targets?: string[];
  /** Per-stage wall-clock, only for stages that ran. */
  stages: { stage: string; ms: number }[];
  /** Rows proposed per destination. Empty when the scan found nothing. */
  groups: { type: string; rows: number }[];
  status: IngestScanStatus;
}

export interface IngestScanSummary {
  /** The single headline status for the batch (see `summariseIngestScan`). */
  status: IngestScanStatus;
  /** How many files were scanned. */
  filesScanned: number;
  /** Total record rows proposed across every file in the batch. */
  recordsFound: number;
  /** Names of files whose bytes could not be parsed, for a precise warning. */
  unreadableFiles: string[];
  /** Per-file trace, for the browser console. See `IngestScanTrace`. */
  traces?: IngestScanTrace[];
}

/** Per-file scan result the batch folds into an `IngestScanSummary`. */
export interface IngestFileScan {
  fileName: string;
  status: IngestScanStatus;
  recordsFound: number;
}

/**
 * Precedence for the batch headline. "records" wins first: if any file produced
 * proposals, approval cards are already showing, so that is the headline even if
 * a later file hit a gate (e.g. credits ran out mid-batch). Otherwise a gate
 * reason (credits/config/skills) dominates, then a per-file read failure, then
 * "no records". Read failures are also surfaced separately via `unreadableFiles`.
 */
const SCAN_STATUS_PRIORITY: readonly IngestScanStatus[] = [
  "records",
  "no_credits",
  "ai_unavailable",
  "scan_disabled",
  "no_skills",
  "unreadable",
  "error",
  // "all_on_file" beats "no_records": a file whose records were all already on
  // file is a more specific, more reassuring outcome than "found nothing".
  "all_on_file",
  "no_records",
];

/** Fold per-file scan results into one summary for the whole upload batch. */
export function summariseIngestScan(
  perFile: readonly IngestFileScan[]
): IngestScanSummary {
  const present = new Set(perFile.map((f) => f.status));
  const status =
    SCAN_STATUS_PRIORITY.find((s) => present.has(s)) ?? "no_records";
  return {
    status,
    filesScanned: perFile.length,
    recordsFound: perFile.reduce((sum, f) => sum + f.recordsFound, 0),
    unreadableFiles: perFile
      .filter((f) => f.status === "unreadable")
      .map((f) => f.fileName),
  };
}

/**
 * Types that CREATE a facility or directory entry other rows hang off: wells,
 * leases, tanks, meters, batteries, and the people/company directories.
 *
 * Everything else references one of these. A `wellEquipment` card asks which
 * well; a `runTickets` card asks which tank. Offering the dependent card first
 * dead-ends the user on a picker whose answer does not exist yet, when the very
 * next card in the queue would have created it.
 */
const CREATES_ENTITY: ReadonlySet<IngestType> = new Set<IngestType>([
  "wells",
  "injectionWells",
  "leases",
  "tanks",
  "batteries",
  "meters",
  "contractors",
  "serviceProviders",
  "gatherers",
  "purchasers",
  "royaltyOwners",
  "employees",
]);

/**
 * Queue precedence: entity-creating proposals come first, everything else keeps
 * its arrival order.
 *
 * Two ranks rather than a dependency graph on purpose. The real graph has one
 * edge that matters (a thing must exist before rows attach to it), and a
 * general sorter over 33 types would encode ordering nobody asked for between
 * rows that are genuinely independent.
 */
export function ingestQueueRank(type: IngestType): number {
  return CREATES_ENTITY.has(type) ? 0 : 1;
}
