/**
 * Orion's skills — the capability modules the assistant can draw on, surfaced
 * on the Skills page so the team can see (and toggle) what Orion is allowed to
 * do. Each skill maps to one or more of the underlying tools defined in
 * `src/lib/ai/tools.ts`; the `tools` list names them for reference.
 *
 * This is the catalog/seed. Enablement is currently held in the page's local
 * state — wiring it to a persisted, per-workspace setting that actually gates
 * the tools handed to the model is a follow-up.
 */

export type SkillCategory =
  | "Data"
  | "Documents"
  | "Analysis"
  | "Productivity"
  | "Memory";

export interface OrionSkill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  /** Lucide icon key resolved by the UI (see SKILL_ICONS). */
  icon: string;
  /** Underlying tool names this skill is backed by. */
  tools: string[];
  /** Example prompts that exercise the skill. */
  examples: string[];
  /** Enabled out of the box. */
  enabledByDefault: boolean;
  /** Mutates company data — every action is gated behind explicit approval. */
  requiresApproval?: boolean;
  /** Built-in skills can't be deleted from the catalog. */
  builtIn: boolean;
}

export const SKILL_CATEGORIES: SkillCategory[] = [
  "Data",
  "Documents",
  "Analysis",
  "Productivity",
  "Memory",
];

