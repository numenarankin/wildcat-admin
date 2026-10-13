/**
 * Deterministic plausibility checks over `computed[]`.
 *
 * The tool layer is being built separately and some of it will be wrong. A tool
 * that returns a plausible-looking wrong number is the worst case in this whole
 * system: it survives every provenance rule, because it HAS inputs and a method,
 * and it lands in an answer an operator spends money on.
 *
 * Prompting Fable to be careful is not enough on its own — a model asked to
 * sanity-check its own inputs will do it inconsistently. So the arithmetic
 * checks live here, in code, and run on every turn:
 *
 *   RANGE       a saturation cannot exceed 1, a bulk density cannot be 0.4 g/cc
 *   UNIT        a v/v value of 15.2 is a percent that lost its conversion
 *   REDUNDANCY  crossplot porosity must lie between the density and neutron
 *               values it was derived from
 *
 * Findings become conflicts, which means Stage 2 escalates the turn rather than
 * the answer depending on Fable noticing. The model's job is then to explain
 * what does not add up, not to detect it.
 *
 * These are deliberately LOOSE. The point is catching a broken tool, not
 * second-guessing a geologist: every bound here is one that no real rock in any
 * basin can violate. A finding is evidence of a bug, not of unusual geology.
 */
import type { ComputedValue, Origin, ZoneEvaluationStore } from "./state";

const ORIGIN: Origin = { stage: "stage1", branch: "plausibility" };

interface Bound {
  /** Matches the `field` name, case-insensitively. */
  match: RegExp;
  min: number;
  max: number;
  /** Stated in domain terms — this text reaches the operator via Fable. */
  why: string;
}

/**
 * Physical bounds no rock can violate. Wider than any real reservoir on purpose:
 * a value outside these is a broken tool, not an unusual formation.
 */
const BOUNDS: Bound[] = [
  {
    match: /^(phi|porosity|phid|phin|phix|phie|phit)/i,
    min: 0,
    max: 0.45,
    why: "porosity cannot be negative, and no consolidated reservoir rock exceeds about 45%",
  },
  {
    match: /^(sw|so|sg|sh|sxo|shc)\b|saturation/i,
    min: 0,
    max: 1,
    why: "a saturation is a fraction of pore volume and cannot exceed 1",
  },
  { match: /^vsh|^vcl|shale.?volume/i, min: 0, max: 1, why: "a shale volume is a fraction and cannot exceed 1" },
  { match: /^(rt|rw|rxo|ro|rmf)\b|resistivity/i, min: 0.001, max: 100_000, why: "a resistivity must be positive" },
  { match: /^rhob|bulk.?density/i, min: 1, max: 3.2, why: "a bulk density outside 1.0-3.2 g/cc is not rock" },
  { match: /^gr\b|gamma/i, min: 0, max: 1000, why: "a gamma ray reading cannot be negative" },
  { match: /standoff/i, min: 0, max: 20_000, why: "a standoff cannot be negative" },
  { match: /critical.?rate|turner|coleman/i, min: 0, max: 1_000_000, why: "a critical rate cannot be negative" },
  { match: /thickness|net.?pay|gross/i, min: 0, max: 20_000, why: "a thickness cannot be negative" },
];

/** Fields whose unit says fraction. A value above 1 is a lost /100. */
const FRACTION_UNITS = /^(v\/v|frac|fraction|dec|decimal)$/i;
/** The same quantity reported the other way. Scaled before a fraction bound. */
const PERCENT_UNITS = /^(%|pct|percent|p\.u\.|pu)$/i;

export interface Implausibility {
  field: string;
  value: string;
  why: string;
}

/**
 * Check every computed value and record what does not add up.
 *
 * Returns the findings and writes each as a conflict, so a broken tool routes
 * the turn to the escalated path on its own.
 */
export function checkPlausibility(store: ZoneEvaluationStore): Implausibility[] {
  const state = store.snapshot();
  const found: Implausibility[] = [];

  const report = (field: string, value: string, why: string, branches: string[]) => {
    found.push({ field, value, why });
    store.addConflict(ORIGIN, {
      description: `"${field}" = ${value} is not physically possible: ${why}`,
      branches,
      resolvingDocument: null,
    });
  };

  for (const c of state.computed) {
    const bound = BOUNDS.find((b) => b.match.test(c.field));
    const percent = c.unit ? PERCENT_UNITS.test(c.unit) : false;
    let flagged = false;

    for (const n of numbers(c.value)) {
      if (flagged) break;
      // The unit check runs FIRST, because it is the more specific diagnosis of
      // the same symptom. A porosity of 15.2 labelled v/v trips the range bound
      // too, but "a percentage that was never converted" tells you where to look
      // and "porosity cannot exceed 45%" does not.
      if (c.unit && FRACTION_UNITS.test(c.unit) && n > 1) {
        report(
          c.field,
          format(c.value),
          `the unit is ${c.unit} but the value is above 1, which reads as a percentage that was never converted`,
          [`the calculation returned ${n} ${c.unit}`, `as a fraction this would be ${(n * 100).toFixed(0)}%`]
        );
        flagged = true;
        break;
      }
      // Compare like with like: a bound expressed as a fraction has to see a
      // fraction, so a value reported in percent is scaled before the check.
      const scaled = percent && bound && bound.max <= 1 ? n / 100 : n;
      if (bound && (scaled < bound.min || scaled > bound.max)) {
        report(c.field, format(c.value), bound.why, [
          `the calculation returned ${n}${c.unit ? ` ${c.unit}` : ""}`,
          `${bound.why} (expected ${bound.min} to ${bound.max})`,
        ]);
        flagged = true;
      }
    }
  }

  found.push(...crossplotCheck(store, state.computed));
  return found;
}

/**
 * Crossplot porosity is derived FROM the density and neutron values, so it must
 * lie between them. Outside that range is arithmetic, not geology — and unlike
 * the bounds above, this catches a tool whose output is individually plausible.
 */
function crossplotCheck(
  store: ZoneEvaluationStore,
  computed: ReturnType<ZoneEvaluationStore["snapshot"]>["computed"]
): Implausibility[] {
  const pick = (re: RegExp) => {
    for (let i = computed.length - 1; i >= 0; i--) {
      if (re.test(computed[i].field) && typeof computed[i].value === "number") return computed[i];
    }
    return undefined;
  };
  const d = pick(/^phid$|density.?porosity/i);
  const n = pick(/^phin$|neutron.?porosity/i);
  const x = pick(/^phix|crossplot/i);
  if (!d || !n || !x) return [];

  const dv = d.value as number;
  const nv = n.value as number;
  const xv = x.value as number;
  const lo = Math.min(dv, nv);
  const hi = Math.max(dv, nv);
  // A hair of tolerance: some crossplot forms are a root-mean-square rather than
  // a mean, which can sit a fraction outside the pair.
  if (xv >= lo - 0.01 && xv <= hi + 0.01) return [];

  store.addConflict(ORIGIN, {
    description: `crossplot porosity ${xv} lies outside the density (${dv}) and neutron (${nv}) values it is derived from`,
    branches: [
      `crossplot porosity computed as ${xv} by ${x.method}`,
      `its own inputs bound it to ${lo}-${hi}`,
    ],
    resolvingDocument: null,
  });
  return [{ field: x.field, value: String(xv), why: "a crossplot porosity must lie between its density and neutron inputs" }];
}

function numbers(value: ComputedValue): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "object") return [value.low, value.high];
  return [];
}

function format(value: ComputedValue): string {
  return typeof value === "object" ? `${value.low}-${value.high}` : String(value);
}
