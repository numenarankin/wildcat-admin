/**
 * The Zone Evaluation State — the single source of truth for a geology turn.
 *
 * See geology-agent/well-log-agent.md ("Core object") and
 * geology-agent/harness-implementation.md (Phase 1). The conversation is NOT
 * state: everything the harness knows about a well lives here, every stage reads
 * and writes it, and the answer the operator reads is derived from it.
 *
 * This module is deliberately more than a type. Both sample analyses that
 * motivated the whole design failed the same way — confident prose resting on
 * numbers whose inputs nobody could name — so the invariants that would have
 * caught that are enforced here, in code, at the point of writing:
 *
 *   - No value without its inputs and method.       (`addComputed`)
 *   - No depth without a well and a datum reference.(`depth`)
 *   - Nothing the user SAID becomes something measured. (`addEvidence`)
 *   - No silent overwrite when two branches disagree.   (recorded as a conflict)
 *
 * Writes are append-only and each carries the stage that made it, so the
 * trajectory log is a read of this object rather than a second structure kept in
 * step with it.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/** Depth reference. KB = kelly bushing, GL = ground level, DF = drill floor. */
export const DATUM_REFERENCES = ["KB", "GL", "DF"] as const;
export type DatumReference = (typeof DATUM_REFERENCES)[number];

/**
 * How we know a thing.
 *   measured   - came off an instrument or a log curve
 *   documented - written in a record (W-2, completion report, scout card)
 *   stated     - a human told us
 *
 * The ordering is load-bearing: `stated` may never be re-asserted as
 * `measured`. An operator's recollection that "it made 40 barrels" is not a
 * measurement, and the moment it is recorded as one, nothing downstream can tell
 * the difference.
 */
