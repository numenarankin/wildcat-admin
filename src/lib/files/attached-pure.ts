/**
 * Documents that belong to a facility because a DOMAIN ROW points at them,
 * not because someone placed them in its folder: an invoice or field ticket
 * (`pidx_documents.source_file_id`), a service entry's source
 * (`well_service.file_id`), a run ticket's photo (`run_tickets.image_ref`).
 *
 * Files pages and Files tabs list these beside the placed files so a well's
 * tab is every document the app holds about the well, not only the ones
 * dragged onto it. The pure parts live here so the merge and the naming can
 * be tested without a database; `attached-documents.ts` does the reading.
 */

import type { FacilityKind } from "@/lib/files/facility-folder";
import type { KBFileType } from "@/lib/kb/types";
import type { WellFile } from "@/lib/wells/wells";

/**
 * A run ticket's photo has no `files` row: the bytes sit in the accounting
 * bucket under the ticket's `image_ref`. It is listed under a synthetic file
 * id so the same rows, viewers and download action serve it; the prefix is
 * what routes those back to the ticket.
 */
export const TICKET_FILE_PREFIX = "ticket_";

export function ticketFileId(ticketId: string): string {
  return `${TICKET_FILE_PREFIX}${ticketId}`;
}

/** The run ticket behind a synthetic file id, or null for a real file id. */
export function ticketIdFromFileId(fileId: string): string | null {
  return fileId.startsWith(TICKET_FILE_PREFIX)
    ? fileId.slice(TICKET_FILE_PREFIX.length)
    : null;
}

/** What a ticket's photo is called in a file list: its kind and its number. */
export function ticketFileName(t: {
  ticketType: string | null;
  ticketNo: string | null;
  ticketDate: string | null;
}): string {
  const kind =
    t.ticketType === "transfer"
      ? "Transfer ticket"
      : t.ticketType === "disposition"
        ? "Disposition ticket"
        : "Run ticket";
  // Ticket numbers scanned off paper can carry the gauge lines too; the first
  // line is the number.
  const no = (t.ticketNo ?? "").split("\n").find((l) => l.trim())?.trim();
  return `${kind} ${no || t.ticketDate || ""}`.trim();
}

/** A stored object's MIME type as the file type the viewers switch on. */
export function typeFromMime(mime: string | null | undefined): KBFileType {
  if (!mime) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  return "doc";
}

/** One attached document, resolved to what a file list needs. */
export interface AttachedDocument {
  /** `files.id`, or a {@link ticketFileId} for a run ticket photo. */
  fileId: string;
  name: string;
  type: string;
  size: number | null;
  scanStatus: string | null;
  /** When the ATTACHMENT happened: the domain row's `created_at`. ISO. */
  addedAt: string;
  kind: FacilityKind;
  entityId: string;
}

/**
 * Placed files first (they are the folder's own rows and carry its pin state),
 * then the attached ones the folder does not already hold, all newest first.
 * A service document attached from the well page is both placed and
 * referenced, so it must appear once.
 */
export function mergeAttached<T extends { id: string; addedAt: string }>(
  placed: T[],
  attached: T[]
): T[] {
  const seen = new Set(placed.map((f) => f.id));
  const out = [...placed];
  for (const f of attached) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** An attached document as a Files tab row, with the sort key alongside. */
export function attachedWellFile(
  d: AttachedDocument
): WellFile & { addedAt: string } {
  return {
    id: d.fileId,
    name: d.name,
    type: d.type.toUpperCase(),
    sizeKb: Math.max(1, Math.round((d.size ?? 0) / 1024)),
    uploadedAt: d.addedAt.slice(0, 10),
    scanStatus: (d.scanStatus as WellFile["scanStatus"]) ?? null,
    attached: true,
    addedAt: d.addedAt,
  };
}

/** The rows without their sort key, once the merge has used it. */
export function withoutAddedAt<T extends { addedAt: string }>(
  rows: T[]
): Omit<T, "addedAt">[] {
  return rows.map((row) => {
    const copy: Partial<T> = { ...row };
    delete copy.addedAt;
    return copy as Omit<T, "addedAt">;
  });
}
