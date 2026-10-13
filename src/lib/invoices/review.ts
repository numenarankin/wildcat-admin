import type { ExtractedInvoice } from "@/lib/invoices/extract";

/**
 * One uploaded DOCUMENT that turned out to hold invoices, ready for review.
 *
 * Grouped by document rather than flattened across the batch because the review
 * screen shows the scan beside the fields: a flat list of invoices from a
 * five-file upload has nothing to preview them against, and would put one
 * document's charge lines next to another document's page.
 *
 * Shared by the server actions that read uploads and the modal that reviews
 * them, so the two cannot drift. Its own module (not the actions file) because
 * those are `"use server"`, where every export must be a server action, and not
 * the modal's file because that is `"use client"`.
 */
export interface InvoiceReviewDocument {
  /** The stored `files` row, for the preview pane and the filed invoice's link. */
  fileId: string | null;
  fileName: string;
  invoices: ExtractedInvoice[];
}
