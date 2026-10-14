/**
 * What the user is looking at, rendered for Orion.
 *
 * Not which route they are on. What is ON the screen: which wells are in the
 * map's viewport, which operator is open in the modal, which rows survived the
 * filter. Orion is docked to the app, and "this well", "these results", "that
 * operator" are how an operator talks. Resolving those is the difference between
 * a chat window and a copilot.
 *
 * ## Slices, not one selection
 *
 * This used to carry a single `AiSelection` — one file, folder or well. A screen
 * showing a map, a filter set and an open modal has three things worth saying
 * and had room for one. So any component can publish a SLICE describing its own
 * corner of the screen, keyed by name, and this renders them together under a
 * budget.
 *
 * Three rules the builders live by, all of them learned from what the model does
 * with the result:
 *
 *   1. **Ids next to names.** Every tool takes an id. A slice naming "PETEX"
 *      without its operator number costs a lookup round trip it could have saved.
 *   2. **The count before the list.** A truncated list read as a whole
 *      population is the worst failure this can have, so the count is the first
 *      line and truncation only ever drops from the END.
 *   3. **The query beside the rows.** A viewport that lists 15 of 400 also emits
 *      its bbox and filters, so Orion can re-run the search through the tools it
 *      already has instead of answering from the 15.
 */

/** A file, folder, or well the user currently has selected / open. */
export interface AiSelection {
  kind: "file" | "folder" | "well";
  id: string;
  name: string;
  /** File type (pdf, image, md, …) when `kind` is "file". */
  fileType?: string;
}

/** One component's description of its corner of the screen. */
export interface ContextSlice {
  /** Sort key. Higher wins the budget. See `SLICE_PRIORITY`. */
  priority: number;
  /** Heading, e.g. `Open: operator PETEX (number 123456)`. */
  label: string;
  /** Rendered lines. Builders render; this module never serialises objects. */
  lines: string[];
}

/**
 * The ordering, named.
 *
 * What is IN FRONT of the user outranks what is behind it. A modal is the thing
 * being read; the map under it is background. The router only sees the first 200
 * characters (`MAX_PAGE_CHARS` in `router.ts`), so this ordering is also what
 * decides which surface the turn gets classified against.
 */
export const SLICE_PRIORITY = {
  /** A modal or dialog: the user is looking directly at this. */
  modal: 100,
  /** The selected/open entity on the page. */
  selection: 80,
  /** The page's own contents: a viewport, a result list, a table. */
  contents: 60,
  /** Filters, ranges, sort order — what shaped the contents. */
  controls: 50,
  /** Ambient facts about the page. */
  ambient: 40,
} as const;

/**
 * Total characters the block may spend.
 *
 * Generous, because this rides in the message tail rather than the cached system
 * prefix (see the route), and stingy enough that a 400-well viewport cannot push
 * the actual question out of the model's attention.
 */
export const PAGE_CONTEXT_BUDGET = 2_500;

/** Rows a builder should list before it truncates itself and states the count. */
export const MAX_LIST_ROWS = 15;

/** Stable key for the legacy single-selection slice. */
export const SELECTION_SLICE_KEY = "selection";

/** Friendly description of the page at `pathname`. */
export function describePage(pathname: string): string {
  if (pathname === "/") return "the Dashboard (home overview)";
  const segments = pathname.split("/").filter(Boolean);
  const [top, sub] = segments;
  switch (top) {
    case "dashboard":
      return "the admin Dashboard (ARR, growth, revenue by customer, customers table)";
    case "clients":
      return "the Clients page (every customer org)";
    case "prospecting":
      return "the Prospecting page (Recon operator map, targets, enrich queue, outreach sequence)";
    case "outbound":
      return "the Outbound page (Queue tab: the outreach sequence, what is due today)";
    case "support":
      return "the Support desk (customer support threads)";
    case "email":
      return "the Email page (their own Gmail, read only)";
    case "slack":
      return "the Slack page";
    case "drive":
      return sub === "docs" ? "a Google Doc in the Drive viewer" : "the Drive page (their Google Drive)";
    case "analytics":
      return "the Analytics page";
    case "finance":
      return "the Finance page";
    case "logs":
      return "the Logs page (platform request and error logs)";
    case "git":
      return "the Git page (commit history)";
    case "settings":
      return "the admin Settings page";
    case "files":
      return "the Files page (company document library)";
    case "wells":
      return sub ? `the detail page for well "${sub}"` : "the Wells list";
    case "tasks":
      return "the admin Tasks board";
    case "calendar":
      return "the Calendar (their Google Calendar)";
    case "inventory":
      return "the Inventory page";
    case "people":
      return "the People page (contractors, vendors, royalty owners)";
    case "projects":
      return sub ? `the "${sub}" admin project` : "the admin Projects list";
    case "pricing":
      return "the Pricing page (posted oil & gas prices vs benchmark, with projections)";
    case "scout":
      return "the Scout page (Texas public-record map of wells, operators and permits)";
    case "facilities":
      return "the Facilities page (cross-substance flow map)";
    case "orion":
      return "the Orion chat page";
    default:
      return `the ${top ?? "home"} page`;
  }
}

