import { canonical, canonicalId } from "@/lib/ai/ingest/normalize";
import type { OilRunStatementDraft } from "@/lib/ai/ingest/oil-run-statement";
import type { HistoryMatch } from "@/lib/tanks/reconcile-history";
import type { StatementBackfillDraft } from "@/lib/statements/actions";

/**
 * Run statements → tanks + run tickets (docs/plans/cross-domain-backfill.md
 * P4): the pure transform from run-grain extraction to backfill drafts.
 *
 * Design rules it enforces, from the plan:
 *  - It emits ONLY `tanks` and `runTickets` rows — NEVER an `oilRunStatement`
 *    draft, whose writer would file a second statement beside the one
 *    `saveStatement` already filed.
 *  - Tickets carry barrels, never dollars: the statement lines own the money.
 *  - A tank the org does not have is a CANDIDATE, listed for the user to
 *    approve (or reconcile with a similar tank), instead of being silently
 *    created by the writer's `resolveOrCreateTank`.
 *
 * Pure and client-safe: the upload modal uses `backfillDraftsFrom` to apply
 * the user's reconcile decisions before anything is inserted.
 */

/** One proposed haul, shaped as the `runTickets` ingest row schema. */
export interface RunTicketRowOut {
  tankRef: string;
  date: string;
  departureTime: string;
  ticketNo: string;
  ticketType: "run" | "transfer" | "disposition";
  grossBbls: number;
  netBbls: number | null;
  apiGravity: number | null;
  bsW: number | null;
  openingGauge: number | null;
  closingGauge: number | null;
  purchaser: string;
  transporter: string;
  product: "oil";
  sourceText?: string;
}

/** One proposed tank, shaped as the `tanks` ingest row schema. */
export interface TankRowOut {
  name: string;
  product: "oil";
  tankNo: string;
  /** The lease the runs were settled under — what NAMES the tank. */
  lease: string;
  battery: string;
  gatherer: string;
  bblPerInch: number;
  capacityBbls: number | null;
  active: boolean;
  sourceText?: string;
}

/** An unresolved tank ref: a would-be-new tank plus its hauls. */
export interface RunBackfillCandidate {
  ref: string;
  tankRow: TankRowOut;
  ticketRows: RunTicketRowOut[];
  /** A similar-history tank worth reconciling with, or null (P5 scoring). */
  match: HistoryMatch | null;
}

/** What a run-statement upload can backfill, as the extract route returns it. */
export interface StatementRunBackfill {
  /** Hauls on tanks that already exist — proposed as `runTickets` rows. */
  ticketRows: RunTicketRowOut[];
  /** Distinct refs that resolve to no tank on file. */
  candidates: RunBackfillCandidate[];
}

/** The same number-first, then-name resolution the write step uses. */
function makeResolver(tanks: { id: string; name: string; tankNo: string | null }[]) {
  return (ref: string): string | null => {
    const r = canonical(ref);
    if (!r) return null;
    const rid = canonicalId(ref);
    const hit =
      tanks.find((t) => t.tankNo && (canonical(t.tankNo) === r || canonicalId(t.tankNo) === rid)) ??
      tanks.find((t) => canonical(t.name) === r);
    return hit?.id ?? null;
  };
}

/**
 * Split grouped run-statement drafts into hauls on existing tanks and
 * candidates for new ones. Rows with no tank ref, or no usable date even after
 * the statement-period fallback, are dropped (the writer would skip them too).
 */
