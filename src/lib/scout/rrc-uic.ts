/**
 * Underground Injection Control — the RRC's code values, in domain words.
 *
 * No imports and no server-only marker on purpose: the modals render these
 * labels and the server queries use the same maps, so one copy serves both.
 *
 * Codes are from the RRC UIC manual (UIA010). Where a code is undocumented it
 * shows as the raw value rather than a guess, the same rule the well modal
 * follows for symbol and reliability.
 */

/**
 * UIC-TYPE-INJ. RRC renumbered these on 1995-06-01 and the file keeps both
 * vintages under the same column, so a permit approved before that date means
 * something different by code 5 than one approved after.
 *
 * Only 1-4 are stable across the change, and 1-3 are ~all of the file. The
 * labels below are the CURRENT scheme; `injTypeLabel` says so for the codes
 * where the two schemes disagree.
 */
export const INJ_TYPE: Record<string, string> = {
  "1": "Disposal into a non-productive zone (W-14)",
  "2": "Disposal into a productive zone (H-1)",
  "3": "Secondary or tertiary recovery",
  "4": "Miscellaneous",
  "5": "Liquid storage — salt formation",
  "6": "Gas storage — reservoir",
  "7": "Gas storage — salt formation",
};

/** Codes whose meaning changed on 1995-06-01 (see INJ_TYPE). */
const RENUMBERED = new Set(["4", "5", "6"]);
const RENUMBER_DATE = "1995-06-01";

/** Pre-1995 meanings, for permits approved before the renumbering. */
const INJ_TYPE_OLD: Record<string, string> = {
  "4": "Hydrocarbon storage",
  "5": "Gas storage",
  "6": "Miscellaneous",
};

export function injTypeLabel(
  code: string | null,
  approvedDate: string | null
): string | null {
  if (!code) return null;
  if (
    RENUMBERED.has(code) &&
    approvedDate &&
    approvedDate < RENUMBER_DATE &&
    INJ_TYPE_OLD[code]
  ) {
    return INJ_TYPE_OLD[code];
  }
  return INJ_TYPE[code] ?? `Type ${code}`;
}

/** True for the two disposal types — where produced water actually goes. */
export function isDisposal(code: string | null): boolean {
  return code === "1" || code === "2";
}

/** UIC-CLASS. Class 2 is oil-and-gas injection; class 5 is storage/geothermal. */
export const UIC_CLASS: Record<string, string> = {
  "2": "Injection / disposal",
  "5": "Storage, geothermal or brine",
};

/** UIC-INJ-MODE. */
export const INJ_MODE: Record<string, string> = {
  C: "Casing",
  T: "Tubing",
};

/**
 * The 14 permitted-fluid flags, in the order UIC-INJ-FLUIDS stores them.
 *
 * `key` matches the column name so a row can be walked without a second map.
 */
export const FLUIDS: { key: string; label: string }[] = [
  { key: "inj_saltwater", label: "Salt water" },
  { key: "inj_fresh_water", label: "Fresh water" },
  { key: "inj_frac_water", label: "Frac water" },
  { key: "inj_norm", label: "NORM" },
  { key: "inj_co2", label: "CO₂" },
  { key: "inj_gas", label: "Gas" },
  { key: "inj_h2s", label: "H₂S" },
  { key: "inj_polymer", label: "Polymer" },
  { key: "inj_steam", label: "Steam" },
  { key: "inj_air", label: "Air" },
  { key: "inj_nitrogen", label: "Nitrogen" },
  { key: "inj_other", label: "Other" },
  { key: "inj_brackish_water", label: "Brackish water" },
  { key: "inj_lpg", label: "LPG" },
];

/** The permitted fluids on a row, as labels. */
export function fluidLabels(row: Record<string, unknown>): string[] {
  return FLUIDS.filter((f) => row[f.key] === true).map((f) => f.label);
}


/*
 * ---------------------------------------------------------------- H-15
 *
 * The inactive-well test. Codes are the RRC's, from WBA091; anything outside
 * the domain shows as the raw letter rather than a guess.
 */

