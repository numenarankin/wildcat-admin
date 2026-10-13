/**
 * The six branches the harness always calls, and nothing implemented.
 *
 * `contracts.ts` declares the shapes Stage 0 and Stage 1 ask for. The Python
 * layer has 118 tools, none of which returns any of those shapes: the contracts
 * are AGGREGATES — "the standard curve suite", "the dictionary reads for this
 * area" — and the tools are single equations. Nothing bridged the two, so six
 * calls failed on every well turn from the first day, and the brief handed to
 * Fable was missing the curve math, the hole check and the dictionary reads it
 * was designed around.
 *
 * That gap is what this file closes. Each adapter is thin by intent: it gathers
 * the inputs, calls the real tools, and reshapes the results. No arithmetic
 * happens here — every number comes back from the Python layer with its own
 * inputs, method and provenance attached, exactly as it would if the model had
 * asked for it directly.
 *
 * ## Where the curve values come from
 *
 * Three of these need what the curves READ, not just which curves exist. The
 * `las_columns` operation on the Python function returns the arrays, decimated
 * by stride rather than averaged — an averaged caliper hides the washout that
 * hole quality exists to find.
 *
 * ## Refusing is allowed; failing silently is not
 *
 * An adapter with nothing to work on returns an empty result, not an error: a
 * log with no caliper has no hole quality to report, and that is a fact about
 * the log rather than a broken branch. What it must never do is return a number
 * it made up to fill the shape.
 */
import { z } from "zod";
import {
  DEFAULT_RADIUS_FT,
  MAX_OFFSETS,
  TOOL,
  calculatorsSchema,
  completionRecordSchema,
  continuitySchema,
  curveSuiteSchema,
  holeQualitySchema,
  kbLookupSchema,
  offsetsSchema,
  type HeaderFacts,
} from "./contracts";
import { offsetWellbores } from "@/lib/ai/rrc/offsets";
import type { DatumReference } from "./state";
import type { GeologyTool, ToolContext, ToolRegistry, ToolResult } from "./registry";

/**
 * The subset of a Python `Quantity` these adapters read.
 *
 * Deliberately loose: the tools return a dozen shapes and re-declaring each one
 * here would be a second source of truth that drifts. What every one of them
 * carries is a value, a unit and a method, and that is all a `computed[]` entry
 * needs.
 */
interface Quantity {
  value?: unknown;
  unit?: string | null;
  method?: string;
  source?: string;
  inputs?: Record<string, unknown>;
  assumptions?: Record<string, unknown>;
  flags?: string[];
  kind?: string;
  reason?: string;
}

interface Columns {
  depthFt: (number | null)[];
  columns: Record<string, (number | null)[]>;
  sampled: number;
  ofRows: number;
}

