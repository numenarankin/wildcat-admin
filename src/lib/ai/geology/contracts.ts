/**
 * What Stage 0 asks of the tool layer.
 *
 * These are the harness's REQUIREMENTS, not the tools' implementations — the
 * catalog is being built separately. Anything registered under these names must
 * satisfy these schemas; anything that does, Stage 0 can use. That is the whole
 * arrangement, and it is why Stage 0 is testable today.
 *
 * Named for the catalog entries they correspond to. Where a tool takes no
 * arguments beyond the subject well, its input is `{}` — the well is in
 * `ToolContext`, so it is not repeated as an argument anyone could disagree with.
 */
import { z } from "zod";
import { DATUM_REFERENCES } from "./state";

export const TOOL = {
  // Stage 0
  lasHeader: "las_header",
  lasCurves: "las_curves",
  mnemonicNormalize: "mnemonic_normalize",
  /**
   * The rest of the deterministic layer, by name.
   *
   * Not a Stage 0 requirement — Stage 0 asks for specific shapes and this
   * returns whatever the named tool returns. It is here because it is the one
   * name the registry, the prompt and the bridge all have to agree on.
   */
  petrophysics: "petrophysics",
  rrcCompletionRecord: "rrc_completion_record",
  curveSuite: "curve_suite",
  holeQuality: "hole_quality",
  // Stage 1
  kbLookup: "kb_lookup",
  calculators: "calculators",
  offsetsWithinRadius: "offsets_within_radius",
  continuityCheck: "continuity_check",
} as const;

export const noArgs = z.object({});

/**
 * The `~WELL` and `~PARAMETER` sections, and nothing else.
 *
 * Separate from the curve read on purpose: it is cheap, and Stage 1's RRC
 * branches cannot start without location and elevation. Reading the whole file
 * first would put the full parse in front of every offset query for no reason.
 */
export const headerSchema = z.object({
  api: z.string().nullable(),
  name: z.string().nullable(),
  operator: z.string().nullable(),
  county: z.string().nullable(),
  district: z.string().nullable(),
  /** Kelly bushing elevation. Null when the file does not carry EKB. */
  kbFt: z.number().finite().nullable(),
  /** Ground level. */
  glFt: z.number().finite().nullable(),
  /** Permanent datum. */
  epdFt: z.number().finite().nullable(),
  /** What the file's depths are measured from, when it says. */
  reference: z.enum(DATUM_REFERENCES).nullable(),
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
  startFt: z.number().finite().nullable(),
  stopFt: z.number().finite().nullable(),
  stepFt: z.number().finite().nullable(),
  nullValue: z.number().finite().nullable(),
  /**
   * The rest of the ~PARAMETER block the harness actually uses.
   *
   * Optional because they are optional in the file — but without `bitSizeIn`
   * every caliper gate in `hole_quality` declines for the whole log, and the
   * branch reports no washouts on a log that has them.
   */
  bitSizeIn: z.number().finite().nullable().optional(),
  casingShoeFt: z.number().finite().nullable().optional(),
  bhtDegF: z.number().finite().nullable().optional(),
  rmfOhmm: z.number().finite().nullable().optional(),
  rmfTempDegF: z.number().finite().nullable().optional(),
});
export type HeaderFacts = z.infer<typeof headerSchema>;

export const curvesSchema = z.object({
  curves: z.array(
    z.object({
      mnemonic: z.string().min(1),
      unit: z.string().nullable(),
      description: z.string().nullable(),
    })
  ),
  rowCount: z.number().int().nonnegative(),
});
export type CurvesFacts = z.infer<typeof curvesSchema>;

/**
 * Mnemonic normalization against a dictionary we own.
 *
 * `canonical: null` is a legal, expected answer. An unknown mnemonic is flagged
 * and kept, never guessed — a curve silently mapped to the wrong canonical name
 * poisons every calculation downstream of it and looks exactly like a correct
 * mapping.
 */
export const mnemonicSchema = z.object({
  raw: z.string(),
  canonical: z.string().nullable(),
  unit: z.string().nullable(),
});
export type MnemonicFacts = z.infer<typeof mnemonicSchema>;

/** The W-2 / G-1 fields Stage 0 cross-checks the LAS datum against. */
export const completionRecordSchema = z.object({
  api: z.string(),
  kbFt: z.number().finite().nullable(),
  glFt: z.number().finite().nullable(),
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
  /** Which RRC form the numbers came off. */
  form: z.string().nullable(),
});
export type CompletionRecord = z.infer<typeof completionRecordSchema>;

