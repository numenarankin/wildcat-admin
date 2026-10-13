/**
 * Stage 0 — Resolve. Deterministic, cached, no model in the loop.
 *
 * See well-log-agent.md, Stage 0. Identify the well, check cache, and on a miss
 * materialize it: parse, normalize mnemonics, resolve the datum against the RRC
 * record, compute the standard curve suite, flag washouts.
 *
 * The harness owns SEQUENCING and CACHING. Every piece of actual work is a tool
 * call (see contracts.ts) — this module never computes a number itself.
 *
 * ## Header first
 *
 * The one ordering constraint in the architecture: Stage 1's RRC branches need
 * location and EKB/EGL/EPD, and those come out of the LAS header. So the header
 * is parsed and PUBLISHED before the curve work starts, and `resolveStage0`
 * hands back two promises rather than one — `header` settles as soon as the
 * header is read, `done` when the whole state object is materialized. The caller
 * starts Stage 1 off the first while the second is still running.
 *
 * Sequencing the full parse in front of every offset query would add the curve
 * read to the user's wait for nothing, which is the exact latency the
 * architecture says to avoid.
 */
import {
  TOOL,
  type CompletionRecord,
  type CurveSuiteFacts,
  type CurvesFacts,
  type HeaderFacts,
  type HoleQualityFacts,
  type MnemonicFacts,
} from "./contracts";
import {
  cacheKey,
  staleness,
  STATE_VERSION,
  type CacheStamps,
  type EvaluationCache,
} from "./cache";
import { callTool, type CallDeps } from "./call-tool";
import { isFileIdentity } from "./subject";
import { ToolRegistry, type ToolContext } from "./registry";
import {
  ZoneEvaluationStore,
  createZoneEvaluation,
  type Origin,
} from "./state";

/**
 * Elevations are reported to the foot on RRC forms and are frequently rounded
 * differently in a LAS header. A one-foot disagreement is a transcription
 * artifact, not two competing datums, and treating it as a conflict would send
 * every second well down the escalated path for nothing.
 */
export const DATUM_TOLERANCE_FT = 1;

export interface Stage0Input {
  api: string;
  lasPath: string;
  stamps: CacheStamps;
}

export interface Stage0Deps {
  registry: ToolRegistry;
  cache: EvaluationCache;
  /** Injectable for tests. */
  now?: () => number;
}

export interface Stage0Result {
  store: ZoneEvaluationStore;
  header: HeaderFacts;
  cacheHit: boolean;
  /** Why the cache was not used. Null on a hit. */
  missReason: string | null;
}

export interface Stage0Handle {
  /** Settles as soon as the LAS header is read. Stage 1 waits on this, not `done`. */
  header: Promise<HeaderFacts>;
  /**
   * The state object, published at the same moment as the header.
   *
   * Stage 1 needs somewhere to write before Stage 0 has finished computing, and
   * waiting for `done` to get it would put the whole curve suite in front of the
   * offset queries — the exact sequencing this stage exists to avoid.
   */
  store: Promise<ZoneEvaluationStore>;
  done: Promise<Stage0Result>;
}

const ORIGIN: Origin = { stage: "stage0" };
const origin = (branch: string): Origin => ({ stage: "stage0", branch });

export function resolveStage0(input: Stage0Input, deps: Stage0Deps): Stage0Handle {
  let publishHeader!: (h: HeaderFacts) => void;
  let failHeader!: (e: unknown) => void;
  let publishStore!: (s: ZoneEvaluationStore) => void;
  let failStore!: (e: unknown) => void;

  const header = new Promise<HeaderFacts>((res, rej) => {
    publishHeader = res;
    failHeader = rej;
  });
  const store = new Promise<ZoneEvaluationStore>((res, rej) => {
    publishStore = res;
    failStore = rej;
  });
  // A caller that only awaits `done` must not trip an unhandled rejection on
  // these when the parse fails.
  header.catch(() => {});
  store.catch(() => {});

  const done = materialize(input, deps, publishHeader, publishStore).catch((err: unknown) => {
    failHeader(err);
    failStore(err);
    throw err;
  });

  return { header, store, done };
}

async function materialize(
  input: Stage0Input,
  deps: Stage0Deps,
  publishHeader: (h: HeaderFacts) => void,
  publishStore: (s: ZoneEvaluationStore) => void
): Promise<Stage0Result> {
  const { cache } = deps;
  const now = deps.now ?? Date.now;
  const key = cacheKey(input.api, input.stamps.las);
  const ctx: ToolContext = { api: input.api, lasPath: input.lasPath };

  const cached = await cache.get(key);
  if (cached) {
    const stale = staleness(cached, input.stamps);
    if (!stale) {
      const restored = ZoneEvaluationStore.restore(cached.snapshot);
      publishHeader(cached.header);
      publishStore(restored);
      return { store: restored, header: cached.header, cacheHit: true, missReason: null };
    }
    await cache.delete(key);
    return {
      ...(await build(input, deps, ctx, publishHeader, publishStore, now)),
      cacheHit: false,
      missReason: stale,
    };
  }

  return {
    ...(await build(input, deps, ctx, publishHeader, publishStore, now)),
    cacheHit: false,
    missReason: "cold",
  };
}

