/**
 * Entity-scoping for an upload: pre-target freshly extracted drafts at the one
 * entity the file was uploaded from, so an "Add History"-style upload lands on
 * that device without the user re-picking it.
 *
 * Pure module (no server imports) for two reasons. `files/actions.ts` is
 * `"use server"`, where every value export must be an async server action, so
 * this could not be exported from there. And the transform's IDEMPOTENCE is
 * load-bearing — it is applied twice, once inside the scan (before suppression)
 * and once on the returned drafts — which is a property worth unit-testing
 * rather than assuming.
 *
 * Why it runs inside the scan at all: every entity-scoped handler in
 * `suppress.ts` opens with `if (!d.wellId) return d.rows`. Applying the scope
 * only to the drafts the scan had already returned left those handlers looking
 * at a null entity on every scoped upload, so nothing was ever suppressed and
 * duplicates reached the approval modal as cards the write step then refused.
 */

import type { ProposalDraft } from "@/lib/ai/ingest/scan";
import { INGEST_TYPE_META, type IngestType } from "@/lib/ai/ingest/types";
import {
  distinctTankCount,
  forceRowsToPinnedTank,
  scopeRowsToPinnedTank,
} from "@/lib/ai/ingest/tank-scope";

export interface UploadScope {
  /** Default well for well-scoped types that didn't name one (e.g. wellTests). */
  defaultWellId?: string | null;
  /** Force this tank ref on every tank-scoped row (tankReadings / runTickets). */
  tankRef?: string | null;
  /**
   * Pin tank-scoped drafts to this exact tank id, so the write lands here and
   * never resolves by name or auto-creates a tank. Set for tank Add History.
   */
  tankId?: string | null;
  /** Force this meter ref on every meter-scoped row (meterReadings). */
  meterRef?: string | null;
  /**
   * Pin meter-scoped drafts to this exact meter id, so the write lands here and
   * never resolves by name or auto-creates a meter. Set for meter Add History.
   */
  meterId?: string | null;
}

/** Tank-scoped ingest types whose rows carry a `tankRef` we can pre-target. */
const TANK_SCOPED_TYPES: ReadonlySet<IngestType> = new Set([
  "tankReadings",
  "runTickets",
]);

/** Meter-scoped ingest types whose rows carry a `meterRef` we can pre-target. */
const METER_SCOPED_TYPES: ReadonlySet<IngestType> = new Set(["meterReadings"]);

/**
 * Apply an upload scope to freshly extracted drafts.
 *
 * IDEMPOTENT — `applyUploadScope(applyUploadScope(d, s), s)` equals
 * `applyUploadScope(d, s)` — because every branch is: stamp an id only when it
 * is missing, rewrite a ref to a fixed value, or filter by a predicate the first
 * pass already satisfied. Callers rely on this to run it both inside the scan
 * and on the way out, so no upload surface can lose its scope by forgetting one.
 */
export function applyUploadScope(
  drafts: ProposalDraft[],
  scope?: UploadScope,
  /** True when this upload is a single file (so a lone tank in it is unambiguous). */
  singleFileUpload = false
): ProposalDraft[] {
  if (!scope) return drafts;
  // Scoped to an existing device ("Add History" from a tank/meter page): the
  // records attach to THAT device, so never propose creating the entity itself.
  let base = drafts;
  if (scope.tankId || scope.tankRef) base = base.filter((d) => d.type !== "tanks");
  if (scope.meterId || scope.meterRef)
    base = base.filter((d) => d.type !== "meters");
  // The same rule for a well. `defaultWellId` means the file was dropped on a
  // well's page, and the generic route (which the disposal pages use) is free
  // to propose `wells` / `injectionWells` from any name it reads. Without this
  // a ticket for the well the user was standing on came back as "Add injection
  // well Hughes 1?" — the page's own well, spelled without the "#".
  if (scope.defaultWellId)
    base = base.filter((d) => d.type !== "wells" && d.type !== "injectionWells");

  // How many distinct tanks does this upload's data actually name? When a single
  // file names at most one tank, the "keep only the pinned tank's rows" guard
  // (built for files that hold several tanks) is too strict — the user pinned
  // this file to a tank, so accept all its rows even if the file's printed label
  // differs from the tank's name. The guard still bites for multi-tank files.
  const forceSingleTank =
    singleFileUpload &&
    distinctTankCount(
      base.flatMap((d) => (TANK_SCOPED_TYPES.has(d.type) ? d.rows : []))
    ) <= 1;

  return base
    .map((d) => {
      let out = d;
      if (scope.defaultWellId && INGEST_TYPE_META[d.type].needsWell && !d.wellId) {
        out = { ...out, wellId: scope.defaultWellId };
      }
      if (TANK_SCOPED_TYPES.has(d.type) && (scope.tankRef || scope.tankId)) {
        out = {
          ...out,
          // Pin the DEFAULT write target to this tank; scoping keeps only this
          // tank's rows so another tank's data is never mislabeled as this one —
          // unless the upload is unambiguously one tank, when we keep them all.
          tankId: scope.tankId ?? out.tankId ?? null,
          rows: scope.tankRef
            ? forceSingleTank
              ? forceRowsToPinnedTank(out.rows, scope.tankRef)
              : scopeRowsToPinnedTank(out.rows, scope.tankRef)
            : out.rows,
        };
      }
      if (METER_SCOPED_TYPES.has(d.type) && (scope.meterRef || scope.meterId)) {
        out = {
          ...out,
          // Pin the write target to the exact meter; keep meterRef for display.
          meterId: scope.meterId ?? out.meterId ?? null,
          rows: scope.meterRef
            ? out.rows.map((r) => ({
                ...(r as Record<string, unknown>),
                meterRef: scope.meterRef,
              }))
            : out.rows,
        };
      }
      return out;
    })
    // A tank-scoped draft whose rows were all for OTHER tanks is now empty — drop
    // it so the approval modal doesn't show a phantom, zero-row card.
    .filter((d) => !TANK_SCOPED_TYPES.has(d.type) || d.rows.length > 0);
}