export const EVIDENCE_KINDS = ["measured", "documented", "stated"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const ASSUMPTION_SOURCES = ["default", "user", "derived"] as const;
export type AssumptionSource = (typeof ASSUMPTION_SOURCES)[number];

/** Which stage of the harness made a write. Also the trajectory log's grouping. */
export const STAGES = ["stage0", "stage1", "stage2", "stage3", "stage4"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Who wrote it. Stage 1 fans out and its branches run concurrently, so "which
 * stage" is not specific enough to explain a disagreement — the branch is.
 */
export interface Origin {
  stage: Stage;
  /** Fan-out branch, persona, or tool name. Free-form; it is for humans. */
  branch?: string;
}

/** Thrown when a write would break an invariant. Never caught internally. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

export const wellSchema = z.object({
  api: z.string().min(1),
  name: z.string().nullable(),
  operator: z.string().nullable(),
  county: z.string().nullable(),
  district: z.string().nullable(),
});
export type Well = z.infer<typeof wellSchema>;

/**
 * A depth. Never a bare number anywhere in this object.
 *
 * `ft` is meaningless without knowing whose hole it is in and what it is
 * measured from — a 4,110 ft pick on a KB datum and a 4,110 ft pick on a GL
 * datum are different rocks, and comparing them across two wells is precisely
 * how the sample analyses produced two irreconcilable structural maps.
 */
export const depthSchema = z.object({
  ft: z.number().finite(),
  api: z.string().min(1),
  reference: z.enum(DATUM_REFERENCES),
  /** True once converted to subsea; `ft` is then negative-down elevation. */
  subsea: z.boolean().default(false),
});
export type Depth = z.infer<typeof depthSchema>;

export const datumSchema = z.object({
  kbFt: z.number().finite().nullable(),
  glFt: z.number().finite().nullable(),
  reference: z.enum(DATUM_REFERENCES).nullable(),
  /** Where the numbers came from: "~PARAMETER EKB", "RRC W-2", "user". */
  source: z.string().nullable(),
  /**
   * False whenever the datum is missing OR the LAS and the RRC record disagree.
   * A hard state, not a caveat: the structural gate reads this field.
   */
  resolved: z.boolean(),
});
export type Datum = z.infer<typeof datumSchema>;

export const intervalSchema = z.object({
  topMd: depthSchema,
  baseMd: depthSchema,
  topSs: depthSchema.nullable(),
  baseSs: depthSchema.nullable(),
});
export type Interval = z.infer<typeof intervalSchema>;

export const curveSchema = z.object({
  mnemonicRaw: z.string().min(1),
  /** Null when the mnemonic is unrecognized. Never guessed. */
  mnemonicCanonical: z.string().nullable(),
  unit: z.string().nullable(),
  source: z.string().min(1),
  /** True when normalization failed; the curve is usable but unidentified. */
  flagged: z.boolean(),
});
export type Curve = z.infer<typeof curveSchema>;

/** One named input to a computed value, with where it came from. */
export const computedInputSchema = z.object({
  name: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  /** Curve mnemonic, assumption key, tool name, or record ID. */
  source: z.string().nullable(),
});
export type ComputedInput = z.infer<typeof computedInputSchema>;

/**
 * A value, or a range.
 *
 * Ranges are not a nicety. Several gates are specified to return a band rather
 * than a number — Sw without Rw provenance, standoff across an uncertain KB —
 * and a range with a named resolution step beats a confident wrong number.
 */
export const computedValueSchema = z.union([
  z.number(),
  z.string(),
  z.object({ low: z.number(), high: z.number() }),
]);
export type ComputedValue = z.infer<typeof computedValueSchema>;

export const computedSchema = z.object({
  field: z.string().min(1),
  value: computedValueSchema,
  unit: z.string().nullable(),
  inputs: z.array(computedInputSchema).min(1),
  method: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
});
export type ComputedInit = z.infer<typeof computedSchema>;
export type Computed = ComputedInit & { origin: Origin; seq: number };

export const assumptionSchema = z.object({
  field: z.string().min(1),
  value: z.union([z.number(), z.string()]),
  source: z.enum(ASSUMPTION_SOURCES),
  /** Human-readable provenance: "Bend Arch default", "user said", "Geolex". */
  basis: z.string().min(1),
  overridable: z.boolean(),
});
export type AssumptionInit = z.infer<typeof assumptionSchema>;
export type Assumption = AssumptionInit & { origin: Origin; seq: number };

export const offsetSchema = z.object({
  api: z.string().min(1),
  distanceFt: z.number().nonnegative(),
  picks: z.array(z.object({ formation: z.string(), depth: depthSchema })),
  dst: z.array(z.object({ interval: z.string(), result: z.string() })),
  datumResolved: z.boolean(),
});
export type OffsetInit = z.infer<typeof offsetSchema>;
export type Offset = OffsetInit & { origin: Origin; seq: number };

export const evidenceSchema = z.object({
  claim: z.string().min(1),
  sourceId: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
});
export type EvidenceInit = z.infer<typeof evidenceSchema>;
export type Evidence = EvidenceInit & { origin: Origin; seq: number };

export const conflictSchema = z.object({
  description: z.string().min(1),
  /** The incompatible readings. Two or more, or it is not a conflict. */
  branches: z.array(z.string()).min(2),
  /** The one document that would collapse it, when there is one. */
  resolvingDocument: z.string().nullable(),
});
export type ConflictInit = z.infer<typeof conflictSchema>;
export type Conflict = ConflictInit & { origin: Origin; seq: number };

export const openItemSchema = z.object({
  question: z.string().min(1),
  blocking: z.boolean(),
});
export type OpenItemInit = z.infer<typeof openItemSchema>;
export type OpenItem = OpenItemInit & { origin: Origin; seq: number };

/**
 * A gate refusing to produce a value.
 *
 * The four gates live in the tools now (see Stage 4), so a refusal arrives as a
 * tool result during the model's turn rather than blocking a renderer after it.
 * Recording it here is what makes "the answer responded to the refusal"
 * assertable, and feeds the inconsistency metric.
 */
export const refusalSchema = z.object({
  gate: z.string().min(1),
  tool: z.string().min(1),
  reason: z.string().min(1),
  /** What would unblock it: "pull the W-2", "run a Pickett plot". */
  remedy: z.string().min(1),
});
export type RefusalInit = z.infer<typeof refusalSchema>;
export type Refusal = RefusalInit & { origin: Origin; seq: number };

/**
 * One tool call and what it returned.
 *
 * Every call is recorded — the harness's automatic fan-out branches and the
 * gatherer's own requests alike — because Fable is handed exactly what ran and
 * what came back, and because Fable is expected to show its work in the answer.
 * A number it cannot trace to one of these entries is a number it should not
 * have written.
 */
export const toolCallSchema = z.object({
  tool: z.string().min(1),
  args: z.unknown(),
  /** How the tool says it got its answer. Carried into any citation. */
  method: z.string().min(1),
  ok: z.boolean(),
  /** Exactly what came back. Not summarized. */
  output: z.unknown(),
  refused: z
    .object({ gate: z.string(), reason: z.string(), remedy: z.string() })
    .nullable(),
  /** Who asked for it: the harness's fixed branches, the gatherer, or Fable. */
  requestedBy: z.enum(["harness", "gatherer", "fable"]),
  error: z.string().nullable(),
});
export type ToolCallInit = z.infer<typeof toolCallSchema>;
export type ToolCall = ToolCallInit & { origin: Origin; seq: number };

/** The whole object, as read by anything downstream. */
export interface ZoneEvaluation {
  well: Well;
  datum: Datum;
  interval: Interval | null;
  curves: readonly Curve[];
  computed: readonly Computed[];
  assumptions: readonly Assumption[];
  offsets: readonly Offset[];
  evidence: readonly Evidence[];
  conflicts: readonly Conflict[];
  open: readonly OpenItem[];
  refusals: readonly Refusal[];
  toolCalls: readonly ToolCall[];
}

/** One entry in the trajectory log. Every write produces exactly one. */
export interface JournalEntry {
  seq: number;
  origin: Origin;
  action: string;
  detail: string;
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

/** Same field, same inputs, different answer — a determinism violation. */
function sameInputs(a: readonly ComputedInput[], b: readonly ComputedInput[]): boolean {
  if (a.length !== b.length) return false;
  const key = (i: ComputedInput) => `${i.name}=${String(i.value)}@${i.source ?? ""}`;
  const as = a.map(key).sort();
  const bs = b.map(key).sort();
  return as.every((k, idx) => k === bs[idx]);
}

function valueEqual(a: ComputedValue, b: ComputedValue): boolean {
  if (typeof a === "object" && typeof b === "object") return a.low === b.low && a.high === b.high;
  return a === b;
}

function describeOrigin(o: Origin): string {
  return o.branch ? `${o.stage}:${o.branch}` : o.stage;
}

/**
 * Append-only, stage-attributed, invariant-checked writes.
 *
 * Every mutation goes through `record`, which is what makes the journal
 * complete by construction — there is no field assignment path that skips it.
 * Stage 1's branches write concurrently, so this must stay safe under
 * interleaving: it is, because nothing here reads-modifies-writes an array, and
 * the two scalar slots (`datum`, `interval`) route a second differing write into
 * `conflicts` instead of overwriting.
 */
export class ZoneEvaluationStore {
  private well: Well;
  private datum: Datum;
  private interval: Interval | null = null;
  private readonly curves: Curve[] = [];
  private readonly computed: Computed[] = [];
  private readonly assumptions: Assumption[] = [];
  private readonly offsets: Offset[] = [];
  private readonly evidence: Evidence[] = [];
  private readonly conflicts: Conflict[] = [];
  private readonly open: OpenItem[] = [];
  private readonly refusals: Refusal[] = [];
  private readonly toolCalls: ToolCall[] = [];
  private readonly log: JournalEntry[] = [];
  private seq = 0;

  constructor(well: Well) {
    this.well = wellSchema.parse(well);
    this.datum = {
      kbFt: null,
      glFt: null,
      reference: null,
      source: null,
      resolved: false,
    };
  }

  /**
   * Rebuild a store from a cached snapshot.
   *
   * The journal deliberately starts empty. A cache hit means Stage 0's work
   * happened on some earlier turn, and replaying its journal here would claim
   * this turn did work it did not do — the trajectory log for a cached turn
   * correctly begins at the cache read. `seq` continues past the restored
   * entries so new writes never collide with restored ones.
   */
  static restore(snapshot: ZoneEvaluation): ZoneEvaluationStore {
    const s = new ZoneEvaluationStore(snapshot.well);
    s.datum = { ...snapshot.datum };
    s.interval = snapshot.interval ? structuredClone(snapshot.interval) : null;
    s.curves.push(...snapshot.curves);
    s.computed.push(...snapshot.computed);
    s.assumptions.push(...snapshot.assumptions);
    s.offsets.push(...snapshot.offsets);
    s.evidence.push(...snapshot.evidence);
    s.conflicts.push(...snapshot.conflicts);
    s.open.push(...snapshot.open);
    s.refusals.push(...snapshot.refusals);
    s.toolCalls.push(...snapshot.toolCalls);
    const seqs = [
      ...snapshot.computed, ...snapshot.assumptions, ...snapshot.offsets,
      ...snapshot.evidence, ...snapshot.conflicts, ...snapshot.open, ...snapshot.refusals,
      ...snapshot.toolCalls,
    ].map((e) => e.seq);
    s.seq = seqs.length > 0 ? Math.max(...seqs) : 0;
    return s;
  }

  private record(origin: Origin, action: string, detail: string): number {
    const seq = ++this.seq;
    this.log.push({ seq, origin, action, detail });
    return seq;
  }

  /**
   * Build a depth. The only way to get one, so a bare number cannot leak in.
   *
   * Defaults the API to this well's — an unqualified depth in a geology turn is
   * almost always about the subject well, and forcing every caller to restate it
   * invites the copy-paste that puts an offset's depth on the subject well.
   */
  depth(ft: number, reference: DatumReference | null, opts: { api?: string; subsea?: boolean } = {}): Depth {
    if (!Number.isFinite(ft)) throw new InvariantError(`depth: ${ft} is not a finite number`);
    if (!reference) {
      throw new InvariantError(
        `depth ${ft}: no datum reference. A depth without a reference cannot be compared to any other depth.`
      );
    }
    const api = opts.api ?? this.well.api;
    if (!api) throw new InvariantError(`depth ${ft}: no well API`);
    return { ft, api, reference, subsea: opts.subsea ?? false };
  }

  setWell(origin: Origin, patch: Partial<Well>): void {
    const next = wellSchema.parse({ ...this.well, ...patch });
    if (next.api !== this.well.api) {
      throw new InvariantError(
        `well API cannot change (${this.well.api} -> ${next.api}); a new well is a new evaluation`
      );
    }
    this.well = next;
    this.record(origin, "setWell", Object.keys(patch).join(","));
  }

  /**
   * Set the datum. A second, differing write records a conflict and keeps the
   * first — the LAS header and the RRC W-2 disagreeing is a real and common
   * case, and it is the exact thing the structural gate must be able to see.
   */
  setDatum(origin: Origin, next: Datum): void {
    const parsed = datumSchema.parse(next);
    const prior = this.datum;
    const written = prior.source !== null || prior.kbFt !== null || prior.glFt !== null;
    const differs =
      prior.kbFt !== parsed.kbFt || prior.glFt !== parsed.glFt || prior.reference !== parsed.reference;

    if (written && differs) {
      this.addConflict(origin, {
        description: `Datum disagreement on ${this.well.api}: ${prior.source ?? "unknown"} says KB ${prior.kbFt ?? "?"} / GL ${prior.glFt ?? "?"}, ${parsed.source ?? "unknown"} says KB ${parsed.kbFt ?? "?"} / GL ${parsed.glFt ?? "?"}`,
        branches: [
          `${prior.source ?? "unknown"}: KB ${prior.kbFt ?? "?"}, GL ${prior.glFt ?? "?"}, ref ${prior.reference ?? "?"}`,
          `${parsed.source ?? "unknown"}: KB ${parsed.kbFt ?? "?"}, GL ${parsed.glFt ?? "?"}, ref ${parsed.reference ?? "?"}`,
        ],
        resolvingDocument: "RRC W-2 / G-1 for this API",
      });
      // Unresolved wins regardless of which write got here first.
      this.datum = { ...prior, resolved: false };
      this.record(origin, "setDatum", "conflict; datum marked unresolved");
      return;
    }
    this.datum = parsed;
    this.record(origin, "setDatum", `${parsed.source ?? "unknown"} resolved=${parsed.resolved}`);
  }

  setInterval(origin: Origin, next: Interval): void {
    const parsed = intervalSchema.parse(next);
    if (parsed.topMd.api !== parsed.baseMd.api) {
      throw new InvariantError(
        `interval spans two wells (${parsed.topMd.api} / ${parsed.baseMd.api})`
      );
    }
    if (parsed.topMd.reference !== parsed.baseMd.reference) {
      throw new InvariantError(
        `interval top and base are on different references (${parsed.topMd.reference} / ${parsed.baseMd.reference})`
      );
    }
    if (parsed.baseMd.ft <= parsed.topMd.ft) {
      throw new InvariantError(
        `interval base ${parsed.baseMd.ft} is not below top ${parsed.topMd.ft}`
      );
    }
    const prior = this.interval;
    if (prior && (prior.topMd.ft !== parsed.topMd.ft || prior.baseMd.ft !== parsed.baseMd.ft)) {
      this.addConflict(origin, {
        description: `Two intervals proposed for ${this.well.api}: ${prior.topMd.ft}-${prior.baseMd.ft} and ${parsed.topMd.ft}-${parsed.baseMd.ft}`,
        branches: [
          `${prior.topMd.ft}-${prior.baseMd.ft} ${prior.topMd.reference}`,
          `${parsed.topMd.ft}-${parsed.baseMd.ft} ${parsed.topMd.reference}`,
        ],
        resolvingDocument: null,
      });
      this.record(origin, "setInterval", "conflict; first interval kept");
      return;
    }
    this.interval = parsed;
    this.record(origin, "setInterval", `${parsed.topMd.ft}-${parsed.baseMd.ft} ${parsed.topMd.reference}`);
  }

  /**
   * Record a computed value. Refuses anything without inputs and a method.
   *
   * This is the invariant that matters most. A porosity with no stated matrix
   * constant reads exactly like one with a correct matrix constant, and both
   * sample analyses ran on unstated assumptions — which is why they diverged and
   * why neither could be checked.
   */
  addComputed(origin: Origin, init: ComputedInit): Computed {
    const parsed = computedSchema.safeParse(init);
    if (!parsed.success) {
      const why = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new InvariantError(`computed "${init.field}" rejected — ${why}`);
    }
    const value = parsed.data;

    // Same field, same inputs, different answer. One of the two is wrong and we
    // cannot tell which, so record it rather than let the later write win.
    const clash = this.computed.find(
      (c) => c.field === value.field && sameInputs(c.inputs, value.inputs) && !valueEqual(c.value, value.value)
    );
    if (clash) {
      this.addConflict(origin, {
        description: `"${value.field}" computed twice from identical inputs with different results`,
        branches: [
          `${describeOrigin(clash.origin)} via ${clash.method}: ${JSON.stringify(clash.value)}`,
          `${describeOrigin(origin)} via ${value.method}: ${JSON.stringify(value.value)}`,
        ],
        resolvingDocument: null,
      });
    }

    const entry: Computed = { ...value, origin, seq: this.record(origin, "addComputed", value.field) };
    this.computed.push(entry);
    return entry;
  }

  addAssumption(origin: Origin, init: AssumptionInit): Assumption {
    const value = assumptionSchema.parse(init);
    const entry: Assumption = {
      ...value,
      origin,
      seq: this.record(origin, "addAssumption", `${value.field}=${value.value} (${value.source})`),
    };
    this.assumptions.push(entry);
    return entry;
  }

  addCurve(origin: Origin, init: Curve): Curve {
    const value = curveSchema.parse(init);
    if (value.mnemonicCanonical === null && !value.flagged) {
      throw new InvariantError(
        `curve ${value.mnemonicRaw}: unrecognized mnemonics must be flagged, never guessed`
      );
    }
    this.curves.push(value);
    this.record(origin, "addCurve", `${value.mnemonicRaw}${value.flagged ? " (flagged)" : ""}`);
    return value;
  }

  addOffset(origin: Origin, init: OffsetInit): Offset {
    const value = offsetSchema.parse(init);
    if (value.api === this.well.api) {
      throw new InvariantError(`offset ${value.api} is the subject well`);
    }
    const entry: Offset = {
      ...value,
      origin,
      seq: this.record(origin, "addOffset", `${value.api} @ ${value.distanceFt} ft`),
    };
    this.offsets.push(entry);
    return entry;
  }

  /**
   * Record evidence. A claim already on record as `stated` can never be
   * re-recorded as `measured`.
   *
   * The load-bearing example is the one from the sample case: "4110-18, not
   * shot, SW on DST, scared them" is something a person said. It is good
   * evidence and it belongs in the object — but the moment it is filed as a
   * measurement, no downstream reader can weigh it correctly again.
   */
  addEvidence(origin: Origin, init: EvidenceInit): Evidence {
    const value = evidenceSchema.parse(init);
    const prior = this.evidence.find((e) => e.claim === value.claim && e.sourceId === value.sourceId);
    if (prior && prior.kind === "stated" && value.kind !== "stated") {
      throw new InvariantError(
        `evidence "${value.claim}" (${value.sourceId}) was stated; it cannot be re-recorded as ${value.kind}`
      );
    }
    const entry: Evidence = {
      ...value,
      origin,
      seq: this.record(origin, "addEvidence", `${value.kind}: ${value.claim.slice(0, 60)}`),
    };
    this.evidence.push(entry);
    return entry;
  }

  addConflict(origin: Origin, init: ConflictInit): Conflict {
    const value = conflictSchema.parse(init);
    const entry: Conflict = {
      ...value,
      origin,
      seq: this.record(origin, "addConflict", value.description.slice(0, 80)),
    };
    this.conflicts.push(entry);
    return entry;
  }

  addOpen(origin: Origin, init: OpenItemInit): OpenItem {
    const value = openItemSchema.parse(init);
    const entry: OpenItem = {
      ...value,
      origin,
      seq: this.record(origin, "addOpen", `${value.blocking ? "blocking" : "open"}: ${value.question.slice(0, 60)}`),
    };
    this.open.push(entry);
    return entry;
  }

  addRefusal(origin: Origin, init: RefusalInit): Refusal {
    const value = refusalSchema.parse(init);
    const entry: Refusal = {
      ...value,
      origin,
      seq: this.record(origin, "addRefusal", `${value.gate} via ${value.tool}`),
    };
    this.refusals.push(entry);
    return entry;
  }

  addToolCall(origin: Origin, init: ToolCallInit): ToolCall {
    const value = toolCallSchema.parse(init);
    const entry: ToolCall = {
      ...value,
      origin,
      seq: this.record(origin, "addToolCall", `${value.tool} (${value.requestedBy})${value.ok ? "" : " FAILED"}`),
    };
    this.toolCalls.push(entry);
    return entry;
  }

  /** Latest value for a field, or undefined. Later writes supersede earlier. */
  latest(field: string): Computed | undefined {
    for (let i = this.computed.length - 1; i >= 0; i--) {
      if (this.computed[i].field === field) return this.computed[i];
    }
    return undefined;
  }

  hasConflicts(): boolean {
    return this.conflicts.length > 0;
  }

  /**
   * The inconsistency metric from the observability section: things this object
   * should never contain. Should trend to zero; anything non-zero is a bug in
   * the stage that wrote it, not a data problem.
   */
  inconsistencies(): string[] {
    const out: string[] = [];
    for (const c of this.computed) {
      if (c.inputs.length === 0) out.push(`computed ${c.field} has no inputs`);
      if (!c.method) out.push(`computed ${c.field} has no method`);
    }
    for (const o of this.offsets) {
      for (const p of o.picks) {
        if (p.depth.api !== o.api) out.push(`offset ${o.api} carries a pick on ${p.depth.api}`);
      }
    }
    return out;
  }

  snapshot(): ZoneEvaluation {
    return {
      well: { ...this.well },
      datum: { ...this.datum },
      interval: this.interval ? structuredClone(this.interval) : null,
      curves: [...this.curves],
      computed: [...this.computed],
      assumptions: [...this.assumptions],
      offsets: [...this.offsets],
      evidence: [...this.evidence],
      conflicts: [...this.conflicts],
      open: [...this.open],
      refusals: [...this.refusals],
      toolCalls: [...this.toolCalls],
    };
  }

  journal(): readonly JournalEntry[] {
    return [...this.log];
  }
}

export function createZoneEvaluation(well: Well): ZoneEvaluationStore {
  return new ZoneEvaluationStore(well);
}
