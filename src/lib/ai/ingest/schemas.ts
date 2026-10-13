/**
 * Proactive ingest: the per-type row schemas the model fills, mirroring the
 * existing `create*Input` / `Draft*` shapes so an approved row passes straight to
 * the write action (step 3). Reuses the accounting and production extractor
 * shapes verbatim for those two types. Pure module (zod only).
 */

import { z } from "zod";
import type { IngestType } from "@/lib/ai/ingest/types";

/**
 * Numeric fields must also accept the STRINGS the edit-before-approve grid emits
 * ("3200", "$8,750", "1,234.5", ""). The model returns real JSON numbers on
 * extraction (passed through untouched); on approval the grid hands back strings,
 * so we strip `$`/commas/whitespace and coerce. Blank → the fallback. A
 * non-numeric value is left as-is so Zod still reports a clear error, not NaN.
 * Two concrete helpers (rather than one parameterised one) so the inferred type
 * is exactly `number` / `number | null`.
 */
function numericPreprocess(fallback: number | null) {
  return (v: unknown): unknown => {
    if (typeof v === "number") return v;
    if (v == null) return fallback;
    const s = String(v).trim().replace(/[$,\s]/g, "");
    if (s === "") return fallback;
    const n = Number(s);
    return Number.isFinite(n) ? n : v;
  };
}

/** Coerces to a number, blank/absent → 0 (mirrors a `.default(0)` field). */
const coerceNumber = () => z.preprocess(numericPreprocess(0), z.number());

/**
 * An optional string that tolerates an explicit `null`. `z.string().default("")`
 * only fills `undefined`, so when the model emits `"purchaser": null` for a field
 * the document leaves blank, a bare `.default("")` REJECTS the row and drops it.
 * Map null/absent to "" before validating. Use for every free-text field that is
 * allowed to be blank.
 */
const looseString = () =>
  z.preprocess((v: unknown) => (v == null ? "" : v), z.string().default(""));

/**
 * A date cell. Keeps ISO/text dates as-is but coerces the value a SPREADSHEET
 * export yields: `.xlsx`/CSV store a formatted date column as an Excel serial
 * day-count, and the model faithfully copies that NUMBER — which a bare
 * `z.string()` would reject, dropping every dated row. Convert a plausible serial
 * to ISO `YYYY-MM-DD`; pass strings through untouched.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // Excel day 0 (1900 leap-year quirk)
function excelSerialToIso(n: number): string | null {
  // Bound to a plausible date range (~1900-03 to ~2118) so a real numeric value
  // that isn't a date is left alone rather than mangled into one.
  if (!Number.isFinite(n) || n <= 59 || n >= 80000) return null;
  return new Date(EXCEL_EPOCH_MS + n * 86_400_000).toISOString().slice(0, 10);
}
const coerceDate = () =>
  z.preprocess(
    (v: unknown): unknown =>
      typeof v === "number"
        ? (excelSerialToIso(v) ?? String(v))
        : normalizeIso(v),
    z.string()
  );

/** Like {@link coerceDate} but for an optional/blank-allowed date field. */
const coerceDateOptional = () =>
  z.preprocess(
    (v: unknown): unknown =>
      typeof v === "number"
        ? (excelSerialToIso(v) ?? String(v))
        : normalizeIso(v),
    z.string().default("")
  );

/**
 * A clock-time cell → 24-hour `HH:MM`, or "" when blank/unparseable. A
 * spreadsheet's single timestamp column is often mapped to `time` as well as
 * `date`, so the cell can hold the whole "7/10/2026 6:20 PM"; this pulls the
 * clock time out (and normalizes 12h/24h). An unparseable value blanks rather
 * than reaching a Postgres `time` column and crashing the write. Defined via the
 * hoisted {@link extractClockTime}.
 */
const coerceTime = () =>
  z.preprocess((v: unknown): unknown => {
    if (v == null) return "";
    const s = String(v).trim();
    return s === "" ? "" : (extractClockTime(s) ?? "");
  }, z.string().default(""));

/**
 * An enum cell that tolerates BLANK.
 *
 * `z.enum([...]).default(x)` only fills `undefined`, so an empty string — which
 * is what both the edit-before-approve grid and a model leaving a field blank
 * actually emit — is rejected and the whole row is dropped. Map blank/null to
 * the fallback before validating, exactly as the numeric and boolean coercers
 * already do. Found by the live invoice test: sparse header rows blanked
 * `chargeType` and `documentKind` and every row failed to parse.
 */
const coerceEnum = <T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number]
) =>
  z.preprocess((v: unknown) => {
    if (v == null) return fallback;
    const s = String(v).trim();
    if (s === "") return fallback;
    // Case-insensitive match, so "labor" lands on "Labor" rather than dropping.
    const hit = values.find((o) => o.toLowerCase() === s.toLowerCase());
    return hit ?? v;
  }, z.enum(values));

/** Coerces to a number or null, blank → null. */
const coerceNumberNullable = () =>
  z.preprocess(numericPreprocess(null), z.number().nullable());

/** Coerces number-like strings, but blank/absent stays invalid (field is required). */
const coerceNumberRequired = () =>
  z.preprocess((v: unknown): unknown => {
    if (typeof v === "number") return v;
    if (v == null) return v; // let z.number() reject a missing value
    const s = String(v).trim().replace(/[$,\s]/g, "");
    if (s === "") return undefined; // blank is not a valid amount
    const n = Number(s);
    return Number.isFinite(n) ? n : v;
  }, z.number());

