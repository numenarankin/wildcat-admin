/**
 * Canonical dedup keys, shared by BOTH the write step (`dispatchWrite`,
 * `writeOilRunStatements`, `writeGasSettlements`) and the scan-time suppression
 * pass (`suppress.ts`). Keeping the key builders in one pure module is the whole
 * point: the two paths must agree on what "already on file" means, or a row the
 * modal shows would slip past the writer (or worse, a row the suppressor drops
 * would not actually be a duplicate). Pure — no I/O — so it unit-tests trivially.
 *
 * Canonicalization collapses cosmetic variants: "Tank No. 7" == "Tank #7" == "tank 7".
 */

import { canonical, canonicalId } from "@/lib/ai/ingest/normalize";

// --- Directory / entity identity ------------------------------------------

/** Contractor: name + phone (two contractors can share a name). */
export const contractorKey = (name: string, phone: string): string =>
  `${canonical(name)}|${canonical(phone)}`;
/** Service provider: company name. */
export const providerKey = (company: string): string => canonical(company);
/** A plain name identity — gatherers, purchasers, employees, royalty owners,
 *  wells, batteries all dedup on the canonical name alone. */
export const nameKey = (name: string): string => canonical(name);
/** Inventory item: name + location. */
export const inventoryKey = (name: string, location: string): string =>
  `${canonical(name)}|${canonical(location)}`;
/** A tank / meter: its printed number if any, else its name (matches the write
 *  step's `tankNo ? canonicalId(tankNo) : canonical(name)`). */
export const deviceKey = (name: string, no: string | null | undefined): string =>
  no ? canonicalId(no) : canonical(name);

// --- Transactional / time-series identity ---------------------------------

/** Transaction: only meaningful for rows that carry an invoice number. */
export const txnKey = (invoice: string, amount: number, date: string): string =>
  `${canonical(invoice)}|${amount}|${date}`;

/**
 * Normalize a reading time to canonical `HH:MM` the way Postgres stores it, so
 * dedup keys match regardless of the source's formatting ("8:34", "08:34",
 * "08:34:00" all → "08:34"). Blank → "00:00", matching the write path's default.
 */
export function normHhmm(time: string | null | undefined): string {
  const [h, m] = String(time ?? "").split(":");
  if (!h) return "00:00";
  return `${h.padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`;
}

/** Tank/meter reading: date + clock time (scoped to a device id externally). */
export const readingKey = (date: string, time: string | null | undefined): string =>
  `${date}|${normHhmm(time)}`;

/** Well test: the test date (scoped to a well id externally; DB is unique on
 *  well_id + test_date). */
export const wellTestKey = (testDate: string): string => testDate;

/** Downtime / shut-in event: start + end + type (scoped to a well id). */
export const downtimeKey = (
  startDate: string,
  endDate: string | null | undefined,
  eventType: string
): string => `${startDate}|${endDate ?? ""}|${canonical(eventType)}`;

/** Well service event: date + job (scoped to a well id). */
export const serviceKey = (date: string, job: string): string =>
  `${date}|${canonical(job)}`;

/**
 * Fluid-level shot: date + clock time + the level read (scoped to a well id).
 *
 * `well_shots` has NO unique constraint, so this key is the only identity a shot
 * has. The fluid level is part of it deliberately: two shots can legitimately be
 * fired on the same day with no time recorded — before and after a pump change —
 * and keying on the date alone would suppress the second as a duplicate. Two
 * readings of the same level on the same day are the same shot; two different
 * levels are two shots.
 */
export const shotKey = (
  date: string,
  time: string | null | undefined,
  fluidLevelFt: number | null | undefined
): string => `${date}|${normHhmm(time)}|${fluidLevelFt ?? ""}`;

/**
 * A note filed against a well: its title plus its body text. Notes have no
 * natural key at all, so identity is the content itself — re-uploading the same
 * memo must not file it twice, while an edited memo is legitimately a new note.
 */
export const noteKey = (title: string, body: string): string =>
  `${canonical(title)}|${canonical(body)}`;

/**
 * A gas shut-in reading: the meter it was read on + the window's start (scoped
 * to a well id). Used for INTRA-BATCH dedup only — `recordWellGasShutIn`
 * replaces this well's existing reading on a campaign rather than appending, so
 * there is nothing to suppress against the database (see `suppress.ts`).
 */
export const gasTestKey = (meterRef: string, startAt: string): string =>
  `${canonical(meterRef)}|${startAt}`;

/** Well equipment fact: label + value (scoped to a well id). */
export const equipmentKey = (label: string, value: string): string =>
  `${canonical(label)}|${canonical(value)}`;

/** Meter volume settlement: date + purchaser (scoped to a meter id). Mirrors the
 *  gas-settlement `settleKey` grain. */
export const meterVolumeKey = (date: string, purchaser: string): string =>
  `${date}|${canonical(purchaser)}`;

/**
 * Run ticket: ticket number + date (scoped to a tank id externally). The
 * `run_tickets` table has NO unique constraint, so this key is the only row
 * identity a ticket has — it is what lets a re-uploaded run statement skip the
 * hauls it already filed instead of silently doubling the barrels feeding the
 * tank-level series. A ticket with no printed number falls back to date + the
 * effective net barrels (`netBbls ?? grossBbls`, rounded to hundredths): two
 * legitimate same-day hauls almost never share net barrels to the hundredth,
 * while a genuinely identical pair is a true duplicate. The `n|`/`d|` prefixes
 * keep the two forms from ever colliding.
 */
export const runTicketKey = (
  ticketNo: string | null | undefined,
  date: string,
  effectiveBbls: number | null | undefined
): string => {
  const no = ticketNo ? canonicalId(ticketNo) : "";
  if (no) return `n|${no}|${date}`;
  const bbls = effectiveBbls == null ? "" : effectiveBbls.toFixed(2);
  return `d|${date}|${bbls}`;
};

// --- Statement identity (used by the dedicated writers) -------------------

/** A revenue statement: purchaser + statement number, or purchaser + period
 *  when the document prints no number. One key per document. */
export const stmtKey = (
  purchaser: string,
  no: string,
  start: string,
  end: string
): string =>
  no.trim()
    ? `${canonical(purchaser)}|${canonicalId(no)}`
    : `${canonical(purchaser)}|${start}|${end}`;

/** A per-meter gas settlement on a meter's Settlements tab: date + gatherer. */
export const settleKey = (date: string, gatherer: string): string =>
  `${date}|${canonical(gatherer)}`;
