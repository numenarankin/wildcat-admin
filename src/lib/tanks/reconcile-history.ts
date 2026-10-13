import { canonicalId } from "@/lib/ai/ingest/normalize";

/**
 * Tank history reconciliation (docs/plans/cross-domain-backfill.md P5).
 *
 * A run statement can name a tank by a number that matches nothing on file —
 * the purchaser's number, not ours — while the tank itself plainly already
 * exists: its runs (dates, ticket numbers, net barrels) line up with one
 * tank's history. This module scores that similarity so the Revenue upload can
 * ask "same tank, or new tank?" instead of quietly creating a duplicate.
 *
 * Pure — no I/O — and deliberately STRICT: a false "same tank" merges two
 * tanks' histories, which is far worse than one duplicate tank the user can
 * merge later. Thresholds are named constants so tuning is a diff, not a hunt.
 */

/** One haul from the incoming statement. */
export interface CandidateRun {
  date: string;
  ticketNo: string;
  netBbls: number | null;
}

/** One existing tank's recent run history. */
export interface ExistingTankHistory {
  tankId: string;
  label: string;
  /** The ref (tank number, else display name) the run-ticket writer resolves —
   *  what a "same tank" decision re-points the incoming hauls at. */
  tankRef: string;
  tickets: { date: string; ticketNo: string; netBbls: number | null }[];
}

export interface HistoryMatch {
  tankId: string;
  label: string;
  /** Carried from {@link ExistingTankHistory.tankRef}. */
  tankRef: string;
  confidence: "likely" | "possible";
  overlap: {
    /** Candidate runs that matched an existing ticket. */
    runs: number;
    /** How many of those matched on the ticket NUMBER — the strongest signal. */
    ticketNos: number;
    /** Matched runs as a percentage of the candidate's runs. */
    volumePct: number;
  };
}

/** Net-barrels agreement tolerance — the same 2% `reconcileSettledVolume` uses. */
export const VOLUME_TOLERANCE_PCT = 2;
/** `possible`: at least this many matching runs. */
export const POSSIBLE_MIN_RUNS = 2;
/** `likely`: at least this many matching runs including a ticket-number hit… */
export const LIKELY_MIN_RUNS = 3;
/** …or at least this fraction of the candidate's runs matching. */
export const LIKELY_MATCH_FRACTION = 0.8;

function volumesAgree(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  if (base === 0) return true;
  return (Math.abs(a - b) / base) * 100 <= VOLUME_TOLERANCE_PCT;
}

/**
 * Score one candidate against one tank. A candidate run matches an existing
 * ticket when the ticket numbers agree (both printed, canonically equal — the
 * near-unique signal), or when the dates are equal and the net barrels agree
 * within tolerance. Each existing ticket can satisfy at most one run.
 */
export function scoreTankHistory(
  runs: CandidateRun[],
  existing: ExistingTankHistory
): HistoryMatch["overlap"] {
  const used = new Set<number>();
  let matched = 0;
  let ticketNos = 0;
  for (const run of runs) {
    const runNo = run.ticketNo ? canonicalId(run.ticketNo) : "";
    let hit = -1;
    let hitOnNo = false;
    for (let i = 0; i < existing.tickets.length; i++) {
      if (used.has(i)) continue;
      const t = existing.tickets[i];
      const tNo = t.ticketNo ? canonicalId(t.ticketNo) : "";
      if (runNo && tNo && runNo === tNo) {
        hit = i;
        hitOnNo = true;
        break; // a ticket-number hit beats any date match
      }
      if (hit === -1 && run.date && t.date === run.date && volumesAgree(run.netBbls, t.netBbls)) {
        hit = i;
      }
    }
    if (hit !== -1) {
      used.add(hit);
      matched++;
      if (hitOnNo) ticketNos++;
    }
  }
  return {
    runs: matched,
    ticketNos,
    volumePct: runs.length === 0 ? 0 : Math.round((matched / runs.length) * 100),
  };
}

function confidenceOf(
  overlap: HistoryMatch["overlap"],
  candidateRuns: number
): HistoryMatch["confidence"] | null {
  const fraction = candidateRuns === 0 ? 0 : overlap.runs / candidateRuns;
  if (
    (overlap.runs >= LIKELY_MIN_RUNS && overlap.ticketNos >= 1) ||
    (overlap.runs >= POSSIBLE_MIN_RUNS && fraction >= LIKELY_MATCH_FRACTION)
  ) {
    return "likely";
  }
  if (overlap.runs >= POSSIBLE_MIN_RUNS) return "possible";
  return null;
}

/**
 * The best existing tank for a candidate's history, or null when nothing
 * clears the `possible` bar. Best = most matched runs, then most ticket-number
 * hits; ties beyond that keep the first tank offered.
 */
export function findSimilarTankByHistory(
  candidate: { runs: CandidateRun[] },
  existing: ExistingTankHistory[]
): HistoryMatch | null {
  let best: HistoryMatch | null = null;
  for (const tank of existing) {
    if (tank.tickets.length === 0) continue;
    const overlap = scoreTankHistory(candidate.runs, tank);
    const confidence = confidenceOf(overlap, candidate.runs.length);
    if (!confidence) continue;
    if (
      !best ||
      overlap.runs > best.overlap.runs ||
      (overlap.runs === best.overlap.runs && overlap.ticketNos > best.overlap.ticketNos)
    ) {
      best = {
        tankId: tank.tankId,
        label: tank.label,
        tankRef: tank.tankRef,
        confidence,
        overlap,
      };
    }
  }
  return best;
}