/**
 * Boolean fields must accept the STRINGS the edit-before-approve grid emits.
 * The grid holds every cell as a string, so a boolean like `active` comes back
 * as "true" / "false" (or "yes"/"no", "active"/"inactive", "1"/"0") on approval.
 * The model returns a real boolean on extraction (passed through). Blank/absent
 * → the fallback; an unrecognized value is left as-is so Zod reports it clearly.
 */
const coerceBoolean = (fallback: boolean) =>
  z.preprocess((v: unknown): unknown => {
    if (typeof v === "boolean") return v;
    if (v == null) return fallback;
    const s = String(v).trim().toLowerCase();
    if (s === "") return fallback;
    if (["true", "t", "yes", "y", "1", "active", "on"].includes(s)) return true;
    if (["false", "f", "no", "n", "0", "inactive", "off"].includes(s)) return false;
    return v;
  }, z.boolean());

/** A trailing clock time on a combined timestamp cell — the " 6:20 PM" in
 *  "7/10/2026 6:20 PM" or the "T18:20" in "2026-07-10T18:20". Stripped before
 *  date normalization so the calendar day is decided by string rules, never a
 *  timezone-dependent `Date()` round-trip that could shift it. */
const TRAILING_TIME = /[ T]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?$/;

/**
 * Normalize a date string to ISO `YYYY-MM-DD`. The model — and spreadsheet
 * exports — return dates in whatever the document printed ("05/31/2026",
 * "5-31-26", "2026-05", or a full "7/10/2026 6:20 PM" timestamp) but the write
 * layer (and the statement grouping) require strict ISO. Drops any trailing
 * clock time, handles the common date formats, and falls back to `Date` parsing;
 * leaves an unrecognizable value as-is so the write rejects it loudly rather than
 * guessing wrong.
 */
function normalizeIso(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim().replace(TRAILING_TIME, "").trim();
  if (t === "" || /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const ym = t.match(/^(\d{4})[/-](\d{1,2})$/); // YYYY-MM -> first of month
  if (ym) return `${ym[1]}-${ym[2].padStart(2, "0")}-01`;
  const my = t.match(/^(\d{1,2})[/-](\d{4})$/); // MM/YYYY -> first of month
  if (my) return `${my[2]}-${my[1].padStart(2, "0")}-01`;
  const mdy = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); // M/D/Y
  if (mdy) {
    const yr = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${yr}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  const d = new Date(t); // "May 31, 2026" and similar
  return Number.isNaN(d.getTime()) ? t : d.toISOString().slice(0, 10);
}

/**
 * Pull a clock time out of a string as 24-hour `HH:MM`, or null if none is
 * present / it's out of range. Tries 12-hour (with an AM/PM marker) first so
 * "6:20 PM" reads as 18:20 rather than 06:20, then falls back to a bare 24-hour
 * time.
 */
export function extractClockTime(s: string): string | null {
  // The required colon anchors to a real clock time (dates carry no colons), so
  // no word boundary is needed — it would miss the "T18:05" in an ISO timestamp.
  const m =
    s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])\.?[Mm]\.?/) ??
    s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "p" && h !== 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * For a reading row whose `date` cell also carries a clock time (a single
 * "timestamp" column, common in meter/gauge spreadsheet exports) and whose
 * `time` is blank, lift the time into `time` so it isn't lost — otherwise every
 * same-day reading would collapse onto the `(device, date, "00:00")` unique key.
 * Runs before the row schema parses (which strips the time off `date`). A no-op
 * for rows already split, dated-only, or with a non-string date (Excel serial).
 */
export function liftReadingTime(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const r = row as Record<string, unknown>;
  if (typeof r.date !== "string") return row;
  const timeSet = r.time != null && String(r.time).trim() !== "";
  if (timeSet) return row;
  const time = extractClockTime(r.date);
  return time ? { ...r, time } : row;
}

/** A date field that coerces common formats to ISO `YYYY-MM-DD`. */
const isoDate = () => z.preprocess(normalizeIso, z.string());

/**
 * A run-ticket type that tolerates however the document / grid prints it. The
 * enum is `run` | `transfer` | `disposition`, but statements label the column
 * loosely ("RUN", "Purchase", "P", "XFER", "Disp.", or blank) and the grid hands
 * every cell back as a free string on approval. Map the common wordings; blank
 * or anything unrecognized falls back to `run` (a purchase statement is a sale).
 */
const coerceTicketType = () =>
  z.preprocess((v: unknown): unknown => {
    if (v == null) return "run";
    const s = String(v).trim().toLowerCase();
    if (s.startsWith("transf") || s === "xfer" || s === "move") return "transfer";
    if (s.startsWith("disp")) return "disposition";
    // Everything else on a crude purchase statement is a sale/run — including the
    // document's own ticket codes ("TK", "T", "P", "RUN") and blank. Default to
    // `run` so a meaningless printed code can never block approval of a batch.
    return "run";
  }, z.enum(["run", "transfer", "disposition"]));

/**
 * Provenance the model attaches to every row: the verbatim document phrase the
 * values came from. Shown in the review grid to help the operator verify a row;
 * it is NOT written to the destination table (each write action maps explicit
 * fields, and re-parsing on approve strips it anyway). Optional so older
 * proposals without it still validate.
 */
const sourceText = z.string().optional();

// --- People & organizations ------------------------------------------------

export const contractorRow = z.object({
  name: z.string(),
  company: z.string().default(""),
  trade: z.string().default("").describe('specialty, e.g. "Pumper"'),
  phone: z.string().default(""),
  email: z.string().default(""),
  status: z.enum(["Active", "Inactive"]).default("Active"),
  description: z.string().default(""),
  sourceText,
});