/** One computed curve-math result, in the shape `computed[]` wants. */
export const computedValueOutSchema = z.object({
  field: z.string().min(1),
  value: z.union([z.number(), z.string(), z.object({ low: z.number(), high: z.number() })]),
  unit: z.string().nullable(),
  inputs: z.array(
    z.object({
      name: z.string(),
      value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
      source: z.string().nullable(),
    })
  ).min(1),
  method: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
});

/** phiD, phiN, crossplot porosity, Vsh, Archie Sw — the standard suite. */
export const curveSuiteSchema = z.object({
  values: z.array(computedValueOutSchema),
  /** Defaults the suite had to assume, so they land in `assumptions[]`. */
  assumptions: z.array(
    z.object({
      field: z.string().min(1),
      value: z.union([z.number(), z.string()]),
      basis: z.string().min(1),
    })
  ),
});
export type CurveSuiteFacts = z.infer<typeof curveSuiteSchema>;

/* ------------------------------------------------------------------ *
 * Stage 1 — the fan-out branches
 * ------------------------------------------------------------------ */

/**
 * Keyed dictionary reads: formation to Geolex, county to basin prior, lithology
 * to matrix constant.
 *
 * These are free and instant, which is why they are worth having — but they are
 * a source that sits BESIDE the gatherer, not a cheaper path that replaces it.
 * A dictionary hit means a formation name resolved; it says nothing about
 * whether the corpus holds the passage answering the operator's actual question.
 */
export const kbLookupSchema = z.object({
  assumptions: z.array(
    z.object({
      field: z.string().min(1),
      value: z.union([z.number(), z.string()]),
      basis: z.string().min(1),
    })
  ),
  facts: z.array(z.object({ claim: z.string().min(1), sourceId: z.string().min(1) })),
});
export type KbLookupFacts = z.infer<typeof kbLookupSchema>;

/** Turner/Coleman, coning critical rate, gas gradient, column height, standoff. */
export const calculatorsSchema = z.object({
  values: z.array(computedValueOutSchema),
});
export type CalculatorFacts = z.infer<typeof calculatorsSchema>;

/**
 * Spatial query against the RRC data.
 *
 * Bounded on purpose: an unbounded offset query is the most likely way this
 * pipeline blows its latency budget, and "which offsets to examine" being a
 * bounded query is what lets the model choose without being able to choose
 * badly.
 */
export const DEFAULT_RADIUS_FT = 5_280;
export const MAX_RADIUS_FT = 5 * 5_280;
export const MAX_OFFSETS = 25;

export const offsetsInputSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  radiusFt: z.number().positive().max(MAX_RADIUS_FT),
  limit: z.number().int().positive().max(MAX_OFFSETS),
});

export const offsetsSchema = z.object({
  offsets: z.array(
    z.object({
      api: z.string().min(1),
      distanceFt: z.number().nonnegative(),
      picks: z.array(z.object({ formation: z.string(), depthFt: z.number(), reference: z.enum(DATUM_REFERENCES) })),
      dst: z.array(z.object({ interval: z.string(), result: z.string() })),
      datumResolved: z.boolean(),
    })
  ),
  /** Set when the radius or limit cut results off. Never truncate silently. */
  truncated: z.boolean(),
});
export type OffsetsFacts = z.infer<typeof offsetsSchema>;

/** Depth-wise consistency, curve splice detection, implausible transitions. */
export const continuitySchema = z.object({
  findings: z.array(
    z.object({
      description: z.string().min(1),
      topFt: z.number().nullable(),
      baseFt: z.number().nullable(),
      severity: z.enum(["note", "suspect"]),
    })
  ),
});
export type ContinuityFacts = z.infer<typeof continuitySchema>;

/** Caliper against bit size, per-depth washout. */
export const holeQualitySchema = z.object({
  bitSizeIn: z.number().finite().nullable(),
  washouts: z.array(
    z.object({
      topFt: z.number().finite(),
      baseFt: z.number().finite(),
      maxExcessIn: z.number().finite(),
    })
  ),
  /** True when density-derived porosity is suppressed somewhere in the log. */
  densityPorositySuppressed: z.boolean(),
});
export type HoleQualityFacts = z.infer<typeof holeQualitySchema>;
