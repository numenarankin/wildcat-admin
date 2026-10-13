import "server-only";

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { categorizeDocument } from "@/lib/ai/ingest/categorize";
import { analyzeAndValidate } from "@/lib/ai/ingest/dedicated-flow";
import { loadIngestContext } from "@/lib/ai/ingest/context";
import { DEDICATED_DOCUMENT_PROMPTS } from "@/lib/ai/ingest/types";
import { oilRunStatementRow } from "@/lib/ai/ingest/schemas";
import { groupRunsIntoStatements } from "@/lib/ai/ingest/oil-run-statement";
import { meterAnthropic } from "@/lib/billing/credits";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";
import { listTanks } from "@/lib/tanks/tanks";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  STATEMENT_UPLOAD_BUCKET,
  transcriptStorageKey,
} from "@/lib/statements/storage";
import { listTicketsByTank } from "@/lib/tanks/run-tickets";
import {
  findSimilarTankByHistory,
  type ExistingTankHistory,
} from "@/lib/tanks/reconcile-history";
import {
  runBackfillFromDrafts,
  type StatementRunBackfill,
} from "@/lib/statements/run-backfill";

type Sb = SupabaseClient;

/** How far back tank histories are compared for reconciliation. */
const RECONCILE_WINDOW_DAYS = 366;

/**
 * Park the transcript beside the upload so the backfill can be run later
 * without transcribing the document a second time.
 *
 * Best-effort and never throws: the transcript is a convenience for a bonus
 * pass, and failing the extraction the user is waiting on to save a copy of
 * text we already returned would be the wrong trade.
 */
export async function storeStatementTranscript(
  storageKey: string,
  text: string
): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .storage.from(STATEMENT_UPLOAD_BUCKET)
      .upload(transcriptStorageKey(storageKey), text, {
        contentType: "text/markdown",
        upsert: true,
      });
    if (error) throw new Error(error.message);
  } catch (err) {
    ierr("statements: could not store the transcript", errorInfo(err));
  }
}

/** The stored transcript, or null when there isn't one. */
export async function readStatementTranscript(
  storageKey: string
): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .storage.from(STATEMENT_UPLOAD_BUCKET)
      .download(transcriptStorageKey(storageKey));
    if (error || !data) return null;
    const text = await data.text();
    return text.trim() ? text : null;
  } catch (err) {
    ierr("statements: could not read the transcript", errorInfo(err));
    return null;
  }
}

/**
 * The Revenue route's run-statement backfill (docs/plans/
 * cross-domain-backfill.md P4): given the transcript the statements extractor
 * already produced, decide whether this document is a crude oil RUN statement
 * — the kind that carries per-run tank detail the lease-grain extractor
 * ignores — and if so, run the SAME run-grain brain the Data Entry route uses
 * and shape what it finds into backfill candidates.
 *
 * Returns null when the document is not a run statement, when extraction finds
 * nothing, or on any failure — the backfill is a bonus on top of the primary
 * statement flow and must never break it. Nothing is inserted here: the modal
 * applies the user's reconcile decisions first and the bridge action persists
 * (`proposeStatementBackfill`), so an abandoned upload leaves no stray cards.
 */
export async function computeRunStatementBackfill(
  sb: Sb,
  documentText: string
): Promise<StatementRunBackfill | null> {
  try {
    // The classificator for this route: one cheap call, reusing the transcript.
    //
    // `oilRunStatement` ONLY, and that distinction is the whole point of the
    // category existing separately from `revenueStatement`. An aggregated
    // revenue statement carries no runs, no tickets and usually no tank number
    // at all; asking a run-grain extractor to read one anyway is asking for
    // tank numbers that are not there, and what it returns is whatever number
    // was nearest — a property number, an owner decimal, a check number — which
    // then reaches the user as a card proposing a tank that never existed.
    const { result, usage } = await categorizeDocument(documentText);
    void meterAnthropic(usage, "statements:categorize", sb);
    if (result.category !== "oilRunStatement") {
      ilog("statements: not a run statement, skipping run backfill", {
        category: result.category,
      });
      return null;
    }

    // The same run-grain extraction the Data Entry dedicated flow runs, and
    // the same prompt pair — one brain for one paper. Targets are ONLY the run
    // rows: the statement side of the document is the primary flow's job, and
    // an `oilRunStatement` draft here would double-file it (design rule 3).
    const ctx = await loadIngestContext(["oilRunStatement", "tanks"]);
    const { groups } = await analyzeAndValidate(
      documentText,
      ["oilRunStatement"],
      ctx,
      {
        skills: DEDICATED_DOCUMENT_PROMPTS.oilRunStatement,
        onUsage: (u, stage) => void meterAnthropic(u, `statements:run-${stage}`, sb),
      }
    );
    const raw = groups.find((g) => g.type === "oilRunStatement")?.rows ?? [];
    const rows = z.array(oilRunStatementRow).safeParse(raw);
    if (!rows.success || rows.data.length === 0) return null;

    const tanks = await listTanks(sb);
    const backfill = runBackfillFromDrafts(
      groupRunsIntoStatements(rows.data),
      tanks.map((t) => ({ id: t.id, name: t.name, tankNo: t.tankNo ?? null }))
    );

    // P5: score each would-be-new tank against existing oil tanks' recent run
    // history, so the modal can offer "same tank?" before a duplicate is born.
    if (backfill.candidates.length > 0) {
      const oilTanks = tanks.filter((t) => t.product === "oil");
      if (oilTanks.length > 0) {
        const since = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const ticketsByTank = await listTicketsByTank(
          sb,
          oilTanks.map((t) => t.id)
        );
        const histories: ExistingTankHistory[] = oilTanks
          .map((t) => ({
            tankId: t.id,
            label: t.name || (t.tankNo ? `Tank ${t.tankNo}` : "Unnamed tank"),
            tankRef: t.tankNo || t.name,
            tickets: (ticketsByTank.get(t.id) ?? [])
              .filter((tk) => tk.date >= since)
              .map((tk) => ({
                date: tk.date,
                ticketNo: tk.ticketNo,
                netBbls: tk.netBbls,
              })),
          }))
          .filter((h) => h.tickets.length > 0);
        for (const c of backfill.candidates) {
          c.match = findSimilarTankByHistory(
            {
              runs: c.ticketRows.map((r) => ({
                date: r.date,
                ticketNo: r.ticketNo,
                netBbls: r.netBbls ?? r.grossBbls,
              })),
            },
            histories
          );
        }
      }
    }

    ilog("statements: run backfill computed", {
      resolvedTickets: backfill.ticketRows.length,
      candidates: backfill.candidates.map((c) => ({
        ref: c.ref,
        hauls: c.ticketRows.length,
        match: c.match
          ? { label: c.match.label, confidence: c.match.confidence }
          : null,
      })),
    });
    return backfill;
  } catch (err) {
    ierr("statements: run backfill FAILED", errorInfo(err));
    return null;
  }
}