export const ORION_SKILLS: OrionSkill[] = [
  {
    id: "well-intelligence",
    name: "Well Intelligence",
    description:
      "Look up wells and their current economics (oil/gas/water rates, revenue, lifting cost, P/L) plus installed equipment and field notes.",
    category: "Data",
    icon: "droplet",
    tools: [
      "list_wells",
      "get_well",
      "get_well_equipment",
      "get_well_service",
      "get_well_comments",
    ],
    examples: [
      "Which wells are losing money right now?",
      "Show me the header and equipment for Smith 4H.",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "production-analysis",
    name: "Production Analysis",
    description:
      "Pull daily production history and reason over output, decline, and trends across any date range.",
    category: "Analysis",
    icon: "trending-up",
    tools: ["get_production"],
    examples: [
      "What's the 90-day oil decline on Smith 4H?",
      "Compare gas output across the Lazy J wells this quarter.",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "field-measurement",
    name: "Tanks, Meters & Allocation",
    description:
      "Read the field-measurement layer: tank batteries and tanks, gas meters, run tickets (oil hauled off a tank), and injection/SWD readings — plus how each tank's oil is split to its wells (the allocation method and per-well percentages). This is where a well's production comes from before it's allocated.",
    category: "Data",
    icon: "fuel",
    tools: [
      "list_batteries",
      "list_tanks",
      "get_tank_allocation",
      "list_run_tickets",
      "list_meters",
      "get_injection",
    ],
    examples: [
      "How is the Lazy J battery's oil split across its wells?",
      "What did we haul off tank 7 last month, and who bought it?",
      "How much water did we inject at the SWD in June?",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "purchaser-statements",
    name: "Purchaser Statements",
    description:
      "Read purchaser settlement statements — the monthly documents a crude/gas buyer sends (volumes sold, price, value, deducts, taxes) and their posting status — and extract the line items straight out of an uploaded statement PDF or check stub. Use for settlement values, which statements are unposted, or reading a settlement document.",
    category: "Analysis",
    icon: "receipt-text",
    tools: ["list_statements", "extract_statement"],
    examples: [
      "Which purchaser statements are still unposted?",
      "What did Plains pay us on last month's oil statement?",
      "Read this settlement PDF and total the oil value by lease.",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "well-testing",
    name: "Well Tests & Downtime",
    description:
      "Read a well's rate tests (periodic oil/gas/water checks) and its downtime / shut-in events. A test's share of its battery drives the oil split, its water rate drives every water split, and its downtime explains when and why a well was offline.",
    category: "Analysis",
    icon: "gauge",
    tools: ["get_well_tests"],
    examples: [
      "When was Smith 4H last tested and at what rate?",
      "How many days was the Carter 2H down this quarter?",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "well-log-analysis",
    name: "Well Log & Dataset Analysis",
    description:
      "Read structured data files (LAS well logs and CSV/TSV tables) for headers, curves/columns, and statistics, and pull curve-vs-depth samples to compute on.",
    category: "Analysis",
    icon: "line-chart",
    tools: ["read_las_full", "describe_dataset", "get_curves_data"],
    examples: [
      "What curves are in this LAS and over what interval?",
      "Plot GR vs depth from 9,800–10,200 ft.",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "document-search",
    name: "Document Search",
    description:
      "Search and read the company's documents (reports, leases, notes, and OCR'd PDFs) and browse the file tree to find where something lives.",
    category: "Documents",
    icon: "file-search",
    tools: ["search_documents", "read_file", "browse_files"],
    examples: [
      "Find the Lazy J lease terms.",
      "Summarize the latest geology report.",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "royalty-ownership",
    name: "Royalty & Ownership",
    description:
      "Look up royalty and mineral owners with their interest type, net decimal interest, last payment, and contact info, across the company or one well.",
    category: "Data",
    icon: "landmark",
    tools: ["get_royalty_owners"],
    examples: [
      "Who owns royalty in the Lazy J lease?",
      "List owners whose last payment is overdue.",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "people-vendors",
    name: "People & Vendors",
    description:
      "Look up contractors (field crews) and service providers with their trade, contact info, and status.",
    category: "Data",
    icon: "users",
    tools: ["list_people"],
    examples: [
      "Find an available electrician.",
      "Which vendors do we use for hauling?",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "inventory-lookup",
    name: "Inventory Lookup",
    description:
      "Check materials and parts across the yards and warehouses: quantity, location, unit cost, and stock status.",
    category: "Data",
    icon: "package",
    tools: ["get_inventory"],
    examples: [
      "Are we low on 5½\" tubing?",
      "Where's the nearest packer in stock?",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "tasks-scheduling",
    name: "Task Board",
    description:
      "Review the kanban board, open new tasks, and update existing ones: status, priority, assignee, and deadlines. Move a task across the board, reassign it, or reschedule it.",
    category: "Productivity",
    icon: "list-todo",
    tools: ["list_tasks", "create_task", "update_task"],
    examples: [
      "What's in progress right now?",
      "Add a high-priority task to inspect the Smith 4H pump.",
      "Move the Lazy J workover task to Doing and assign it to J. Hale.",
    ],
    enabledByDefault: true,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "calendar",
    name: "Calendar & Scheduling",
    description:
      "Read the operations calendar and schedule or reschedule events (field work, maintenance, hauling, deadlines, and meetings) as all-day or timed entries.",
    category: "Productivity",
    icon: "calendar",
    tools: [
      "list_calendar_events",
      "create_calendar_event",
      "update_calendar_event",
    ],
    examples: [
      "What's on the calendar next week?",
      "Schedule a workover on the Lazy J for Tuesday at 8am.",
    ],
    enabledByDefault: true,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "conversation-recall",
    name: "Conversation Recall",
    description:
      "Search past Orion conversations and read them in full to pick up where an earlier discussion left off.",
    category: "Memory",
    icon: "messages-square",
    tools: ["search_chat_history", "read_conversation"],
    examples: [
      "What did we decide about the Lazy J workover?",
      "Pull up our earlier chat on decline curves.",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "memory",
    name: "Memory & Preferences",
    description:
      "Remember durable facts and preferences (units, naming conventions, priorities) and recall them in future chats.",
    category: "Memory",
    icon: "brain",
    tools: ["remember", "recall_memory"],
    examples: [
      "Remember that I prefer barrels over cubic meters.",
      "What units do I usually work in?",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
  {
    id: "guided-data-entry",
    name: "Guided Data Entry",
    description:
      "When you ask Orion to fill in or update a record from your files, it reads ALL of the relevant documents (not just one), pulls every detail, routes each fact to the right place (equipment, service history, header, production, field notes), and queues the writes for your approval.",
    category: "Productivity",
    icon: "clipboard-list",
    tools: [
      "browse_files",
      "search_documents",
      "read_file",
      "read_pdf",
      "add_well_equipment",
      "add_well_service",
      "update_well",
      "record_production",
      "add_well_comment",
    ],
    examples: [
      "Update this well's equipment from its files.",
      "Fill in everything you can find on the Carter 2H.",
      "What equipment are we missing on Repass 2 based on the tickets?",
    ],
    enabledByDefault: true,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "record-updates",
    name: "Well Records",
    description:
      "Create and update well data: register a well or edit its header, record and correct daily production, log and fix equipment, track service history (repairs, tests, vendor jobs), and post field comments. Every write pauses for your explicit approval before it runs.",
    category: "Productivity",
    icon: "pencil",
    tools: [
      "create_well",
      "update_well",
      "record_production",
      "update_production",
      "add_well_equipment",
      "update_well_equipment",
      "add_well_service",
      "add_well_comment",
    ],
    examples: [
      "Register a new well named Carter 2H.",
      "Log a new pump installed on Smith 4H.",
      "Fix yesterday's oil reading on the Lazy J to 42 bbl.",
    ],
    enabledByDefault: false,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "field-ops-entry",
    name: "Field Operations Entry",
    description:
      "Record field-measurement data: run tickets (oil/water hauled off a tank), well downtime / shut-in periods, and well rate tests. Every write pauses for your explicit approval before it runs.",
    category: "Productivity",
    icon: "clipboard-list",
    tools: [
      "record_run_ticket",
      "record_downtime",
      "record_well_test",
    ],
    examples: [
      "Log a run ticket: 182 bbl off tank 7 to Plains on the 3rd.",
      "Mark Smith 4H down for a pump failure from the 5th to the 9th.",
      "Record a well test on the Lazy J: 42 bbl oil over 24 hours.",
    ],
    enabledByDefault: false,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "people-records",
    name: "People & Vendor Records",
    description:
      "Add and update contractors, service providers (vendors), and royalty/mineral owners: names, trades and services, contact info, status, and owners' well interests. Every write pauses for your explicit approval before it runs.",
    category: "Data",
    icon: "user-plus",
    tools: [
      "create_contractor",
      "update_contractor",
      "create_service_provider",
      "update_service_provider",
      "create_royalty_owner",
      "update_royalty_owner",
    ],
    examples: [
      "Add a new pumper named Cade Rollins, phone 555-0142.",
      "Update the Lazy J royalty owner's mailing address.",
      "Add a mineral owner with a 0.125 interest in the Carter 2H.",
    ],
    enabledByDefault: false,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "inventory-management",
    name: "Inventory Management",
    description:
      "Add materials and parts to inventory and update existing items: quantity on hand, location, unit cost, and stock status. Every write pauses for your explicit approval before it runs.",
    category: "Data",
    icon: "package-plus",
    tools: ["create_inventory_item", "update_inventory_item"],
    examples: [
      "Add 40 joints of 5½\" tubing to the Graham yard.",
      "Mark the surface packers as Low.",
    ],
    enabledByDefault: false,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "bookkeeping",
    name: "Bookkeeping",
    description:
      "Record and correct entries in the accounting ledger: revenue and expense transactions tied to a well and category, with amount, date, counterparty, and revenue detail. Every write pauses for your explicit approval before it runs.",
    category: "Data",
    icon: "receipt",
    tools: ["create_transaction", "update_transaction"],
    examples: [
      "Log a $2,400 pumping expense on the Smith 4H dated last Friday.",
      "Fix the counterparty on that oil-sales entry to Plains Marketing.",
    ],
    enabledByDefault: false,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "oil-run-statements",
    name: "Oil Run Statements",
    description:
      "When you upload a crude-oil purchaser run / settlement statement to Data Entry, Orion detects the document type and files it on the revenue page: it creates the statement (with the PDF attached), adds one line per oil run (barrels, price, gross, taxes, net, transporter), ties each tank/meter to its lease, and saves the purchaser's contact. You review every run before it is written.",
    category: "Documents",
    icon: "receipt-text",
    tools: [],
    examples: [
      "Drop in Plains' monthly oil run statement and approve the runs.",
      "Upload a settlement statement to file every run off tank 7 this month.",
    ],
    enabledByDefault: true,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "gas-settlement-statements",
    name: "Gas Settlement Statements",
    description:
      "When you upload a natural-gas purchaser/plant settlement statement (a POP gas settlement) to Data Entry, Orion detects the document type and files it on the meter: it records the settlement (gross vs residue volumes, and the residue + NGL − fees economics), creates the gatherer and ties it to the meter, ties the meter to its lease, and logs the gas-sales revenue. You review every record before it is written.",
    category: "Documents",
    icon: "receipt-text",
    tools: [],
    examples: [
      "Drop in Targa's monthly gas settlement and approve it.",
      "Upload the plant statement to file the Baldwin meter's gas revenue.",
    ],
    enabledByDefault: true,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "vendor-invoices",
    name: "Vendor Invoices",
    description:
      "When you upload a vendor invoice or a signed field ticket, Orion detects the document type and files it on the invoices page: the vendor, the property it was worked on, and every charge line with its quantity, rate, amount, service dates and AFE / cost center / ticket references, plus the totals and the vendor's own tax label. Nothing is posted to the ledger — an invoice is owed, not paid — and you review every line before it is written.",
    category: "Documents",
    icon: "receipt-text",
    tools: [],
    examples: [
      "Drop in the pulling unit's invoice and approve the charges.",
      "Upload a signed workover ticket to file what it billed against the well.",
    ],
    enabledByDefault: true,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "proactive-ingest",
    name: "Auto-fill from Uploads",
    description:
      "When you upload a document, Orion reads it in the background and offers to add any people, vendors, owners, inventory, transactions, production, run tickets, downtime, well tests, gatherer gas-volume statements, or oil run statements it finds. You review and approve each one before it is written. Turn the whole feature on or off in Settings → AI.",
    category: "Data",
    icon: "sparkles",
    tools: [],
    examples: [
      "Upload a run sheet and approve the production readings Orion extracts.",
      "Drop in a vendor list to add all the service providers at once.",
    ],
    enabledByDefault: true,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "document-authoring",
    name: "Document Authoring",
    description:
      "Write new documents in a project and revise existing native text documents: summaries, analyses, memos, and notes, in Markdown. Every write pauses for your explicit approval before it runs.",
    category: "Documents",
    icon: "file-pen",
    tools: ["create_document", "edit_document"],
    examples: [
      "Draft a prospect summary for the Carter 2H in this project.",
      "Revise the geology memo to add the new log picks.",
    ],
    enabledByDefault: false,
    requiresApproval: true,
    builtIn: true,
  },
  {
    id: "product-help",
    name: "Product Help",
    description:
      "Answer how-to questions about WildcatIQ itself from the written help docs at /docs: 147 one-task pages across 17 sections (getting started, wells and leases, daily production entry, tanks and meters, well tests and allocation, saltwater disposal, finance, reports, Orion, documents and notes, projects, agenda, team, people and access, Scout, your account, getting help). Search in the user's own words, read the page, and answer with its steps rather than from memory.",
    category: "Documents",
    icon: "book-open",
    tools: ["search_docs", "read_doc"],
    examples: [
      "How do I stick a tank?",
      "How do I stop a pumper from seeing revenue?",
    ],
    enabledByDefault: true,
    builtIn: true,
  },
];