export const serviceProviderRow = z.object({
  company: z.string(),
  service: z.string().default("").describe('e.g. "Trucking", "Wireline"'),
  contact: z.string().default("").describe("primary contact name"),
  phone: z.string().default(""),
  email: z.string().default(""),
  status: z.enum(["Active", "Inactive"]).default("Active"),
  description: z.string().default(""),
  sourceText,
});

export const gathererRow = z.object({
  name: z.string().describe("gatherer / purchaser company name"),
  phone: z.string().default(""),
  email: z.string().default(""),
  status: z.enum(["Active", "Inactive"]).default("Active"),
  description: z.string().default(""),
  sourceText,
});

/** A crude-oil PURCHASER (buyer) — the company that pays the operator for its
 * oil, named on a run/settlement statement, with its contact. Filed to the
 * purchasers directory used by statements and run tickets. */
export const purchaserRow = z.object({
  name: z.string().describe("purchaser / buyer company name"),
  phone: z.string().default("").describe("purchaser phone, if printed"),
  email: z.string().default("").describe("purchaser email, if printed"),
  contactName: z.string().default("").describe("primary contact person, if printed"),
  sourceText,
});

export const royaltyOwnerRow = z.object({
  name: z.string(),
  phone: z.string().default(""),
  email: z.string().default(""),
  mailingAddress: z.string().default(""),
  lastPayment: coerceNumber().describe("last monthly payment, USD"),
  description: z.string().default(""),
  sourceText,
});

export const employeeRow = z.object({
  name: z.string(),
  role: z.string().default("").describe('job title, e.g. "Foreman"'),
  salary: coerceNumber().describe("annual salary, USD"),
  paymentSchedule: z.string().default("").describe('cadence, e.g. "Biweekly"'),
  phone: z.string().default(""),
  email: z.string().default(""),
  status: z.enum(["Active", "Inactive"]).default("Active"),
  description: z.string().default(""),
  sourceText,
});

// --- Leases & interest -----------------------------------------------------

export const leaseRow = z.object({
  leaseNo: z.string().describe("the lease number"),
  name: z.string().default(""),
  county: z.string().default(""),
  active: coerceBoolean(true),
  sourceText,
});

export const leaseInterestRow = z.object({
  leaseRef: z.string().describe("lease name or number as printed"),
  ownerName: z
    .string()
    .default("")
    .describe(
      "holder name: a royalty owner, or one of the org's own companies; blank for the operator's own interest"
    ),
  isOperator: coerceBoolean(false),
  interestType: z.enum(["WI", "RI", "ORRI", "NPRI"]).default("WI"),
  workingInterest: coerceNumber().describe("fraction 0-1 (12.5% = 0.125)"),
  netRevenueInterest: coerceNumber().describe("fraction 0-1"),
  sourceText,
});

export const leaseUseGasRow = z.object({
  month: z.string().describe("ISO YYYY-MM"),
  leaseUseMcf: coerceNumber().describe("gas consumed on the lease, MCF"),
  sourceText,
});

// --- Wells (entities) ------------------------------------------------------

export const wellRow = z.object({
  name: z.string(),
  formation: z.string().default(""),
  county: z.string().default(""),
  depth: coerceNumber().describe("total depth, feet"),
  perforations: z.string().default(""),
  dateDrilled: coerceDateOptional().describe("ISO YYYY-MM-DD, or blank"),
  coordinates: z.string().default(""),
  sourceText,
});

export const injectionWellRow = z.object({
  name: z.string(),
  sourceText,
});

// --- Well data -------------------------------------------------------------

/** Mirrors the production extractor's `readingSchema` (oil in BARRELS). */
export const productionRow = z.object({
  date: coerceDate().describe("ISO YYYY-MM-DD"),
  time: coerceTime().describe("HH:MM 24-hour, or blank"),
  oilProduction: coerceNumberNullable().describe("barrels"),
  oilStock: coerceNumberNullable().describe("barrels"),
  oilSales: coerceNumberNullable().describe("barrels"),
  gasProduction: coerceNumberNullable().describe("MCF"),
  saltWater: coerceNumberNullable().describe("barrels"),
  // Richer daily gas-measurement fields (GBC-7). All nullable: a doc that does
  // not report them leaves them blank rather than 0.
  orifice: coerceNumberNullable().describe("orifice plate size, inches"),
  differential: coerceNumberNullable().describe('differential, "H2O'),
  chm: coerceNumberNullable().describe("chart multiplier / hourly reading"),
  casingPressure: coerceNumberNullable().describe("psi"),
  tubingPressure: coerceNumberNullable().describe("psi"),
  flowPressure: coerceNumberNullable().describe("psi"),
  choke: coerceNumberNullable().describe("choke size, 64ths"),
  remarks: z.string().default(""),
  sourceText,
});

export const wellEquipmentRow = z.object({
  label: z.string().describe('field name, e.g. "Tbg Pump"'),
  value: z.string().default(""),
  sourceText,
});

/** A dated job/service event performed on a well (repair, test, workover, etc.). */
export const serviceRow = z.object({
  date: z
    .string()
    .default("")
    .describe('ISO YYYY-MM-DD (normalize e.g. "2-7-25"); "" if not stated'),
  job: z.string().describe('what was done, e.g. "Acid Job", "Pump Repair"'),
  vendor: z.string().default("").describe("who performed it"),
  cost: coerceNumberNullable().describe("USD, null if not stated"),
  notes: z.string().default("").describe("ticket/invoice number, results"),
  sourceText,
});

