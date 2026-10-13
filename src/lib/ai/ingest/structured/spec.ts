import "server-only";

import { z } from "zod";

/**
 * The INTERPRETATION the model produces ONCE per structured upload: how to read
 * each row's CONTENT and turn it into a record. Unlike a rigid column map, this
 * classifies every row by what it actually contains — the record type lives in
 * the data (a single tank level is a pumper's READING; an opening + closing pair,
 * or a ticket marker, is a purchaser's RUN), not in which column it sits in. Code
 * executes the interpretation over every row; a verify/repair loop corrects it;
 * anything it still can't classify is escalated to direct model extraction. Every
 * field defaults, so a slightly-off reply still parses.
 */

/** A predicate evaluated against one row, used to classify it. Content-aware:
 * `levelCount` counts the tank-level values in a cell (the domain's real signal —
 * 1 = reading, 2 = run), `contains` matches text like "run"/"ticket"/"opening". */
export const ConditionSchema = z.object({
  kind: z
    .enum(["always", "present", "empty", "contains", "levelCount"])
    .catch("always")
    .default("always"),
  /** Column the predicate inspects (header text or 0-based index string). */
  column: z.string().nullable().default(null),
  /** Substring/regex for `contains` (case-insensitive). */
  pattern: z.string().nullable().default(null),
  /** Target count for `levelCount` (e.g. 2 → an opening+closing run). */
  equals: z.number().int().nullable().default(null),
});
export type Condition = z.infer<typeof ConditionSchema>;

/** One classification rule; the classifier is an ordered list, first match wins. */
export const ClassRuleSchema = z.object({
  when: ConditionSchema.default({ kind: "always", column: null, pattern: null, equals: null }),
  /** Resulting record type, or "skip" to drop the row (headers, totals, notes). */
  type: z.string().default("skip"),
});
export type ClassRule = z.infer<typeof ClassRuleSchema>;

/** How one field is pulled from a (possibly multi-value) source cell. */
export const FieldSourceSchema = z.object({
  field: z.string(),
  /** Source column (header text or index string); null for a constant. */
  column: z.string().nullable().default(null),
  transform: z
    .enum(["text", "number", "date", "time", "stickInches", "constant"])
    .catch("text")
    .default("text"),
  /** Which value to take when the cell holds several (e.g. an opening+closing run
   * cell): `first`/`second` by order, `max`/`min` by magnitude (opening is the
   * HIGHER level, closing the LOWER), `only` for a single-value cell. */
  pick: z.enum(["only", "first", "second", "max", "min"]).catch("only").default("only"),
  constant: z.string().nullable().default(null),
});
export type FieldSource = z.infer<typeof FieldSourceSchema>;

export const TypeExtractionSchema = z.object({
  type: z.string(),
  fields: z.array(FieldSourceSchema).default([]),
});
export type TypeExtraction = z.infer<typeof TypeExtractionSchema>;

export const InterpretationSchema = z.object({
  sheet: z.string().nullable().default(null),
  headerRow: z.number().int().min(0).catch(0).default(0),
  wellNames: z.array(z.string()).default([]),
  /** Ordered classification rules (first match wins). */
  classifier: z.array(ClassRuleSchema).default([]),
  /** Field extraction per record type. */
  types: z.array(TypeExtractionSchema).default([]),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;