async function build(
  input: Stage0Input,
  deps: Stage0Deps,
  ctx: ToolContext,
  publishHeader: (h: HeaderFacts) => void,
  publishStore: (s: ZoneEvaluationStore) => void,
  now: () => number
): Promise<Omit<Stage0Result, "cacheHit" | "missReason">> {
  const { registry, cache } = deps;

  // The store exists before the first tool call so that call can be recorded.
  // `toolCalls[]` has to be complete from the very first read: Fable is handed
  // exactly what ran, and a header parse that happened off the books is a gap
  // in the work it shows.
  const store = createZoneEvaluation({
    api: input.api, name: null, operator: null, county: null, district: null,
  });
  const call: CallDeps = { store, registry, ctx };

  // 1. Header. Published the moment it lands so Stage 1 can start.
  const header = (await callTool<HeaderFacts>(call, ORIGIN, TOOL.lasHeader, {})).value;
  publishHeader(header);
  publishStore(store);
  store.setWell(ORIGIN, {
    name: header.name,
    operator: header.operator,
    county: header.county,
    district: header.district,
  });

  // The file claiming a different well than the one we were asked about is not
  // a parse problem — it is usually the wrong file attached to the well, and
  // silently trusting either side is how an analysis ends up describing
  // somebody else's rock.
  // `file:` identities are placeholders for a turn that never claimed to know
  // the API, so there is nothing for the header to contradict.
  if (header.api && !isFileIdentity(input.api) && normalizeApi(header.api) !== normalizeApi(input.api)) {
    store.addConflict(origin("identity"), {
      description: `LAS header names API ${header.api}, but this evaluation is for ${input.api}`,
      branches: [`header: ${header.api}`, `request: ${input.api}`],
      resolvingDocument: "the well's file attachment record",
    });
  }

  // 2. Datum from the LAS, then cross-checked against the RRC record, and the
  //    curve inventory alongside — none of the three depends on the others.
  const [, , curves] = await Promise.all([
    applyLasDatum(store, header),
    // Optional like the arithmetic below. The public-record cross-check is what
    // turns a datum from "the file says so" into "two sources agree", but a well
    // with no record on file — or a lookup that is not wired yet — is a thinner
    // answer, not a failed parse.
    optional(store, "RRC datum cross-check", () => applyRrcDatum(call, header)),
    readCurves(call),
  ]);

  // 3. Curve math and hole quality, both of which need the curve inventory.
  //
  // Optional on purpose. A well whose curves are read and whose datum resolves
  // is worth answering about even before the arithmetic tools exist — and once
  // they do, one of them being down should cost its own numbers rather than the
  // whole evaluation. `requirements.ts` reports what is missing; the answer says
  // so and carries on.
  await Promise.all([
    optional(store, "curve suite", () => applyCurveSuite(call, curves)),
    optional(store, "hole quality", () => applyHoleQuality(call)),
  ]);

  if (!store.snapshot().datum.resolved) {
    store.addOpen(origin("datum"), {
      question: `Datum for ${input.api} is unresolved — pull the W-2/G-1 or confirm EKB`,
      // Not blocking on its own: plenty of questions ("what curves are here")
      // need no datum. The structural gate is what blocks, and it blocks in the
      // tool that would produce the number.
      blocking: false,
    });
  }

  await cache.set(cacheKey(input.api, input.stamps.las), {
    version: STATE_VERSION,
    stamps: input.stamps,
    snapshot: store.snapshot(),
    header,
    storedAt: now(),
  });

  return { store, header };
}

/** Run an enhancement, recording its absence rather than failing the parse. */
async function optional(
  store: ZoneEvaluationStore,
  label: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
  } catch (err: unknown) {
    store.addOpen(origin("stage0"), {
      question: `The ${label} could not be computed (${err instanceof Error ? err.message : String(err)}); the answer is missing those numbers`,
      blocking: false,
    });
  }
}

/**
 * Write the LAS's own datum — but only if it actually carries one.
 *
 * Writing `{kbFt: null, source: "~PARAMETER"}` would mark the slot as written,
 * and the RRC record filling it in afterwards would then read as a
 * disagreement. Absence is not a competing opinion.
 */