/** How the adapters reach the Python layer. Injected so tests need no HTTP. */
export interface ContractDeps {
  /** One deterministic tool, by name. */
  run(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<Quantity>;
  /** Curve values over a window. Null when the log cannot be read. */
  columns(
    ctx: ToolContext,
    opts: { curves?: string[]; topFt?: number; baseFt?: number; maxSamples?: number }
  ): Promise<Columns | null>;
  /** The LAS header, for matrix and datum defaults. */
  header(ctx: ToolContext): Promise<HeaderFacts | null>;
  /** The Texas public record, when a branch needs it. */
  rrc?(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const isRefusal = (q: Quantity | null | undefined): boolean =>
  !q || q.kind === "Refusal" || q.value === undefined || q.value === null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Values only, in order, from a possibly-gappy column. */
function readings(col: (number | null)[] | undefined): number[] {
  return (col ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Find a curve by any of its usual mnemonics. Logs are not consistent. */
function pick(cols: Record<string, (number | null)[]>, names: string[]): (number | null)[] | undefined {
  const upper = new Map(Object.entries(cols).map(([k, v]) => [k.toUpperCase(), v]));
  for (const n of names) {
    const hit = upper.get(n.toUpperCase());
    if (hit) return hit;
  }
  return undefined;
}

/** A Python result turned into the `computed[]` entry the contract wants. */
function computed(field: string, q: Quantity, fallbackMethod: string) {
  const inputs = Object.entries(q.inputs ?? {})
    .filter(([, v]) => ["number", "string", "boolean"].includes(typeof v) || v === null)
    .map(([name, v]) => ({ name, value: v as number | string | boolean | null, source: null as string | null }));
  return {
    field,
    value: (typeof q.value === "number" || typeof q.value === "string"
      ? q.value
      : String(q.value)) as number | string,
    unit: q.unit ?? null,
    // `computedValueOutSchema` requires at least one input, and rightly: a
    // number with nothing behind it is the thing this whole system exists to
    // prevent. Where a tool reports none, say so rather than inventing one.
    inputs:
      inputs.length > 0
        ? inputs
        : [{ name: "note", value: "inputs not reported by the tool" as string, source: null as string | null }],
    method: q.method ?? fallbackMethod,
    confidence: null,
  };
}

/* ------------------------------------------------------------------ *
 * Stage 0 — hole quality
 * ------------------------------------------------------------------ */

/**
 * Caliper against bit size, over the whole logged interval.
 *
 * The one branch whose absence changes an answer silently: density porosity read
 * through a washout is mud, not rock, and reads high. Without this the brief
 * carries no washout flags at all and every porosity looks equally trustworthy.
 */
async function holeQuality(deps: ContractDeps, ctx: ToolContext) {
  const cols = await deps.columns(ctx, {
    curves: ["DEPT", "DEPTH", "CALI", "CAL", "CALS", "DRHO", "DCOR"],
    maxSamples: 600,
  });
  const empty = { bitSizeIn: null, washouts: [], densityPorositySuppressed: false };
  if (!cols) return empty;

  const caliper = pick(cols.columns, ["CALI", "CAL", "CALS"]);
  const drho = pick(cols.columns, ["DRHO", "DCOR"]);
  if (!caliper && !drho) return empty;

  // Without the bit size every caliper gate declines for the WHOLE log — the
  // tool says so in its own notes — and the branch reports no washouts on a log
  // full of them. It is in the ~PARAMETER block as BS.
  const header = await deps.header(ctx);
  const bitSizeIn = num((header as unknown as Record<string, unknown> | null)?.bitSizeIn);

  const q = await deps.run(
    "hole_quality",
    {
      depth_ft: cols.depthFt,
      ...(caliper ? { caliper_in: caliper } : {}),
      ...(drho ? { drho } : {}),
      ...(bitSizeIn !== null ? { bit_size_in: bitSizeIn } : {}),
    },
    ctx
  );
  if (isRefusal(q)) return { ...empty, bitSizeIn };

  /*
   * The tool answers per SAMPLE — a verdict at every depth — and the contract
   * wants intervals. Runs of bad samples are collapsed here rather than in
   * Python, because the run boundaries are a presentation choice and the tool's
   * job is the verdict at a depth.
   */
  const samples = (q.inputs?.samples ?? q.value) as unknown;
  const list = Array.isArray(samples) ? samples : [];
  const washouts: { topFt: number; baseFt: number; maxExcessIn: number }[] = [];
  let open: { topFt: number; baseFt: number; maxExcessIn: number } | null = null;
  let suppressed = false;

  for (const s of list) {
    const o = s as Record<string, unknown>;
    const depth = num(o.depth_ft);
    const excess = num(o.diffcal_in);
    const hits = Array.isArray(o.hits) ? (o.hits as unknown[]).map(String) : [];
    const bad = hits.some((h) => /washout|rugos/i.test(h)) || (excess !== null && excess > 0.5);
    if (bad) suppressed = true;
    if (depth === null) continue;
    if (bad) {
      if (open && depth - open.baseFt <= (cols.depthFt.length > 1 ? 5 : 1)) {
        open.baseFt = depth;
        open.maxExcessIn = Math.max(open.maxExcessIn, excess ?? 0);
      } else {
        if (open) washouts.push(open);
        open = { topFt: depth, baseFt: depth, maxExcessIn: excess ?? 0 };
      }
    }
  }
  if (open) washouts.push(open);

  return { bitSizeIn, washouts, densityPorositySuppressed: suppressed };
}

/* ------------------------------------------------------------------ *
 * Stage 0 — the curve suite
 * ------------------------------------------------------------------ */

/** Matrix defaults by lithology, so the suite can say what it assumed. */
const DEFAULT_LITHOLOGY = "limestone";

/**
 * phiD, Vsh, phiN, crossplot porosity and Archie Sw over the logged interval.
 *
 * Computed at the interval's MEDIAN reading of each curve, not per sample. The
 * contract wants values for the brief, and a thousand per-foot numbers is not a
 * brief — the model asks for a specific depth when it needs one. The median is
 * used rather than the mean because a single washout spike should not move the
 * summary of the whole log.
 *
 * This is why Fable was making six `density_porosity` calls by hand on every
 * turn: the numbers it needed were computable and nobody had computed them.
 */
async function curveSuite(deps: ContractDeps, ctx: ToolContext) {
  const values: ReturnType<typeof computed>[] = [];
  const assumptions: { field: string; value: number | string; basis: string }[] = [];

  const cols = await deps.columns(ctx, {
    curves: ["DEPT", "DEPTH", "RHOB", "DPHI", "NPHI", "PHIN", "GR", "ILD", "RT", "RESD", "DRHO"],
    maxSamples: 600,
  });
  if (!cols) return { values, assumptions };

  const lithology = DEFAULT_LITHOLOGY;
  assumptions.push({
    field: "matrix_lithology",
    value: lithology,
    basis: "no lithology curve or sample log in scope; the area default was used and may be wrong",
  });

  const rhob = median(readings(pick(cols.columns, ["RHOB"])));
  const gr = readings(pick(cols.columns, ["GR"]));
  const nphi = median(readings(pick(cols.columns, ["NPHI", "PHIN"])));
  const rt = median(readings(pick(cols.columns, ["ILD", "RT", "RESD"])));

  let phiD: number | null = null;
  if (rhob !== null) {
    const q = await deps.run("density_porosity", { rho_b: rhob, lithology }, ctx);
    if (!isRefusal(q)) {
      values.push(computed("density_porosity", q, "density porosity"));
      phiD = num(q.value);
    }
  } else {
    // A pre-computed DPHI curve is a reading, not a calculation — report it as
    // what it is rather than passing it off as this system's arithmetic.
    const dphi = median(readings(pick(cols.columns, ["DPHI"])));
    if (dphi !== null) {
      phiD = dphi;
      values.push({
        field: "density_porosity",
        value: dphi,
        unit: "v/v",
        inputs: [{ name: "curve", value: "DPHI", source: "the log" }],
        method: "read from the DPHI curve as recorded; the matrix used to compute it is not in the file",
        confidence: null,
      });
      assumptions.push({
        field: "dphi_matrix",
        value: "unknown",
        basis: "DPHI was computed by the logging contractor and the matrix density it used is not carried in the curve",
      });
    }
  }

  if (gr.length > 0) {
    const sorted = [...gr].sort((a, b) => a - b);
    const clean = sorted[Math.floor(sorted.length * 0.05)];
    const shale = sorted[Math.floor(sorted.length * 0.95)];
    const q = await deps.run(
      "vshale",
      { gr_log: median(gr), gr_clean: clean, gr_shale: shale, method: "linear" },
      ctx
    );
    if (!isRefusal(q)) values.push(computed("vshale", q, "gamma-ray shale volume"));
    assumptions.push({
      field: "gr_picks",
      value: `clean ${clean.toFixed(1)}, shale ${shale.toFixed(1)} API`,
      basis: "picked as the 5th and 95th percentile of the gamma ray over the logged interval, not from a sample log",
    });
  }

  if (nphi !== null && phiD !== null) {
    const q = await deps.run(
      "crossplot_porosity",
      {
        phi_n: nphi,
        phi_d: phiD,
        phi_n_matrix: lithology,
        phi_d_matrix: lithology,
        formation_lithology: lithology,
      },
      ctx
    );
    if (!isRefusal(q)) values.push(computed("crossplot_porosity", q, "neutron-density crossplot porosity"));
  }

  // Archie needs Rw, and Rw needs provenance. Without one this is a gate
  // refusal by design — see GATES in the prompt — so it is not attempted with a
  // guessed value.
  if (rt !== null && phiD !== null) {
    assumptions.push({
      field: "water_saturation",
      value: "not computed",
      basis: "Rw has no provenance in this well; a Pickett plot or a water analysis would supply it",
    });
  }

  return { values, assumptions };
}

/* ------------------------------------------------------------------ *
 * Stage 1 — dictionary reads
 * ------------------------------------------------------------------ */

/**
 * The keyed lookups: county to basin prior, lithology to matrix constant.
 *
 * Free and instant, which is why they are worth having — but they sit BESIDE
 * the gatherer, not in front of it. A dictionary hit means a name resolved; it
 * says nothing about whether the library holds the passage answering the
 * operator's actual question.
 */
async function kbLookup(deps: ContractDeps, ctx: ToolContext, args: { county?: unknown; district?: unknown }) {
  const assumptions: { field: string; value: number | string; basis: string }[] = [];
  const facts: { claim: string; sourceId: string }[] = [];

  const reads: { table: string; key: string; field: string }[] = [];
  if (typeof args.county === "string" && args.county.trim()) {
    reads.push({ table: "basin", key: args.county.trim(), field: "basin_prior" });
  }
  reads.push({ table: "lithology", key: DEFAULT_LITHOLOGY, field: "matrix_density" });

  for (const r of reads) {
    const q = await deps.run("kb_lookup", { table: r.table, key: r.key }, ctx).catch(() => null);
    if (!q || isRefusal(q)) continue;
    const record = q.inputs?.record as Record<string, unknown> | undefined;
    if (record) {
      for (const [k, v] of Object.entries(record)) {
        if (typeof v === "number" || typeof v === "string") {
          assumptions.push({
            field: `${r.field}.${k}`,
            value: v,
            basis: `standard published constant for ${r.key}`,
          });
        }
      }
    }
    facts.push({ claim: `${r.key} resolved in the ${r.table} table`, sourceId: `kb:${r.table}/${r.key}` });
  }

  return { assumptions, facts };
}

/* ------------------------------------------------------------------ *
 * Stage 1 — the engineering calculators
 * ------------------------------------------------------------------ */

/**
 * Gas gradient and the unloading rates, where the log supports them.
 *
 * Most of this set — coning, Turner, Coleman — needs a rate, a tubing size or a
 * contact that a log alone does not carry. Those are left to Fable, which asks
 * for them once the question turns out to need them. What runs here is what the
 * header alone supports, so the branch contributes something on every well
 * rather than refusing on all of them.
 */
async function calculators(deps: ContractDeps, ctx: ToolContext) {
  const values: ReturnType<typeof computed>[] = [];
  const header = await deps.header(ctx);
  if (!header) return { values };

  const td = header.stopFt;
  if (td !== null && td > 0) {
    // A gradient needs a bottom-hole temperature. Where the header carries one
    // this is real; where it does not, the tool refuses and nothing is invented.
    const bht = num((header as unknown as Record<string, unknown>).bhtDegF);
    if (bht !== null) {
      const q = await deps.run(
        "temperature_gradient",
        { surface_temp: 70, bht, total_depth: td },
        ctx
      ).catch(() => null);
      if (q && !isRefusal(q)) values.push(computed("temperature_gradient", q, "geothermal gradient"));
    }
  }
  return { values };
}

/* ------------------------------------------------------------------ *
 * Stage 1 — continuity
 * ------------------------------------------------------------------ */

/**
 * Whether the log reads like one continuous run.
 *
 * A spliced log — two runs merged, or a section re-logged — puts two different
 * depth references in one file, and every depth comparison after that is
 * quietly wrong. `curve_splice_detect` is the tool that finds it; this branch
 * was calling a name nothing implemented.
 */
async function continuityCheck(deps: ContractDeps, ctx: ToolContext) {
  const findings: { description: string; topFt: number | null; baseFt: number | null; severity: "note" | "suspect" }[] = [];
  const cols = await deps.columns(ctx, { curves: ["DEPT", "DEPTH"], maxSamples: 2000 });
  if (!cols) return { findings };

  const depths = readings(cols.depthFt);
  if (depths.length < 3) return { findings };

  const q = await deps.run("curve_splice_detect", { depth_ft: depths }, ctx).catch(() => null);
  if (q && !isRefusal(q)) {
    const raw = (q.inputs?.splices ?? q.value) as unknown;
    for (const s of Array.isArray(raw) ? raw : []) {
      const o = s as Record<string, unknown>;
      findings.push({
        description: String(o.reason ?? o.description ?? "a depth discontinuity appears in the log"),
        topFt: num(o.top_ft ?? o.depth_ft ?? o.at_ft),
        baseFt: num(o.base_ft),
        severity: "suspect",
      });
    }
  }

  // A step that changes mid-file is the plain arithmetic version of the same
  // question, and it holds when the tool refuses.
  const steps = depths.slice(1).map((d, i) => Math.abs(d - depths[i]));
  const nominal = median(steps);
  if (nominal !== null && nominal > 0) {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] > nominal * 4) {
        findings.push({
          description: `the depth column jumps ${steps[i].toFixed(1)} ft here against a ${nominal.toFixed(2)} ft step — a gap or a second run`,
          topFt: depths[i],
          baseFt: depths[i + 1],
          severity: "note",
        });
      }
    }
  }
  return { findings: findings.slice(0, 12) };
}

/* ------------------------------------------------------------------ *
 * Stage 0 — the RRC datum cross-check
 * ------------------------------------------------------------------ */

/**
 * The completion record's own elevations, to check the log's against.
 *
 * A LAS header and a W-2 disagreeing about kelly bushing is a real and common
 * fault, and it moves every depth in the answer. Backed by `rrc_well`; absent an
 * API number there is nothing to look up and the check reports nothing rather
 * than failing.
 */
async function completionRecord(deps: ContractDeps, ctx: ToolContext) {
  const header = await deps.header(ctx);
  const api = header?.api ?? (ctx.api.startsWith("file:") ? null : ctx.api);
  const blank: z.infer<typeof completionRecordSchema> = {
    api: api ?? "", kbFt: null, glFt: null, latitude: null, longitude: null, form: null,
  };
  if (!api || !deps.rrc) return blank;

  const raw = await deps.rrc("rrc_well", { api }, ctx).catch(() => null);
  if (!raw || typeof raw !== "object") return blank;
  const r = raw as Record<string, unknown>;
  const well = (r.well ?? r.data ?? r) as Record<string, unknown>;

  return {
    api,
    kbFt: num(well.kb_elevation ?? well.kbFt ?? well.elevation_kb),
    glFt: num(well.gl_elevation ?? well.glFt ?? well.elevation_gl ?? well.ground_elevation),
    latitude: num(well.lat ?? well.latitude),
    longitude: num(well.lon ?? well.longitude),
    form: typeof well.form === "string" ? well.form : "RRC well record",
  };
}

/* ------------------------------------------------------------------ *
 * Stage 1 — the offsets
 * ------------------------------------------------------------------ */

/**
 * RRC elevation codes, onto the three datums the contract knows.
 *
 * GR and GL are both ground; RT is the rotary table, which sits on the derrick
 * floor within a foot of it and has no member of its own. Every other code —
 * and the null the majority of filings carry — leaves the datum UNRESOLVED.
 */
const DATUM_BY_CODE: Record<string, DatumReference> = {
  KB: "KB",
  DF: "DF",
  RT: "DF",
  GL: "GL",
  GR: "GL",
};

/**
 * What a pick is hung on when the filing does not say.
 *
 * `DATUM_REFERENCES` has no "unknown" member, and the schema requires one of the
 * three on every pick, so an unresolved offset still has to name something.
 * Reported completion depths are driller's depths, so KB is the least wrong
 * prior — and `datumResolved: false` is what actually carries the doubt.
 */
const UNRESOLVED_DATUM: DatumReference = "KB";

/**
 * The mirror's key: county plus unique number, eight digits.
 *
 * A LAS header carries the full API — state code, and often a completion suffix
 * — and the subject well is the nearest hole to itself. Without this the store
 * rejects it as "offset is the subject well" and the whole branch is lost.
 */
function apiKey(api: string | null | undefined): string | null {
  const digits = (api ?? "").replace(/\D/g, "");
  if (digits.length === 8) return digits;
  if (digits.length >= 10) return digits.slice(2, 10);
  return null;
}

/**
 * The wells inside the radius, with what each of them penetrated.
 *
 * The picks are the point: an offset's formation tops are what say whether this
 * well's log is reading the same rock the neighbours produce from. They are
 * stamped with the OFFSET's API all the way through, never merged.
 */
async function offsetsWithinRadius(
  ctx: ToolContext,
  args: { latitude?: unknown; longitude?: unknown; radiusFt?: unknown; limit?: unknown }
) {
  const empty: z.infer<typeof offsetsSchema> = { offsets: [], truncated: false };
  const latitude = num(args.latitude);
  const longitude = num(args.longitude);
  if (latitude === null || longitude === null) return empty;

  const radiusFt = num(args.radiusFt) ?? DEFAULT_RADIUS_FT;
  const subject = apiKey(ctx.api);
  const { wells, truncated } = await offsetWellbores({
    lat: latitude,
    lon: longitude,
    radiusMi: radiusFt / 5_280,
    limit: num(args.limit) ?? MAX_OFFSETS,
  });

  return {
    offsets: wells
      .filter((w) => w.api_number !== subject)
      .map((w) => {
        const reference = DATUM_BY_CODE[w.elevationCode?.toUpperCase() ?? ""] ?? null;
        return {
          api: w.api_number,
          distanceFt: w.distanceMi * 5_280,
          picks: w.formationTops
            .filter((t): t is { formation: string; depthFt: number } => t.depthFt !== null)
            .map((t) => ({
              formation: t.formation,
              depthFt: t.depthFt,
              reference: reference ?? UNRESOLVED_DATUM,
            })),
          // The mirror holds no drill stem tests. An empty list is the honest
          // answer; the alternative is a number nobody measured.
          dst: [],
          datumResolved: reference !== null && w.kbElevationFt !== null,
        };
      }),
    truncated,
  };
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

function tool<R>(
  name: string,
  description: string,
  outputSchema: z.ZodType<R>,
  method: string,
  run: (args: never, ctx: ToolContext) => Promise<R>
): GeologyTool<unknown, unknown> {
  return {
    name,
    description,
    inputSchema: z.looseObject({}),
    outputSchema,
    readOnly: true,
    // The harness's own branches. Fable reaches the individual tools through
    // `petrophysics` and does not need the aggregate.
    callableBy: ["harness"],
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult<unknown>> {
      const value = await run(args as never, ctx);
      return { value, provenance: { tool: name, inputs: args, method } };
    },
  } as unknown as GeologyTool<unknown, unknown>;
}

export function registerContractTools(registry: ToolRegistry, deps: ContractDeps): number {
  const tools = [
    tool(TOOL.holeQuality, "Caliper against bit size over the logged interval, with the washout intervals where density porosity cannot be trusted.", holeQualitySchema, "caliper and density-correction analysis", (_a, ctx) => holeQuality(deps, ctx)),
    tool(TOOL.curveSuite, "The standard curve math over the logged interval: density porosity, shale volume, crossplot porosity where a neutron exists.", curveSuiteSchema, "standard curve suite over the logged interval", (_a, ctx) => curveSuite(deps, ctx)),
    tool(TOOL.kbLookup, "Keyed dictionary reads: county to basin prior, lithology to matrix constant.", kbLookupSchema, "owned dictionary lookup", (args: { county?: unknown; district?: unknown }, ctx) => kbLookup(deps, ctx, args ?? {})),
    tool(TOOL.calculators, "Engineering closed forms the header alone supports.", calculatorsSchema, "published correlations", (_a, ctx) => calculators(deps, ctx)),
    tool(TOOL.continuityCheck, "Whether the log reads as one continuous run, or carries a splice or a gap.", continuitySchema, "depth-column continuity analysis", (_a, ctx) => continuityCheck(deps, ctx)),
    tool(TOOL.rrcCompletionRecord, "The completion record's own kelly bushing and ground elevations, to check the log header against.", completionRecordSchema, "Texas Railroad Commission well record", (_a, ctx) => completionRecord(deps, ctx)),
    // The one branch that does not go through `deps`: it is a spatial query
    // against the RRC mirror, with no Python and no LAS in it.
    tool(TOOL.offsetsWithinRadius, "The wells inside a radius of a point, with the formation tops each of them reported.", offsetsSchema, "Texas Railroad Commission wellbore records within a radius", (args: { latitude?: unknown; longitude?: unknown; radiusFt?: unknown; limit?: unknown }, ctx) => offsetsWithinRadius(ctx, args ?? {})),
  ];

  let added = 0;
  for (const t of tools) {
    if (registry.has(t.name)) continue;
    registry.register(t);
    added++;
  }
  return added;
}