export const H15_STATUS: Record<string, string> = {
  A: "Approved",
  C: "Compliant",
  D: "Delinquent",
  N: "Not approved",
  P: "Pending approval",
  W: "W-3A extension",
  U: "UIC",
  E: "No test — project extension",
  X: "W-1X denied",
};

/** Statuses that mean the well is NOT in good standing on its H-15. */
export function isH15Problem(status: string | null): boolean {
  return status === "D" || status === "N" || status === "X";
}

export const H15_TEST_TYPE: Record<string, string> = {
  F: "Fluid level",
  M: "Mechanical integrity",
};

/** How a fluid-level test was run. */
export const H15_FLUID_METHOD: Record<string, string> = {
  W: "wireline",
  S: "sonic",
  V: "visual",
  O: "other",
};

/** How a mechanical-integrity test was run. */
export const H15_MECH_METHOD: Record<string, string> = {
  H: "hydraulic pressure",
  O: "other",
};

/** The method a test used, in words, whichever kind it was. */
export function h15Method(
  testType: string | null,
  fluidMethod: string | null,
  mechMethod: string | null
): string | null {
  if (testType === "F") return H15_FLUID_METHOD[fluidMethod ?? ""] ?? null;
  if (testType === "M") return H15_MECH_METHOD[mechMethod ?? ""] ?? null;
  return null;
}

/** Cement quantity unit, per WB-CEMENT-MEASUREMENT. */
export const CEMENT_MEASURE: Record<string, string> = {
  S: "sacks",
  Y: "cu yd",
  F: "cu ft",
};

/**
 * Casing OD as an operator says it: 5.5 -> `5 1/2"`.
 *
 * The RRC stores the fraction and this puts it back, because "8.625 in" is not
 * how anyone in the field refers to eight-and-five-eighths casing.
 */
export function casingLabel(sizeIn: number | null): string | null {
  if (sizeIn == null) return null;
  const whole = Math.floor(sizeIn);
  const frac = sizeIn - whole;
  if (frac < 0.001) return `${whole}"`;
  // Sixteenths cover every pipe size the RRC records.
  const sixteenths = Math.round(frac * 16);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(sixteenths, 16);
  return `${whole} ${sixteenths / g}/${16 / g}"`;
}

/** W-10 producing method. 'B' (swab) is in the data and absent from OLA001. */
/**
 * `wb_plug.well_type` — what the hole was when it was plugged, from the W-3.
 *
 * Not the same domain as EWA's `well_type_name`: this is the four-way
 * classification the plugging form uses, and "dry" only ever appears here
 * because a well that never produced has no EWA status to carry.
 */
export const PLUG_WELL_TYPE: Record<string, string> = {
  O: "Oil",
  G: "Gas",
  D: "Dry hole",
  S: "Service",
};

export const W10_METHOD: Record<string, string> = {
  P: "Pumping",
  G: "Gas lift",
  F: "Flowing",
  B: "Swab",
  V: "Vacuum",
  S: "Steam injection",
  H: "Secondary heat injection",
  C: "Carbon dioxide",
  O: "Other",
};

/*
 * ----------------------------------------------------------------- P-4
 */

/** P4-GPN-PRODUCT-CODE. */
export const P4_PRODUCT: Record<string, string> = {
  F: "Full well stream",
  G: "Gas well gas",
  H: "Condensate",
  O: "Oil",
  P: "Casinghead gas",
};

/** P4-GPN-TYPE-CODE — the role, not the company. */
export const P4_ROLE: Record<string, string> = {
  G: "Gatherer",
  H: "Purchaser",
  I: "Nominator",
};

/** P4-TYPE-RECORD. 'D' is an RRC dummy and never reaches the UI. */
export const P4_RECORD_TYPE: Record<string, string> = {
  O: "Original questionnaire",
  R: "Regular",
  A: "Automatic change",
  T: "Filed on tape",
  B: "Bridged",
};
