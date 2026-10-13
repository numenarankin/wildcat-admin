"use client";

import { useEffect, useState } from "react";
import { LeaseModal } from "./lease-modal";
import type { PdqLeaseKey } from "@/lib/scout/lease-key";
import type { LeaseDossier } from "@/lib/scout/rrc-types";
import type { OwnerKey } from "@/lib/scout/cad-owners";

/*
 * ===========================================================================
 * SCOUT LEASE MODAL — the map's lease dossier.
 * ===========================================================================
 *
 * The lease is the grain Texas actually publishes at: operator roll-ups are
 * sums of it and per-well oil is an allocation of it, so it is the only place
 * in Scout where the volumes are as reported rather than derived. The map used
 * to have no way to reach it — production was visible only through whichever
 * lease a well happened to sit on.
 *
 * Fetches `/api/scout/rrc/lease/<og>/<district>/<lease>` from the Tiger Cloud
 * mirror, gated per request. `key` is a `PdqLeaseKey` and must be built with
 * `@/lib/scout/lease-key`, never assembled by hand: the district coding and the
 * lease-number padding both differ by caller, and getting either wrong opens a
 * real lease belonging to a different operator rather than failing.
 */
export function ScoutLeaseModal({
  leaseKey,
  elevated = false,
  onClose,
  onBack,
  onSelectOperator,
  onSelectWell,
  onSelectOwner,
}: {
  /** Null closes the modal; the last dossier stays mounted for the animation. */
  leaseKey: PdqLeaseKey | null;
  elevated?: boolean;
  onClose: () => void;
  /** One step back in a stack of dossiers (see `SwipeUpModal`). */
  onBack?: () => void;
  onSelectOperator: (operatorNumber: number) => void;
  onSelectWell: (api: number) => void;
  onSelectOwner?: (owner: OwnerKey) => void;
}) {
  const [lease, setLease] = useState<LeaseDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<PdqLeaseKey | null>(null);

  // The key is an object, so the effect keys on its three parts rather than on
  // its identity — a caller rebuilding an equal key on every render would
  // otherwise refetch forever.
  const og = leaseKey?.oil_gas_code ?? null;
  const district = leaseKey?.district_no ?? null;
  const no = leaseKey?.lease_no ?? null;

  useEffect(() => {
    let active = true;
    async function load() {
      if (!og || !district || !no) return;
      setShownKey({ oil_gas_code: og, district_no: district, lease_no: no });
      setLoading(true);
      setError(null);
      setLease(null);
      try {
        const res = await fetch(`/api/scout/rrc/lease/${og}/${district}/${no}`);
        if (!res.ok) throw new Error(String(res.status));
        if (active) setLease((await res.json()) as LeaseDossier);
      } catch (err) {
        if (!active) return;
        setError(
          err instanceof Error && err.message === "404"
            ? "This lease is not in the RRC mirror."
            : "Could not load the lease record."
        );
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
    // Deliberately NOT cleared when the key goes null — see `shownKey`.
  }, [og, district, no]);

  return (
    <LeaseModal
      lease={lease}
      keyHint={shownKey ?? undefined}
      open={leaseKey != null}
      loading={loading}
      error={error}
      onClose={onClose}
      onBack={onBack}
      // The mirror keys operators and wells as strings; every Scout surface
      // keys them by number.
      onSelectOperator={(n) => onSelectOperator(Number(n))}
      onSelectWell={(api) => onSelectWell(Number(api))}
      onSelectOwner={onSelectOwner}
      elevated={elevated}
    />
  );
}
