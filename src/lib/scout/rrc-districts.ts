/**
 * RRC ships TWO district codings, and joining across them silently returns the
 * wrong lease.
 *
 * - **EWA** (`rrc.wellbore.district`) uses the real RRC district label:
 *   01-06, 6E, 7B, 7C, 08, 8A, 09, 10.
 * - **PDQ** (`lease_production`, `county_lease_cycle`, `lease_cycle_disp`,
 *   `well_completion`, `district_cycle`) uses a sequential internal code
 *   01-11, 13, 14, and carries the real label alongside it as `district_name`.
 *
 * The mapping is 1:1 and was verified across all 76,517,614 rows of
 * `county_lease_cycle`.
 *
 * WHY THIS MATTERS. The ingest runbook documents the join key as
 * `EWA (oil_gas_code, district, lease_number) -> PDQ lease cycle`. That is
 * WRONG: EWA district '09' joins to PDQ district_no '09', which is District 7C,
 * not District 09. It fails silently because a real lease usually exists on the
 * other side.
 *
 * Concretely: Borderline Operating's ANDREWS "A" (Archer County, EWA district
 * 09, lease 19365) is PDQ district_no **13**. Joining naively lands on PDQ
 * district_no 09 lease 19365 = PECK 20-29 SL in Upton County, operator 217012 —
 * a different operator, county and lease, with plausible-looking volumes. That
 * mismatch is the origin of the long-standing "golden record" of
 * 1,491 / 1,437 / 1,258 bbl: those are PECK's barrels wearing ANDREWS' name.
 * ANDREWS "A" actually produced 6,205 / 6,486 / 7,074 in 2026 Q1.
 *
 * Always translate. Never join the two codes directly.
 */

/** PDQ internal code -> real RRC district label. */
export const PDQ_TO_RRC: Record<string, string> = {
  "01": "01",
  "02": "02",
  "03": "03",
  "04": "04",
  "05": "05",
  "06": "06",
  "07": "6E",
  "08": "7B",
  "09": "7C",
  "10": "08",
  "11": "8A",
  "13": "09",
  "14": "10",
};

/** Real RRC district label -> PDQ internal code. */
export const RRC_TO_PDQ: Record<string, string> = Object.fromEntries(
  Object.entries(PDQ_TO_RRC).map(([pdq, rrc]) => [rrc, pdq])
);

/** PDQ code -> the district a user should be shown. */
export function districtLabel(pdqCode: string | null): string | null {
  if (!pdqCode) return null;
  return PDQ_TO_RRC[pdqCode] ?? pdqCode;
}

/** EWA/display district -> the code PDQ tables are keyed on. */
export function toPdqDistrict(rrcDistrict: string | null): string | null {
  if (!rrcDistrict) return null;
  return RRC_TO_PDQ[rrcDistrict] ?? rrcDistrict;
}