async function applyLasDatum(store: ZoneEvaluationStore, header: HeaderFacts): Promise<void> {
  if (header.kbFt === null && header.glFt === null) return;
  store.setDatum(origin("las"), {
    kbFt: header.kbFt,
    glFt: header.glFt,
    reference: header.reference ?? (header.kbFt !== null ? "KB" : "GL"),
    source: "LAS ~PARAMETER",
    resolved: header.kbFt !== null || header.glFt !== null,
  });
}

async function applyRrcDatum(call: CallDeps, header: HeaderFacts): Promise<void> {
  const store = call.store;
  const rec = (await callTool<CompletionRecord>(call, origin("rrc"), TOOL.rrcCompletionRecord, {})).value;
  if (rec.kbFt === null && rec.glFt === null) return;

  // Agreement within reporting precision is agreement. Re-writing an
  // equal-but-differently-rounded value would manufacture a conflict.
  const agrees =
    within(header.kbFt, rec.kbFt, DATUM_TOLERANCE_FT) && within(header.glFt, rec.glFt, DATUM_TOLERANCE_FT);
  if (agrees && (header.kbFt !== null || header.glFt !== null)) {
    store.addEvidence(origin("rrc"), {
      claim: `RRC ${rec.form ?? "record"} datum agrees with the LAS header within ${DATUM_TOLERANCE_FT} ft`,
      sourceId: `rrc:${rec.api}`,
      kind: "documented",
    });
    return;
  }

  store.setDatum(origin("rrc"), {
    kbFt: rec.kbFt,
    glFt: rec.glFt,
    reference: rec.kbFt !== null ? "KB" : "GL",
    source: `RRC ${rec.form ?? "record"}`,
    resolved: true,
  });
}

async function readCurves(call: CallDeps): Promise<CurvesFacts> {
  const store = call.store;
  const result = await callTool<CurvesFacts>(call, origin("curves"), TOOL.lasCurves, {});

  const normalized = await Promise.all(
    result.value.curves.map((c) =>
      callTool<MnemonicFacts>(call, origin("curves"), TOOL.mnemonicNormalize, {
        raw: c.mnemonic,
        unit: c.unit,
      })
    )
  );

  for (const [i, c] of result.value.curves.entries()) {
    const m = normalized[i].value;
    store.addCurve(origin("curves"), {
      mnemonicRaw: c.mnemonic,
      mnemonicCanonical: m.canonical,
      unit: m.unit ?? c.unit,
      source: "las",
      // The invariant, restated at the call site: an unrecognized mnemonic is
      // flagged and kept. `addCurve` refuses the alternative.
      flagged: m.canonical === null,
    });
  }
  return result.value;
}

async function applyCurveSuite(call: CallDeps, curves: CurvesFacts): Promise<void> {
  const store = call.store;
  const present = curves.curves.map((c) => c.mnemonic);
  const result = await callTool<CurveSuiteFacts>(call, origin("curve-suite"), TOOL.curveSuite, {
    curves: present,
  });

  for (const a of result.value.assumptions) {
    store.addAssumption(origin("curve-suite"), {
      field: a.field,
      value: a.value,
      source: "default",
      basis: a.basis,
      overridable: true,
    });
  }
  for (const v of result.value.values) {
    store.addComputed(origin("curve-suite"), v);
  }
}

async function applyHoleQuality(call: CallDeps): Promise<void> {
  const store = call.store;
  const hq = (await callTool<HoleQualityFacts>(call, origin("hole-quality"), TOOL.holeQuality, {})).value;

  store.addComputed(origin("hole-quality"), {
    field: "washout_intervals",
    value: hq.washouts.length,
    unit: "intervals",
    inputs: [
      { name: "bitSizeIn", value: hq.bitSizeIn, source: "bit record" },
      { name: "caliper", value: "CALI", source: "las" },
    ],
    method: "caliper vs bit size",
    confidence: null,
  });

  for (const w of hq.washouts) {
    store.addEvidence(origin("hole-quality"), {
      claim: `washed out ${w.topFt}-${w.baseFt} ft, caliper up to ${w.maxExcessIn} in over bit`,
      sourceId: `caliper:${w.topFt}-${w.baseFt}`,
      kind: "measured",
    });
  }
  if (hq.densityPorositySuppressed) {
    store.addOpen(origin("hole-quality"), {
      question: "Density porosity is suppressed through washed-out intervals; neutron or sonic only there",
      blocking: false,
    });
  }
}

function within(a: number | null, b: number | null, tol: number): boolean {
  if (a === null || b === null) return true;
  return Math.abs(a - b) <= tol;
}

/** RRC and LAS write APIs with and without dashes, and with varying length. */
function normalizeApi(api: string): string {
  return api.replace(/\D/g, "").slice(0, 10);
}