/**
 * The legacy single selection, as a slice.
 *
 * Kept because four pages still publish through `setSelection`, and because the
 * well wording below is load-bearing: without the explicit instruction, "this
 * well" was resolved by name lookup rather than by the id already on screen.
 */
export function selectionSlice(selection: AiSelection | null): ContextSlice | null {
  if (!selection) return null;
  if (selection.kind === "file") {
    const type = selection.fileType ? ` (${selection.fileType.toUpperCase()})` : "";
    return {
      priority: SLICE_PRIORITY.selection,
      // The phrasing is load-bearing, not styling. `subjectFromPageContext`
      // matches `the file "<name>"` to find a LAS, so a tidier heading would
      // silently stop the geology harness resolving the open log. Asserted in
      // page-context.test.ts.
      label: `They have the file "${selection.name}"${type} open`,
      lines: [
        `file id: ${selection.id}`,
        selection.fileType === "seismic"
          ? `A 3D seismic volume: read its analysis with read_seismic_brief (file_id above).`
          : `Read it with read_file, or read_las_full when the name ends in .las, .mlw, .ml_ or .td_.`,
      ],
    };
  }
  if (selection.kind === "folder") {
    return {
      priority: SLICE_PRIORITY.selection,
      label: `Browsing folder "${selection.name}"`,
      lines: [`folder id: ${selection.id}`],
    };
  }
  return {
    priority: SLICE_PRIORITY.selection,
    label: `Viewing well "${selection.name}"`,
    lines: [
      `well id: ${selection.id}`,
      `If they say "this well", "the well", or ask about a well without naming ` +
        `one, they mean this one. Pass well id "${selection.id}" to the well tools.`,
    ],
  };
}

/**
 * Fit lines into the characters available, dropping from the END.
 *
 * Dropping from the end is the whole contract: builders put the count on the
 * first line precisely so that a truncated list still says how many there were.
 * Trimming from the front would turn "47 wells in view" into fifteen rows that
 * read as the entire population.
 */
function fitLines(
  lines: readonly string[],
  available: number
): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > available) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === lines.length) return { kept, dropped: 0 };

  // Make room for the tail by giving back lines, then say how many went.
  const tail = (n: number) => `...and ${n} more`;
  while (kept.length > 0 && used + tail(lines.length - kept.length + 1).length + 1 > available) {
    used -= kept[kept.length - 1].length + 1;
    kept.pop();
  }
  const dropped = lines.length - kept.length;
  if (used + tail(dropped).length + 1 <= available) kept.push(tail(dropped));
  return { kept, dropped };
}

/**
 * Render the block, highest priority first, inside the budget.
 *
 * A slice that cannot fit its heading is dropped whole rather than shown as a
 * bare title, because a heading with no body reads as "there is nothing here".
 */
export function renderSlices(
  slices: readonly ContextSlice[],
  budget: number = PAGE_CONTEXT_BUDGET
): string {
  const ordered = [...slices].sort(
    (a, b) => b.priority - a.priority || a.label.localeCompare(b.label)
  );
  const blocks: string[] = [];
  let spent = 0;
  for (const slice of ordered) {
    const head = `### ${slice.label}`;
    const headCost = head.length + 1;
    if (spent + headCost >= budget) break;
    const { kept } = fitLines(slice.lines, budget - spent - headCost);
    if (slice.lines.length > 0 && kept.length === 0) continue;
    blocks.push([head, ...kept].join("\n"));
    spent += headCost + kept.reduce((n, l) => n + l.length + 1, 0);
  }
  return blocks.join("\n\n");
}

/**
 * The whole block: where they are, then what is on the screen.
 *
 * The route appends this to the current user turn rather than the system prompt,
 * so a navigation cannot invalidate the cached prefix and an old turn keeps the
 * viewport it was asked from.
 */
export function buildPageContext(
  pathname: string,
  slices: readonly ContextSlice[]
): string {
  const where = `The user is currently on ${describePage(pathname)} (route ${pathname}).`;
  const body = renderSlices(slices, PAGE_CONTEXT_BUDGET - where.length - 2);
  return body ? `${where}\n\n${body}` : where;
}