/** A downtime / shut-in period on a well (reduces online days in allocation). */
export const downtimeRow = z.object({
  eventType: z.enum(["downtime", "shut_in"]).default("downtime"),
  startDate: coerceDate().describe("ISO YYYY-MM-DD the well went offline"),
  endDate: coerceDateOptional().describe(
    "ISO YYYY-MM-DD it came back; blank if still down"
  ),
  daysApplied: coerceNumberNullable().describe("days offline; blank = derive from dates"),
  reason: z.string().default("").describe('e.g. "pump failure", "compressor down"'),
  sourceText,
});

/** A dated well test (rate check) feeding the weighted allocation method. */
export const wellTestRow = z.object({
  testDate: coerceDate().describe("ISO YYYY-MM-DD"),
  durationDays: coerceNumberNullable().describe("test length in days; blank = 1"),
  oilBbls: coerceNumberNullable().describe("oil over the test, barrels"),
  gasMcf: coerceNumberNullable().describe("gas over the test, MCF"),
  waterBbls: coerceNumberNullable().describe("water over the test, barrels"),
  preTestShutInDays: coerceNumberNullable().describe("days shut-in before the test"),
  notes: z.string().default(""),
  sourceText,
});

/**
 * A FLUID-LEVEL SHOT: an acoustic / sonolog / Echometer shot fired down the
 * annulus to find how far below surface the fluid column stands. Both depths are
 * feet from surface and both are optional — the sheet may print only one, and
 * "fluid over pump" (pump depth − fluid level) is derived on read, never stored.
 */
export const shotRow = z.object({
  date: coerceDate().describe("ISO YYYY-MM-DD the shot was fired"),
  time: coerceTime().describe("HH:MM the shot was fired, or blank"),
  fluidLevelFt: coerceNumberNullable().describe(
    "depth from surface to the TOP OF THE FLUID column, FEET"
  ),
  pumpDepthFt: coerceNumberNullable().describe(
    "pump setting depth at the time of the shot, FEET"
  ),
  notes: z.string().default(""),
  sourceText,
});

/**
 * A written NOTE filed against the well: a pumper's memo, a letter, a field
 * observation — prose the operator wants kept, which no structured destination
 * holds. `body` is plain text; the writer wraps it into the HTML the notes
 * editor round-trips.
 */
export const wellNoteRow = z.object({
  title: looseString().describe(
    "a short subject line; blank means derive one from the first line of the body"
  ),
  date: coerceDateOptional().describe("ISO YYYY-MM-DD the note is dated, or blank"),
  body: z.string().describe("the note's full text, as written"),
  sourceText,
});

/**
 * This well's shut-in reading on a gas meter's OPEN test campaign.
 *
 * A gas meter reads one commingled total, so a well's share is the DROP when it
 * alone is shut in, measured against the campaign's all-wells-online baseline.
 * The baseline belongs to the meter and is recorded on the meter page; a
 * well-page document only ever contributes this one reading. The rate is either
 * printed directly (`mcfPerDay`) or derived from an open/close meter reading
 * over the window, exactly as the well page's Gas test modal does.
 */
export const gasTestRow = z.object({
  meterRef: looseString().describe(
    "gas meter name or number as printed; blank when the sheet names none and the well feeds only one gas meter"
  ),
  startDate: coerceDate().describe("ISO YYYY-MM-DD the shut-in window opened"),
  startTime: coerceTime().describe("HH:MM, or blank (treated as 00:00)"),
  endDate: coerceDate().describe("ISO YYYY-MM-DD the shut-in window closed"),
  endTime: coerceTime().describe("HH:MM, or blank (treated as 00:00)"),
  mcfPerDay: coerceNumberNullable().describe(
    "the meter's rate over the window with this well shut in, MCF PER DAY"
  ),
  openReading: coerceNumberNullable().describe(
    "meter reading at the START of the window; used with closeReading to derive the rate when one is not printed"
  ),
  closeReading: coerceNumberNullable().describe(
    "meter reading at the END of the window"
  ),
  notes: z.string().default(""),
  sourceText,
});

// --- Tanks -----------------------------------------------------------------

export const tankRow = z.object({
  name: z.string(),
  product: z.enum(["oil", "water"]).default("oil"),
  tankNo: z.string().default("").describe("printed tank number"),
  // A tank has no stored name of its own: it is NAMED after its lease plus its
  // number ("Roach T123", `tankDisplayName`). A tank created without one is
  // therefore a tank the operator cannot find by name, so the lease is carried
  // here from whatever named it — a statement line, a fleet sheet — and
  // resolved to a real lease at write time (`matchLease`, number then name).
  lease: z
    .string()
    .default("")
    .describe("lease name or number the tank sits on, as printed"),
  battery: z.string().default("").describe("battery name, if any"),
  gatherer: z.string().default("").describe("gatherer / purchaser name"),
  bblPerInch: coerceNumber().describe("strapping factor (barrels per gauge inch)"),
  capacityBbls: coerceNumberNullable().describe("capacity, barrels"),
  active: coerceBoolean(true),
  sourceText,
});

/**
 * A gauge reading on a TANK. `tankRef` is the tank's printed identifier
 * (number, else name), resolved to a real tank at write time. Oil barrels are
 * derived from the tank's strapping on write — do NOT compute them here.
 */
export const tankReadingRow = z.object({
  tankRef: looseString().describe("tank number or name as printed"),
  date: coerceDate().describe("ISO YYYY-MM-DD"),
  time: coerceTime().describe("HH:MM, or blank"),
  gauge: coerceNumber().describe("top gauge, inches"),
  pulledBottom: coerceNumberNullable().describe("barrels"),
  waterHauled: coerceNumberNullable().describe("barrels"),
  hotOil: coerceNumberNullable().describe("barrels"),
  sourceText,
});

