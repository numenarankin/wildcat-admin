"use client";

import { useEffect, useState } from "react";
import { OwnerModal } from "./owner-modal";
import { getOwner, sameOwner, type OwnerKey } from "@/lib/scout/cad-owners";
import type { PdqLeaseKey } from "@/lib/scout/lease-key";
import type { OwnerDossier } from "@/lib/scout/rrc-types";

/*
 * ===========================================================================
 * SCOUT OWNER MODAL — the map's mineral-owner dossier.
 * ===========================================================================
 *
 * Fetches the owner through `cad-owners.ts`, the same cached read the owner
 * panel and the picker use, so the three agree by construction. `key` is an
 * `OwnerKey` -- county, tax year and the roll's owner id -- because an owner
 * id is only unique within one county's roll for one year.
 */
export function ScoutOwnerModal({
  ownerKey,
  name,
  elevated = false,
  onClose,
  onBack,
  onSelectLease,
  onSelectOwner,
  onSelectOperator,
  onSelectWell,
}: {
  /** Null closes the modal; the last dossier stays mounted for the animation. */
  ownerKey: OwnerKey | null;
  /** The name the caller already has, for the header before the dossier lands. */
  name?: string | null;
  elevated?: boolean;
  onClose: () => void;
  /** One step back in a stack of dossiers (see `SwipeUpModal`). */
  onBack?: () => void;
  onSelectLease: (lease: PdqLeaseKey) => void;
  onSelectOwner: (owner: OwnerKey) => void;
  onSelectOperator: (operatorNumber: number) => void;
  onSelectWell: (api: number) => void;
}) {
  const [owner, setOwner] = useState<OwnerDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<OwnerKey | null>(null);

  const county = ownerKey?.county_no ?? null;
  const year = ownerKey?.tax_year ?? null;
  const id = ownerKey?.owner_id ?? null;

  useEffect(() => {
    let active = true;
    async function load() {
      if (!county || year == null || !id) return;
      const k = { county_no: county, tax_year: year, owner_id: id };
      setShownKey(k);
      setLoading(true);
      setError(null);
      setOwner(null);
      try {
        const d = await getOwner(k);
        if (active) setOwner(d);
      } catch (err) {
        if (!active) return;
        setError(
          err instanceof Error && err.message.endsWith("404")
            ? "This owner is not on a loaded mineral roll."
            : "Could not load the owner record."
        );
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
    // Deliberately NOT cleared when the key goes null -- see `shownKey`.
  }, [county, year, id]);

  return (
    <OwnerModal
      owner={sameOwner(owner, shownKey) ? owner : null}
      keyHint={{ name }}
      open={ownerKey != null}
      loading={loading}
      error={error}
      onClose={onClose}
      onBack={onBack}
      onSelectLease={onSelectLease}
      onSelectOwner={onSelectOwner}
      onSelectOperator={(n) => onSelectOperator(Number(n))}
      onSelectWell={(api) => onSelectWell(Number(api))}
      elevated={elevated}
    />
  );
}
