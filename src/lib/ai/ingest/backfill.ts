import "server-only";

import type { getSupabaseServer } from "@/lib/supabase/server";
import {
  insertIngestProposals,
  type ProposalDraft,
} from "@/lib/ai/ingest/scan";
import type { IngestProposal } from "@/lib/ai/ingest/actions";
import { suppressExistingRows } from "@/lib/ai/ingest/suppress";
import { ilog } from "@/lib/ai/ingest/log";

type Sb = Awaited<ReturnType<typeof getSupabaseServer>>;

/**
 * The bridge from a route-specific extractor to the shared proposal system.
 *
 * The Revenue and Invoices upload paths run their own extraction engines and
 * keep their own review screens for the PRIMARY document (the statement, the
 * invoice) — see docs/plans/cross-domain-backfill.md. What they hand here is
 * only the SECONDARY, cross-domain data those documents happen to carry
 * (leases to create, tanks, run tickets, well equipment), already shaped as
 * ordinary `ProposalDraft`s of existing ingest types.
 *
 * This is deliberately nothing more than the tail of `computeIngestProposals`
 * exposed to callers that ran their own extraction: drop empty drafts, run
 * scan-time suppression so "already on file" never becomes a card, persist to
 * `ingest_proposals`, and return the inserted proposals for the client to
 * enqueue (`enqueueIngestProposals`) after its primary save completes.
 *
 * `fileId` is null for uploads with no `files` row (statement uploads live in
 * the statement bucket); the proposal then carries only the file name.
 */
export async function proposeBackfillDrafts(
  sb: Sb,
  opts: { fileId: string | null; fileName: string; drafts: ProposalDraft[] }
): Promise<IngestProposal[]> {
  const nonEmpty = opts.drafts.filter((d) => d.rows.length > 0);
  if (nonEmpty.length === 0) return [];
  const { drafts, suppressed } = await suppressExistingRows(sb, nonEmpty);
  ilog("backfill: drafts", {
    fileName: opts.fileName,
    offered: nonEmpty.length,
    kept: drafts.length,
    suppressed,
    types: drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
  });
  if (drafts.length === 0) return [];
  return insertIngestProposals(sb, opts.fileId, opts.fileName, drafts);
}