/**
 * A run ticket: oil leaving a TANK. `tankRef` is the tank's printed identifier
 * (its tank number, or failing that its name) — resolved to a real tank at write
 * time, since a document rarely names the Wildcat well.
 */
export const runTicketRow = z.object({
  tankRef: looseString().describe("tank number or name as printed on the ticket"),
  date: coerceDate().describe("ISO YYYY-MM-DD"),
  departureTime: looseString().describe("haul departure time HH:MM, or blank"),
  ticketNo: looseString().describe("run/ticket number"),
  ticketType: coerceTicketType(),
  grossBbls: coerceNumber().describe("gross barrels off the ticket"),
  netBbls: coerceNumberNullable().describe(
    "net (CORRECTED) barrels as printed, after BS&W + temperature; blank = gross. Never compute it"
  ),
  apiGravity: coerceNumberNullable().describe(
    "API gravity in DEGREES (crude is usually 20-50); blank if not printed"
  ),
  bsW: coerceNumberNullable().describe(
    "BS&W as a PERCENT number ('1.2%' -> 1.2, a printed fraction '0.012' -> 1.2); blank if not printed"
  ),
  openingGauge: coerceNumberNullable().describe(
    "opening (pre-haul) gauge in inches — the HIGHER level, before oil was removed"
  ),
  closingGauge: coerceNumberNullable().describe(
    "closing (post-haul) gauge in inches — the LOWER level, after oil was removed; must be <= openingGauge"
  ),
  purchaser: looseString().describe("hauler / buyer name"),
  transporter: looseString().describe(
    "trucking / transport company that hauled the load, when named separately from the buyer"
  ),
  product: z.enum(["oil", "water"]).default("oil"),
  sourceText,
});

export const batteryRow = z.object({
  name: z.string(),
  active: coerceBoolean(true),
  sourceText,
});

// --- Meters & gas ----------------------------------------------------------

export const meterRow = z.object({
  name: z.string(),
  meterNo: z.string().default("").describe("printed meter number"),
  // Same rule as `tankRow.lease`: a meter is named after its lease and its
  // number ("Dofflemeyer M1234"), so the lease travels with the meter.
  lease: z
    .string()
    .default("")
    .describe("lease name or number the meter sits on, as printed"),
  gatherer: z.string().default("").describe("gatherer / purchaser name"),
  active: coerceBoolean(true),
  sourceText,
});

/**
 * The pumper's gas reading on a METER. `meterRef` resolved at write.
 *
 * Three independent numbers, the three a meter face shows. `mcf` is the current
 * flow rate; `yesterdayMcf` is the previous day's volume the meter itself
 * totalled; `cumulativeMcf` is the running counter. A gas sheet often carries
 * all three in their own columns. Never compute one from another when reading a
 * document: report only what the page says, and leave the rest null.
 */
export const meterReadingRow = z.object({
  meterRef: z.string().default("").describe("meter number or name as printed"),
  date: coerceDate().describe("ISO YYYY-MM-DD"),
  time: coerceTime().describe("HH:MM, or blank"),
  mcf: coerceNumberNullable().describe(
    "the CURRENT FLOW RATE in MCF/day (often headed 'rate', 'flow' or 'MCF/D'), or null if the sheet does not print one"
  ),
  yesterdayMcf: coerceNumberNullable().describe(
    "the PREVIOUS DAY'S volume in MCF as totalled by the meter (often headed 'yesterday', 'prev day' or 'yest vol'), or null if the sheet does not print one. NEVER derive this from the flow rate or the counter."
  ),
  cumulativeMcf: coerceNumberNullable().describe(
    "the cumulative/running total printed on the meter (often headed 'meter reading', 'index' or 'cumulative'), or null if the sheet does not print one. NEVER derive this from the other two."
  ),
  sourceText,
});

/**
 * A gatherer's gas volume settlement for a METER. `meterRef` is the meter's
 * printed number/name, resolved to a real meter at write time. DOCUMENTATION
 * only — never feeds production math.
 */
export const meterVolumeRow = z.object({
  meterRef: z
    .string()
    .default("")
    .describe("meter number or name as printed on the statement"),
  date: coerceDate().describe("ISO YYYY-MM-DD (statement/period-end date)"),
  statementNo: z.string().default(""),
  purchaser: z.string().default("").describe("gatherer / purchaser name"),
  volumeMcf: coerceNumber().describe("sales volume, MCF"),
  mmbtu: coerceNumberNullable().describe("energy, MMBtu"),
  value: coerceNumberNullable().describe("net value, USD"),
  sourceText,
});

// --- Disposal --------------------------------------------------------------

/** A reading on a disposal / SWD (injection) well. Well resolved via the modal. */
export const disposalReadingRow = z.object({
  date: coerceDate().describe("ISO YYYY-MM-DD"),
  time: coerceTime().describe("HH:MM, or blank"),
  injectedBbls: coerceNumber().describe("water injected, barrels"),
  injectionPressure: coerceNumberNullable().describe("psi"),
  casingPressure: coerceNumberNullable().describe("psi"),
  meterReading: coerceNumberNullable().describe("meter reading, barrels"),
  sourceWellRef: z.string().default("").describe("source producing well, if stated"),
  notes: z.string().default(""),
  sourceText,
});

// --- Accounting & inventory ------------------------------------------------

