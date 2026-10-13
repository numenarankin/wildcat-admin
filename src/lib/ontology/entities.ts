import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listBatteries } from "@/lib/batteries/batteries";
import { getLeases } from "@/lib/leases/actions";
import { listMeters } from "@/lib/meters/meters";
import {
  getContractors,
  getEmployees,
  getGatherers,
  getRoyaltyOwners,
  getServiceProviders,
} from "@/lib/people/people";
import { listPurchasers } from "@/lib/tanks/run-tickets";
import { listTanks } from "@/lib/tanks/tanks";
import { getWells } from "@/lib/wells/wells";
import type { Candidate } from "./match";

/**
 * Everything the org has that a person might name, as one list.
 *
 * `resolve` and `select` both need the same roster, so it is loaded once here
 * rather than assembled twice with two different ideas of what counts. Each
 * candidate carries a `detail` line, which is what makes an ambiguous answer
 * usable: two wells called REPASS are indistinguishable until one says "on
 * REPASS LEASE, producing" and the other says "injection, inactive".
 *
 * Everything reads through the request-scoped client, so RLS scopes the roster
 * to the caller's org exactly as the pages do.
 */

type Sb = SupabaseClient;

export interface Roster {
  candidates: Candidate[];
  /** Lease name by id, for rendering a well's membership. */
  leaseNames: Map<string, string>;
}

const clean = (value: string | null | undefined): string => (value ?? "").trim();

/** Join the parts of a detail line that are actually present. */
function detail(...parts: (string | null | undefined)[]): string | undefined {
  const kept = parts.map(clean).filter(Boolean);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

export async function loadRoster(sb: Sb): Promise<Roster> {
  const [
    wells,
    leases,
    tanks,
    batteries,
    meters,
    purchasers,
    vendors,
    owners,
    employees,
    contractors,
    gatherers,
  ] = await Promise.all([
    getWells(),
    getLeases(),
    listTanks(sb),
    listBatteries(sb),
    listMeters(sb, "all"),
    listPurchasers(sb),
    getServiceProviders(),
    getRoyaltyOwners(),
    getEmployees(),
    getContractors(),
    getGatherers(),
  ]);

  const leaseNames = new Map(
    leases.map((l) => [l.id, clean(l.name) || clean(l.leaseNo) || l.id])
  );

  const candidates: Candidate[] = [
    ...wells.map((w) => ({
      type: "well" as const,
      id: w.id,
      name: w.name,
      detail: detail(
        w.type === "injection" ? "injection well" : "producing well",
        w.leaseId ? leaseNames.get(w.leaseId) : null,
        w.county,
        w.active ? null : "inactive"
      ),
    })),
    ...leases.map((l) => ({
      type: "lease" as const,
      id: l.id,
      name: clean(l.name) || clean(l.leaseNo),
      detail: detail(
        l.leaseNo ? `lease ${l.leaseNo}` : null,
        l.county,
        `${l.wellCount} wells`,
        l.active ? null : "inactive"
      ),
    })),
    ...tanks.map((t) => ({
      type: "tank" as const,
      id: t.id,
      name: t.name,
      detail: detail(
        `${t.product} tank`,
        t.battery ? `battery ${t.battery}` : null,
        t.leaseId ? leaseNames.get(t.leaseId) : null
      ),
    })),
    ...batteries.map((b) => ({
      type: "battery" as const,
      id: b.id,
      name: b.name,
      detail: detail(
        `${b.tankCount} tanks`,
        b.leaseId ? leaseNames.get(b.leaseId) : null,
        b.active ? null : "inactive"
      ),
    })),
    ...meters.map((m) => ({
      type: "meter" as const,
      id: m.id,
      name: clean(m.name),
      detail: detail(
        `${m.substance} meter`,
        m.meterNo ? `#${m.meterNo}` : null,
        m.leaseId ? leaseNames.get(m.leaseId) : null,
        m.active ? null : "inactive"
      ),
    })),
    ...purchasers.map((p) => ({
      type: "purchaser" as const,
      id: p.id,
      name: p.name,
      detail: detail("purchaser"),
    })),
    ...vendors.map((v) => ({
      type: "vendor" as const,
      id: v.id,
      name: clean(v.company) || clean(v.contact),
      detail: detail("vendor", v.service),
    })),
    ...owners.map((o) => ({
      type: "owner" as const,
      id: o.id,
      name: o.name,
      detail: detail("royalty owner"),
    })),
    ...employees.map((e) => ({
      type: "employee" as const,
      id: e.id,
      name: e.name,
      detail: detail("employee", e.role),
    })),
    ...contractors.map((c) => ({
      type: "contractor" as const,
      id: c.id,
      name: c.name,
      detail: detail("contractor", c.trade),
    })),
    ...gatherers.map((g) => ({
      type: "gatherer" as const,
      id: g.id,
      name: g.name,
      detail: detail("gatherer"),
    })),
  ].filter((c) => c.name.length > 0);

  return { candidates, leaseNames };
}
