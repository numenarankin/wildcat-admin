"use client";

import { useEffect, useState } from "react";
import { WellModal } from "./well-modal";
import { getWellDetail } from "@/lib/scout/queries";
import { api8 } from "@/lib/scout/format";
import type { PdqLeaseKey } from "@/lib/scout/lease-key";
import type { WellDossier } from "@/lib/scout/rrc-types";
import type { WellDetail } from "@/lib/scout/types";

/*
 * ===========================================================================
 * SCOUT WELL MODAL — the map's wellbore dossier.
 * ===========================================================================
 *
 * The map used to answer a well click with a 22rem side panel fed only by
 * Archon's copy of the RRC dataset: well facts, operator, officers, no
 * production. This is the same dossier the RRC browser opens, on the same
 * `SwipeUpModal` the operator dossier uses, so a click from the map lands on
 * one surface rather than a column beside it.
 *
 * TWO READS, ONE SOURCE. Both halves now come from the Tiger mirror:
 *   - `/api/scout/rrc/well/<api8>` is the record: status, 14(b)(2) compliance,
 *     filings, completions, coordinates, and the lease production series the
 *     chart draws. Everything structural.
 *   - `getWellDetail` adds the operator's officers, which is the only route
 *     from a well into the principal panel and the affiliation network. It used
 *     to be Archon's copy; it is the same database as the other half now.
 *
 * Still fetched together and settled independently. The dossier failing is an
 * error the user sees, because without it there is no modal; the officers
 * failing costs only the Principals tab, so it passes silently rather than
 * blocking a modal that is otherwise complete.
 *
 * Both are gated: the route re-checks per request, and `getWellDetail` is a
 * server action behind the same check.
 */
export function ScoutWellModal({
  api,
  elevated = false,
  onClose,
  onBack,
  onSelectOperator,
  onSelectPrincipal,
  onSelectLease,
}: {
  /** Null closes the modal; the last dossier stays mounted for the animation. */
  api: number | null;
  elevated?: boolean;
  onClose: () => void;
  /** One step back in a stack of dossiers (see `SwipeUpModal`). */
  onBack?: () => void;
  onSelectOperator: (operatorNumber: number) => void;
  onSelectPrincipal: (name: string) => void;
  onSelectLease?: (lease: PdqLeaseKey) => void;
}) {
  const [dossier, setDossier] = useState<WellDossier | null>(null);
  // Named for the prop `WellModal` still takes; it is mirror data now.
  const [archon, setArchon] = useState<WellDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The API the body currently describes. Held separately from `api` so the
  // close animation plays over the well that was open, not over a blank modal.
  const [shownApi, setShownApi] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (api == null) return;
      setShownApi(api);
      setLoading(true);
      setError(null);
      setDossier(null);
      setArchon(null);

      const [rrc, arc] = await Promise.allSettled([
        fetch(`/api/scout/rrc/well/${api8(api)}`).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(String(r.status)))
        ),
        getWellDetail(api),
      ]);
      if (!active) return;

      if (rrc.status === "fulfilled") {
        setDossier(rrc.value as WellDossier);
      } else {
        // A 404 is not a fault: the map plots Archon's wellbore list, which
        // runs a little wider than the mirror's, so a hole can be on screen
        // and absent from the RRC tables. Say which it was.
        const notFound =
          rrc.reason instanceof Error && rrc.reason.message === "404";
        setError(
          notFound
            ? "This wellbore is not in the RRC mirror."
            : "Could not load the RRC record for this well."
        );
      }
      if (arc.status === "fulfilled") setArchon(arc.value);
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
    };
    // Deliberately NOT cleared when `api` goes null — see `shownApi`.
  }, [api]);

  return (
    <WellModal
      well={dossier}
      archon={archon}
      apiNumber={shownApi != null ? api8(shownApi) : undefined}
      open={api != null}
      loading={loading}
      error={error}
      onClose={onClose}
      onBack={onBack}
      // The mirror's operator numbers are strings; every Scout surface keys
      // operators by number.
      onSelectOperator={(no) => onSelectOperator(Number(no))}
      onSelectPrincipal={onSelectPrincipal}
      onSelectLease={onSelectLease}
      elevated={elevated}
    />
  );
}