/** Mirrors the accounting extractor's `txnSchema` (DraftTransaction). */
export const transactionRow = z.object({
  kind: z.enum(["revenue", "expense"]),
  counterparty: z.string().default(""),
  amount: coerceNumberRequired(),
  date: isoDate().describe("ISO YYYY-MM-DD"),
  category: z.string().default(""),
  categoryCode: z.string().default(""),
  invoiceNumber: z.string().default(""),
  wellId: z.string().default(""),
  volume: coerceNumberNullable(),
  price: coerceNumberNullable(),
  prodTax: coerceNumberNullable(),
  nri: coerceNumberNullable(),
  sourceText,
});

export const inventoryRow = z.object({
  name: z.string().describe("item description"),
  category: z.string().default(""),
  quantity: coerceNumber(),
  unit: z.string().default("").describe('unit of measure, e.g. "ft"'),
  location: z.string().default(""),
  unitCost: coerceNumber().describe("cost per unit, USD"),
  status: z.enum(["In Stock", "Low", "On Order"]).default("In Stock"),
  description: z.string().default(""),
  sourceText,
});

// --- Dedicated documents ---------------------------------------------------

/**
 * One RUN off a crude-oil purchaser RUN / SETTLEMENT statement. The grid holds
 * one row per run; several runs for the same tank in a period are expected. The
 * lease + purchaser + statement fields repeat on every row (they are header
 * facts) so the write layer can fold the flat rows back into ONE statement per
 * lease. `bbls` is the settled NET barrels; `net` is what the purchaser paid on
 * this run.
 */
export const oilRunStatementRow = z.object({
  runDate: isoDate()
    .default("")
    .describe("ISO YYYY-MM-DD of this individual run/haul; blank if only a statement date is printed"),
  leaseName: z
    .string()
    .default("")
    .describe("lease / property name or number exactly as printed"),
  tankMeter: z
    .string()
    .default("")
    .describe("tank or meter number as printed on the run"),
  ticketNo: z
    .string()
    .default("")
    .describe("run / ticket number for this haul, from the run-table row"),
  ticketType: coerceTicketType().describe(
    "our system's type — use 'run' (a purchase statement is a sale); do NOT copy the document's own code (e.g. 'TK')"
  ),
  transporter: z
    .string()
    .default("")
    .describe("hauler / transporter that moved the oil"),
  gravity: coerceNumberNullable().describe(
    "API gravity in degrees for this run, if the statement prints it"
  ),
  bbls: coerceNumber().describe("net barrels on this run"),
  pricePerBbl: coerceNumberNullable().describe("realized price, USD per barrel"),
  // Money is nullable: many statements print a run's BARRELS but settle dollars
  // per lease, not per run. Absent → blank (null), never a misleading 0.
  gross: coerceNumberNullable().describe("gross value, USD (blank if not printed per run)"),
  taxes: coerceNumberNullable().describe("severance / production taxes, USD (blank if not per run)"),
  net: coerceNumberNullable().describe("net value paid on this run, USD (blank if not per run)"),
  // Whole-lease settlement totals: filled ONLY when the statement prints money
  // per LEASE, not per run. Repeated on every run row of the lease (header
  // facts). The write layer splits them across the lease's runs by barrels — the
  // model must NOT do that math. Left null when each run already carries its own.
  leaseGross: coerceNumberNullable().describe("whole-lease gross total, USD — only when money is printed per lease, not per run"),
  leaseTaxes: coerceNumberNullable().describe("whole-lease taxes total, USD — only when printed per lease, not per run"),
  leaseNet: coerceNumberNullable().describe("whole-lease net total, USD — only when printed per lease, not per run"),
  purchaser: z.string().default("").describe("purchaser / buyer company name"),
  purchaserPhone: z.string().default("").describe("purchaser phone, if printed"),
  purchaserEmail: z.string().default("").describe("purchaser email, if printed"),
  statementNo: z
    .string()
    .default("")
    .describe("statement / check / settlement number, if printed"),
  statementDate: isoDate()
    .default("")
    .describe("ISO YYYY-MM-DD of the statement / settlement"),
  sourceText,
});
export type OilRunStatementRow = z.infer<typeof oilRunStatementRow>;

/**
 * One meter's settlement off a natural-gas purchaser/plant SETTLEMENT statement
 * (commonly a POP statement). Usually one row per statement; a statement
 * covering several meters yields one row per meter. The money is the SETTLE
 * (producer-share) figures: residue gas value + plant-products (NGL) value −
 * fees = the net producer payment. Volumes are the gross wellhead and the
 * residue-sold quantities. All money/volume figures are nullable — a statement
 * may not print every one.
 */
export const gasSettlementStatementRow = z.object({
  statementDate: isoDate()
    .default("")
    .describe("ISO YYYY-MM-DD of the production / accounting period"),
  statementNo: z
    .string()
    .default("")
    .describe("statement / contract number, if printed"),
  meterRef: z
    .string()
    .default("")
    .describe("the meter number the gatherer uses, as printed"),
  meterName: z.string().default("").describe("meter / well name as printed"),
  leaseName: z
    .string()
    .default("")
    .describe("lease / property the meter is on, exactly as printed"),
  gatherer: z.string().default("").describe("gatherer / purchaser company name"),
  gathererPhone: z.string().default("").describe("gatherer phone, if printed"),
  gathererEmail: z.string().default("").describe("gatherer email, if printed"),
  contractType: z
    .string()
    .default("")
    .describe("contract type as printed, e.g. 'POP - Actual Recovery'"),
  producerPct: coerceNumberNullable().describe("producer share percent (85, not 85%)"),
  grossMcf: coerceNumberNullable().describe("gross wellhead gas, MCF"),
  grossMmbtu: coerceNumberNullable().describe("gross wellhead energy, MMBtu"),
  residueMcf: coerceNumberNullable().describe("residue gas sold (producer share), MCF"),
  residueMmbtu: coerceNumberNullable().describe("residue gas settle quantity, MMBtu"),
  residuePrice: coerceNumberNullable().describe("residue price, USD per MMBtu"),
  residueValue: coerceNumberNullable().describe("residue gas value, USD"),
  nglValue: coerceNumberNullable().describe("plant products (NGL) total value, USD"),
  fees: coerceNumberNullable().describe("plant fees / deducts, USD"),
  netValue: coerceNumberNullable().describe("total producer payment (net), USD"),
  sourceText,
});
export type GasSettlementStatementRow = z.infer<typeof gasSettlementStatementRow>;