export function runBackfillFromDrafts(
  drafts: OilRunStatementDraft[],
  existingTanks: { id: string; name: string; tankNo: string | null }[]
): StatementRunBackfill {
  const resolve = makeResolver(existingTanks);
  const ticketRows: RunTicketRowOut[] = [];
  const byRef = new Map<
    string,
    { ref: string; rows: RunTicketRowOut[]; gatherer: string; lease: string }
  >();

  for (const d of drafts) {
    for (const run of d.lines) {
      const ref = run.tankRef.trim();
      if (!ref) continue;
      const date = run.runDate || d.periodEnd;
      if (!date) continue;
      const row: RunTicketRowOut = {
        tankRef: ref,
        date,
        departureTime: "",
        ticketNo: run.ticketNo,
        ticketType: run.ticketType,
        // The statement prints net (corrected) barrels; gross is not on the
        // paper, so both carry the settled figure — the same convention
        // `writeOilRunStatements` uses. NO dollars, by design.
        grossBbls: run.volume,
        netBbls: run.volume,
        apiGravity: run.gravity,
        bsW: null,
        openingGauge: null,
        closingGauge: null,
        purchaser: d.purchaser,
        transporter: run.transporter,
        product: "oil",
        sourceText: run.sourceText || undefined,
      };
      if (resolve(ref)) {
        ticketRows.push(row);
      } else {
        const key = canonical(ref);
        const entry = byRef.get(key) ?? {
          ref,
          rows: [],
          gatherer: d.purchaser,
          lease: "",
        };
        // First lease printed against this tank wins. A tank sits on ONE lease,
        // and a later run naming another is a settlement quirk, not a move.
        if (!entry.lease) entry.lease = run.leaseRef.trim();
        entry.rows.push(row);
        byRef.set(key, entry);
      }
    }
  }

  const candidates: RunBackfillCandidate[] = [...byRef.values()].map((c) => ({
    ref: c.ref,
    tankRow: {
      name: c.ref,
      product: "oil",
      tankNo: c.ref,
      lease: c.lease,
      battery: "",
      gatherer: c.gatherer,
      // Placeholder strapping factor — the card is editable and hints the user
      // to set the real one before approving (P4.5 of the plan).
      bblPerInch: 1,
      capacityBbls: null,
      active: true,
      sourceText: c.rows[0]?.sourceText,
    },
    ticketRows: c.rows,
    match: null,
  }));

  return { ticketRows, candidates };
}

/** The user's answer for one matched candidate. */
export type ReconcileDecision =
  | { kind: "new" }
  | {
      kind: "same";
      /** The existing tank's ref (its number, else its name) — what the
       *  `runTickets` writer will resolve. */
      tankRef: string;
    };

/**
 * Fold the backfill and the user's reconcile decisions into the drafts the
 * bridge action inserts. The `tanks` draft comes FIRST so its card appears
 * before the tickets card (the queue shows oldest first) and an approved tank
 * exists by the time the tickets write.
 *
 * A matched candidate with no recorded decision defaults to "new": a duplicate
 * tank card can be dismissed, while a wrong merge corrupts a real tank's
 * history — always err toward the recoverable mistake.
 */
export function backfillDraftsFrom(
  backfill: StatementRunBackfill,
  decisions: Record<string, ReconcileDecision> = {},
  /**
   * What the REVIEW resolved each printed lease ref to
   * (`reviewedLeaseIdentities`). The run-grain pass reads the paper on its own
   * and only knows the printed ref, so a lease the user matched by hand would
   * otherwise resolve to nothing when the tank is approved.
   */
  leaseByRef?: ReadonlyMap<string, string>
): StatementBackfillDraft[] {
  const tanks: TankRowOut[] = [];
  const tickets: RunTicketRowOut[] = [...backfill.ticketRows];
  for (const c of backfill.candidates) {
    const decision = c.match ? (decisions[c.ref] ?? { kind: "new" as const }) : { kind: "new" as const };
    if (decision.kind === "same" && decision.tankRef.trim()) {
      const target = decision.tankRef.trim();
      tickets.push(...c.ticketRows.map((r) => ({ ...r, tankRef: target })));
    } else {
      const lease = leaseByRef?.get(canonical(c.tankRow.lease));
      tanks.push(lease ? { ...c.tankRow, lease } : c.tankRow);
      tickets.push(...c.ticketRows);
    }
  }
  const out: StatementBackfillDraft[] = [];
  if (tanks.length > 0) out.push({ type: "tanks", rows: tanks });
  if (tickets.length > 0) out.push({ type: "runTickets", rows: tickets });
  return out;
}
