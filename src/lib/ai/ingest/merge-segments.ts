import "server-only";

import type { IngestType } from "@/lib/ai/ingest/types";
import type { ProposalDraft } from "@/lib/ai/ingest/scan";
import type { Segment } from "@/lib/ai/ingest/segments";
import {
  downtimeKey,
  equipmentKey,
  gasTestKey,
  meterVolumeKey,
  noteKey,
  readingKey,
  serviceKey,
  shotKey,
  txnKey,
  wellTestKey,
} from "@/lib/ai/ingest/dedup-keys";
import { canonical } from "@/lib/ai/ingest/normalize";
import { ilog } from "@/lib/ai/ingest/log";

/**
 * Fold per-segment extraction results back into one draft per destination.
 *
 * Segmentation introduces a duplicate-record failure mode that did not exist
 * when the pipeline read the whole file at once, and nothing else in the
 * pipeline catches it:
 *
 *  - N segments each producing `wellTests` rows would become N separate
 *    `ProposalDraft`s, which `insertIngestProposals` writes as N rows and the
 *    approval modal renders as N cards for one document;
 *  - a form that spans a page break and gets split across two segments proposes
 *    the SAME record twice.
 *
 * `suppressExistingRows` only compares drafts against rows already in the
 * database — there is no intra-batch dedup anywhere else — so both are handled
 * here, before `finalizeDrafts`.
 */

/** One type's rows from one segment, with the pages they came from. */
export interface SegmentResult {
  segment: Segment;
  type: IngestType;
  rows: unknown[];
}

type Row = Record<string, unknown>;

const str = (row: Row, key: string): string =>
  typeof row[key] === "string" ? (row[key] as string) : "";
const num = (row: Row, key: string): number =>
  typeof row[key] === "number" ? (row[key] as number) : 0;
/** Like {@link num} but keeps "absent" distinct from 0 — a key that folded a
 *  missing measurement into 0 would collide with a genuine zero reading. */
const numOrNull = (row: Row, key: string): number | null =>
  typeof row[key] === "number" ? (row[key] as number) : null;

/**
 * The identity of a row for intra-batch dedup, reusing the same key functions
 * `suppress.ts` uses against the database so "already on file" and "already in
 * this batch" mean the same thing.
 *
 * Returns null for types with no meaningful natural key, whose rows are then
 * never collapsed — dropping a row we cannot confidently identify as a
 * duplicate is worse than showing the user two similar rows to review.
 */
function rowKey(type: IngestType, row: Row): string | null {
  switch (type) {
    case "wellTests":
      return wellTestKey(str(row, "testDate"));
    case "downtime":
      return downtimeKey(
        str(row, "startDate"),
        str(row, "endDate"),
        str(row, "eventType")
      );
    case "service":
      return serviceKey(str(row, "date"), str(row, "job"));
    case "wellEquipment":
      return equipmentKey(str(row, "label"), str(row, "value"));
    case "shots":
      return shotKey(
        str(row, "date"),
        str(row, "time"),
        numOrNull(row, "fluidLevelFt")
      );
    case "wellNotes":
      return noteKey(str(row, "title"), str(row, "body"));
    case "gasTests":
      // The window's start pins the reading; the writer combines date + time the
      // same way, so a row split across two segments keys identically here.
      return gasTestKey(
        str(row, "meterRef"),
        `${str(row, "startDate")}T${str(row, "startTime")}`
      );
    case "production":
      return readingKey(str(row, "date"), str(row, "time"));
    case "tankReadings":
      return `${canonical(str(row, "tankRef"))}|${readingKey(str(row, "date"), str(row, "time"))}`;
    case "meterReadings":
      return `${canonical(str(row, "meterRef"))}|${readingKey(str(row, "date"), str(row, "time"))}`;
    case "runTickets":
      return `${canonical(str(row, "tankRef"))}|${str(row, "date")}|${str(row, "ticketNo")}`;
    case "meterVolumes":
      return meterVolumeKey(str(row, "date"), str(row, "purchaser"));
    case "transactions":
      return txnKey(
        str(row, "invoiceNumber"),
        num(row, "amount"),
        str(row, "date")
      );
    default:
      return null;
  }
}

/**
 * Collapse rows that key identically, keeping the FIRST occurrence.
 *
 * First rather than a field-by-field merge on purpose: a duplicate arriving
 * from a continuation page is usually the *less* complete read (the header rows
 * that carry vendor, cost, and notes are on the first page), so preferring the
 * earlier row keeps more filled fields, not fewer.
 */
export function dedupeRows(
  type: IngestType,
  rows: unknown[]
): { rows: unknown[]; dropped: number } {
  const seen = new Set<string>();
  const kept: unknown[] = [];
  let dropped = 0;
  for (const row of rows) {
    const key =
      row && typeof row === "object" ? rowKey(type, row as Row) : null;
    if (key === null) {
      kept.push(row);
      continue;
    }
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return { rows: kept, dropped };
}

/** Draft identity: one card per destination, exactly as before segmentation. */
function destinationKey(d: {
  type: IngestType;
  wellId: string | null;
  tankId?: string | null;
  meterId?: string | null;
}): string {
  return `${d.type}|${d.wellId ?? ""}|${d.tankId ?? ""}|${d.meterId ?? ""}`;
}

/**
 * Merge every segment's results into `ProposalDraft`s: one per destination,
 * rows concatenated in page order, intra-batch duplicates collapsed, and the
 * union of contributing pages recorded on `sourcePages`.
 *
 * `wellId` is left null here exactly as the pre-segmentation path did — the
 * caller stamps it (from triage's matched well, or from the well page the file
 * was dropped on).
 */
export function mergeSegmentResults(
  results: SegmentResult[],
  opts: { wellIdFor?: (type: IngestType) => string | null } = {}
): ProposalDraft[] {
  const byDestination = new Map<
    string,
    ProposalDraft & { sourcePages: number[] }
  >();

  for (const result of results) {
    if (result.rows.length === 0) continue;
    const wellId = opts.wellIdFor?.(result.type) ?? null;
    const key = destinationKey({ type: result.type, wellId });
    const existing = byDestination.get(key);
    if (existing) {
      existing.rows.push(...result.rows);
      for (const p of result.segment.pages) {
        if (!existing.sourcePages.includes(p)) existing.sourcePages.push(p);
      }
      continue;
    }
    byDestination.set(key, {
      type: result.type,
      wellId,
      rows: [...result.rows],
      sourcePages: [...result.segment.pages],
    });
  }

  const drafts: ProposalDraft[] = [];
  for (const draft of byDestination.values()) {
    const { rows, dropped } = dedupeRows(draft.type, draft.rows);
    if (dropped > 0) {
      // A nonzero count is the signal that grouping split a form it shouldn't
      // have — worth watching, not an error in itself.
      ilog("segment: intra-batch dupes dropped", { type: draft.type, dropped });
    }
    if (rows.length === 0) continue;
    drafts.push({
      ...draft,
      rows,
      sourcePages: draft.sourcePages.length
        ? [...draft.sourcePages].sort((a, b) => a - b)
        : null,
    });
  }
  return drafts;
}