/**
 * One CHARGE LINE off a vendor invoice or signed field ticket.
 *
 * Flat, one row per line, with the header facts (vendor, invoice number, date,
 * property, totals) repeated on every row — the same shape as
 * `oilRunStatementRow`, and for the same reason: the data-entry grid is flat, and
 * `groupInvoices` folds the repeats back into one document with N lines. The
 * model must never do that folding itself.
 *
 * Money is nullable throughout. Plenty of real lines print a quantity and a rate
 * with no extended amount, or read "No Charge" where a price belongs, and a 0
 * there would be a lie the write layer cannot distinguish from a real zero.
 */
/**
 * PIDX's four charge buckets, and the trade words that map onto each.
 *
 * The model reaches for the DESCRIPTIVE word — "Disposal", "Mileage",
 * "Standby", "Service" — because the invoice prints that and because the schema
 * offers a `chargeSubtype` right next door. Rejecting those cost whole invoices:
 * one unrecognized word failed the row, and enough failed rows made the upload
 * look empty. So the word is mapped where the mapping is obvious and preserved
 * as the subtype either way.
 */
const CHARGE_TYPE_ALIASES: Record<string, "Labor" | "Materials" | "Equipment" | "Other"> = {
  labor: "Labor", labour: "Labor", crew: "Labor", hours: "Labor", service: "Labor",
  work: "Labor", operator: "Labor", hand: "Labor",
  materials: "Materials", material: "Materials", parts: "Materials",
  supplies: "Materials", consumables: "Materials", chemical: "Materials",
  chemicals: "Materials", cement: "Materials",
  equipment: "Equipment", rental: "Equipment", rentals: "Equipment",
  unit: "Equipment", truck: "Equipment", tools: "Equipment", pump: "Equipment",
};

/**
 * Normalize a charge line before its fields are validated.
 *
 * Keeps the vendor's own word for the charge (in `chargeSubtype`, where it
 * belongs) while forcing `chargeType` into the four-value bucket the write layer
 * and the Texas materials-versus-labor split depend on. An unmappable word
 * becomes `Other`, which is honest — not every charge is one of the four.
 */
function normalizeChargeLine(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const row = { ...(v as Record<string, unknown>) };
  const raw = String(row.chargeType ?? "").trim();
  if (raw === "") return row;

  const exact = ["Labor", "Materials", "Equipment", "Other"].find(
    (o) => o.toLowerCase() === raw.toLowerCase()
  );
  if (exact) {
    row.chargeType = exact;
    return row;
  }
  // An unrecognized word is the vendor's own terminology: keep it as the
  // subtype (unless one is already set) and bucket the type.
  if (!String(row.chargeSubtype ?? "").trim()) row.chargeSubtype = raw;
  row.chargeType = CHARGE_TYPE_ALIASES[raw.toLowerCase()] ?? "Other";
  return row;
}

