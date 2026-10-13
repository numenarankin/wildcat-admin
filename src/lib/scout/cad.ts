/**
 * Mineral ownership from county appraisal rolls: the pure half.
 *
 * What is loaded, what the codes mean, and the arithmetic every surface
 * repeats (the per-type totals on a lease). No database and no `server-only`,
 * so the modals, the map bar, the routes and the Orion tools all read one
 * definition. The reads live in `cad-queries.ts`; the design is
 * `docs/plans/scout-minerals.md`.
 */

/**
 * The rolls that are loaded, by RRC county code.
 *
 * A CONSTANT rather than a query because the copy that depends on it -- the
 * Minerals tab's visibility, owner mode's empty state, the Orion tools'
 * "not covered" answer -- is needed before any query runs. The integration
 * check (`cad-check.test.ts`) holds it to `cad.coverage` in the mirror, so the
 * two cannot drift silently. Adding a county: load the roll, add the entry.
 */
export const CAD_COUNTIES: Readonly<
  Record<string, { readonly name: string; readonly taxYear: number }>
> = {
  "009": { name: "Archer", taxYear: 2025 },
};

export interface CadCoverage {
  countyNo: string;
  name: string;
  taxYear: number;
}

/** The loaded roll for a county, or null when that county has none. */
export function cadCoverage(countyNo: string | null | undefined): CadCoverage | null {
  if (!countyNo) return null;
  const code = String(countyNo).replace(/\D/g, "").padStart(3, "0");
  const hit = CAD_COUNTIES[code];
  return hit ? { countyNo: code, name: hit.name, taxYear: hit.taxYear } : null;
}

/** Every loaded roll, for the copy that has to name them. */
export function cadCoverageList(): CadCoverage[] {
  return Object.entries(CAD_COUNTIES).map(([countyNo, c]) => ({
    countyNo,
    name: c.name,
    taxYear: c.taxYear,
  }));
}

/** "Archer County (2025 roll)" -- one phrase, used wherever coverage is stated. */
export function cadCoverageSentence(): string {
  const parts = cadCoverageList().map((c) => `${c.name} County (${c.taxYear} roll)`);
  return `Mineral ownership is loaded for ${parts.join(", ")}.`;
}

/** The three interest types a roll files, in the order a reader wants them. */
export const INTEREST_TYPES = ["R", "W", "O"] as const;
export type InterestType = (typeof INTEREST_TYPES)[number];

export const INTEREST_TYPE_LABEL: Record<InterestType, string> = {
  R: "Royalty",
  W: "Working",
  O: "Overriding",
};

/** Owner type codes as the Archer roll uses them. */
export const OWNER_TYPE_LABEL: Record<string, string> = {
  I: "Individual",
  C: "Company",
  T: "Trust",
  E: "Estate",
  G: "Government",
  N: "Non-profit",
};

export function ownerTypeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return OWNER_TYPE_LABEL[code.trim().toUpperCase()] ?? code;
}

export function interestTypeLabel(code: string | null | undefined): string {
  const c = (code ?? "").trim().toUpperCase() as InterestType;
  return INTEREST_TYPE_LABEL[c] ?? (code ?? "");
}

export interface InterestTotal {
  type: InterestType;
  label: string;
  count: number;
  /** Sum of the decimal interests. NOT a share of one -- see the plan §0. */
  sum: number;
}

/**
 * Per-type totals over a lease's (or an owner's) interests.
 *
 * Sums are shown as sums. The roll lists what is taxed, so royalty on an
 * Archer lease clusters at 1/8 and working interest at 7/8; normalising either
 * to 100% would invent a title opinion the county never gave.
 */
export function interestTotals(
  rows: readonly { interest_type: string; interest: number }[]
): InterestTotal[] {
  return INTEREST_TYPES.map((type) => {
    const mine = rows.filter((r) => r.interest_type.trim().toUpperCase() === type);
    return {
      type,
      label: INTEREST_TYPE_LABEL[type],
      count: mine.length,
      // Rounded to the roll's own precision (8 places) so a sum of 0.125 does
      // not print as 0.12499999999999999.
      sum: Math.round(mine.reduce((s, r) => s + r.interest, 0) * 1e8) / 1e8,
    };
  });
}

/** A decimal interest as the roll prints it: six places. */
export function fmtInterest(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return x.toFixed(6);
}

/** A decimal interest as a percent, to the precision a fraction of 1/8 needs. */
export function fmtInterestPct(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const pct = x * 100;
  const digits = pct >= 10 ? 2 : pct >= 1 ? 3 : 4;
  return `${pct.toFixed(digits)}%`;
}

/** Appraised value in dollars, whole. */
export function fmtValue(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `$${Math.round(x).toLocaleString("en-US")}`;
}