export const vendorInvoiceRow = z.preprocess(normalizeChargeLine, z.object({
  // --- header facts, repeated on every line of the same invoice -------------
  vendor: z
    .string()
    .default("")
    .describe("vendor / service company name exactly as printed on the invoice"),
  invoiceNo: z
    .string()
    .default("")
    .describe(
      "the vendor's own invoice number as printed; blank if the document carries none (a daily job description often does not)"
    ),
  invoiceDate: isoDate()
    .default("")
    .describe("ISO YYYY-MM-DD of the invoice or ticket date"),
  dueDate: isoDate()
    .default("")
    .describe("ISO YYYY-MM-DD payment due date, if the invoice states one"),
  paymentTerms: z
    .string()
    .default("")
    .describe("payment terms as printed, e.g. 'Net 30', 'Due on receipt'"),
  documentKind: z
    .preprocess((v) => {
      const t = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (t === "") return "invoice";
      return /ticket/.test(t) ? "field_ticket" : "invoice";
    }, z.enum(["invoice", "field_ticket"]))
    .describe(
      "'field_ticket' only when the document IS a field/service ticket signed in the field; anything billing an amount owed is 'invoice'"
    ),
  // --- the property the work was done on ------------------------------------
  propertyRef: z
    .string()
    .default("")
    .describe(
      "the lease / well / battery the work was performed on, VERBATIM as printed (e.g. 'Repass #2', 'Sky Resources - Brown #1'); do not normalize or guess an id"
    ),
  county: z.string().default("").describe("county as printed, if any"),
  rrcDistrict: z
    .string()
    .default("")
    .describe("Texas RRC district as printed, e.g. '7B'; blank if absent"),
  // --- the line itself ------------------------------------------------------
  lineNo: z
    .string()
    .default("")
    .describe("line number as printed; blank if the invoice does not number lines"),
  description: z
    .string()
    .default("")
    .describe(
      "the charge description VERBATIM, including sizes, depths and intervals — the wording carries tax consequence and must not be paraphrased"
    ),
  chargeType: coerceEnum(
    ["Labor", "Materials", "Equipment", "Other"] as const,
    "Other"
  ).describe(
      "which of the four the line is; 'Other' when genuinely none fit (mileage, surcharge, standby)"
    ),
  chargeSubtype: z
    .string()
    .default("")
    .describe(
      "the operator's own words for the charge kind when chargeType is too coarse: mileage, fuel surcharge, rental, standby, consumables"
    ),
  quantity: coerceNumberNullable().describe("quantity billed on this line"),
  uom: z.string().default("").describe("unit of measure as printed (hr, ea, bbl, ft, mile)"),
  unitPrice: coerceNumberNullable().describe(
    "rate per unit, USD; blank when the line prints no rate or reads 'No Charge'"
  ),
  noCharge: coerceBoolean(false).describe(
    "true only when the line explicitly reads 'No Charge' / 'N/C' where a price belongs"
  ),
  amount: coerceNumberNullable().describe("extended amount for this line, USD"),
  serviceStart: isoDate()
    .default("")
    .describe("ISO YYYY-MM-DD the work on this line started"),
  serviceEnd: isoDate()
    .default("")
    .describe("ISO YYYY-MM-DD the work on this line ended; blank if a single day"),
  // The trailing "T" so many invoices print in a taxable column. A FLAG, never
  // an amount: the document states which lines are taxable and then prints ONE
  // tax total at the bottom, so a per-line tax amount would be invented.
  taxable: coerceEnum(["yes", "no", "unknown"] as const, "unknown").describe(
      "'yes' when the line carries a taxable marker (a trailing T, an X in a Tax column), 'no' when explicitly marked non-taxable, 'unknown' when the invoice does not say"
    ),
  taxFlagRaw: z
    .string()
    .default("")
    .describe("the taxable marker exactly as printed ('T', 'Y', '*'), if any"),
  // --- references, repeated per line because they legitimately vary by line --
  afeNumber: z.string().default("").describe("AFE number for this line, if printed"),
  costCenter: z.string().default("").describe("cost center for this line, if printed"),
  glCode: z.string().default("").describe("operator GL / account code, if printed"),
  ticketNo: z
    .string()
    .default("")
    .describe("field ticket number backing this line, if printed"),
  workOrderNo: z.string().default("").describe("work order / job number, if printed"),
  poNumber: z.string().default("").describe("purchase order number, if printed"),
  // --- document totals, repeated on every row -------------------------------
  subtotal: coerceNumberNullable().describe("invoice subtotal before tax, USD"),
  // What the vendor PRINTED as tax, plus its printed label. Both matter: GLOC
  // and Quasar label the Texas Chapter 191 well-servicing tax "Sales Tax", and
  // recording the label lets the mismatch be found instead of normalized away.
  taxPrinted: coerceNumberNullable().describe("total tax as printed on the invoice, USD"),
  taxLabelRaw: z
    .string()
    .default("")
    .describe(
      "the tax line's label exactly as printed, e.g. 'Sales Tax (2.42%)' — copy it verbatim even if it looks wrong"
    ),
  invoiceTotal: coerceNumberNullable().describe("invoice grand total, USD"),
  sourceText,
}));
export type VendorInvoiceRow = z.infer<typeof vendorInvoiceRow>;

/** The row schema for each ingest type. */
export const INGEST_ROW_SCHEMA: Record<IngestType, z.ZodTypeAny> = {
  contractors: contractorRow,
  serviceProviders: serviceProviderRow,
  gatherers: gathererRow,
  purchasers: purchaserRow,
  royaltyOwners: royaltyOwnerRow,
  employees: employeeRow,
  leases: leaseRow,
  leaseInterest: leaseInterestRow,
  leaseUseGas: leaseUseGasRow,
  wells: wellRow,
  injectionWells: injectionWellRow,
  production: productionRow,
  wellEquipment: wellEquipmentRow,
  service: serviceRow,
  downtime: downtimeRow,
  wellTests: wellTestRow,
  shots: shotRow,
  wellNotes: wellNoteRow,
  gasTests: gasTestRow,
  tanks: tankRow,
  tankReadings: tankReadingRow,
  runTickets: runTicketRow,
  batteries: batteryRow,
  meters: meterRow,
  meterReadings: meterReadingRow,
  meterVolumes: meterVolumeRow,
  disposalReadings: disposalReadingRow,
  transactions: transactionRow,
  inventory: inventoryRow,
  oilRunStatement: oilRunStatementRow,
  gasSettlementStatement: gasSettlementStatementRow,
  vendorInvoice: vendorInvoiceRow,
};

/** Every ingest type as a literal, for the triage enum. */
const INGEST_TYPE_LITERALS = [
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
] as const;

/**
 * Phase 1 triage output: a fast, cheap pass that only decides whether the
 * document is worth a detailed extraction and of which types — no rows yet. The
 * `wellNames` it captures (printed verbatim in the doc) drive the strict
 * well-name match in phase 2.
 */
export const TriageSchema = z.object({
  reasoning: z.string().describe("1-2 sentences: what is this document?"),
  hasData: z.boolean().describe("does it contain any addable records?"),
  types: z
    .array(z.enum(INGEST_TYPE_LITERALS))
    .describe("the record types present in the document"),
  wellNames: z
    .array(z.string())
    .describe("well names printed VERBATIM in the document (empty if none)"),
});

export type TriageResult = z.infer<typeof TriageSchema>;
