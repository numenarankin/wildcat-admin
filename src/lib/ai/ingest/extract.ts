import "server-only";

import { streamText } from "ai";
import { z } from "zod";
import { INGEST_ROW_SCHEMA } from "@/lib/ai/ingest/schemas";
import {
  INGEST_TYPE_META,
  renderDestinationCatalog,
  type IngestType,
} from "@/lib/ai/ingest/types";
import type { IngestContext } from "@/lib/ai/ingest/context";
import { ierr, ilog } from "@/lib/ai/ingest/log";
import { loadSkill, loadSkillSection } from "@/lib/ai/ingest/skills/load";
import { streamAgentJson, isolateJson } from "@/lib/ai/ingest/agent-call";
import { SCAN_MODEL_ID, scanModel, scanProviderOptions } from "@/lib/ai/scan-model";

/**
 * Hard ceiling on a single extraction call. A genuinely stuck call aborts here
 * with a clear TimeoutError the caller logs + surfaces, instead of spinning the
 * upload forever. This is Stage 2 (skill): it works on the already-transcribed
 * TEXT and asks for plain JSON we validate ourselves — NO structured-output
 * grammar (`output_config`), so the "Grammar compilation timed out" failure is
 * impossible here by construction.
 */
const EXTRACT_TIMEOUT_MS = 180_000;

/** How often to log a "still generating" heartbeat while streaming a call. */
const HEARTBEAT_MS = 4_000;

/** Existing records the model should not re-propose (dedup at the prompt layer). */
function existingBlock(type: IngestType, ctx: IngestContext): string {
  const rows = ctx.existing[type];
  if (!rows || rows.length === 0) return "";
  return [
    "",
    "Some of these ALREADY exist. If a row is essentially one of these and the",
    "only differences are trivial (capitalization, spacing, punctuation, \"No.\"",
    "vs \"#\", abbreviations, an equivalent way of writing the same value), do NOT",
    "re-propose it. Only propose it if the document genuinely adds a record that",
    "is NOT here, or fills a field one of these leaves blank. This list may be",
    "incomplete, so when unsure, include the record — the write step dedups.",
    ...rows.slice(0, 200).map((r) => `- ${r}`),
  ].join("\n");
}

function wellsBlock(ctx: IngestContext): string {
  const list = ctx.wells.map((w) => `- ${w.id} — ${w.name}`).join("\n") || "(none)";
  return `\nWells (match by name, use the id; blank if unclear):\n${list}`;
}

/**
 * The shared head for every phase-2 extraction pass. The prose lives in
 * `skills/extract-head.md` (edit it there); the `{{DESTINATION}}` token is the
 * per-type belongs/notHere line.
 */
function head(type: IngestType): string {
  const meta = INGEST_TYPE_META[type];
  return loadSkill("extract-head", {
    DESTINATION: `THIS RECORD TYPE — ${meta.plural}: ${meta.belongs} ${meta.notHere}`,
  });
}

/** The type-specific extraction guidance, from `skills/extract-guidance.md`. */
function guidance(type: IngestType, ctx: IngestContext): string {
  // Dynamic tokens for the two types that inline live context.
  const wells =
    type === "leaseUseGas" || type === "transactions" ? wellsBlock(ctx) : "";
  const categories =
    type === "transactions" && ctx.categories.length
      ? "\nCategories (use both code and exact label; blank if none fit):\n" +
        ctx.categories
          .map((c) => `- ${c.code} — ${c.label} (${c.kind})`)
          .join("\n")
      : "";
  const infoFields =
    type === "wellEquipment" && ctx.infoFields.length
      ? "\nThe Info sheet this workspace keeps (use these labels verbatim when the\ndocument states one of them; only use your own wording for a spec that has\nno field here):\n" +
        ctx.infoFields.map((f) => `- ${f}`).join("\n")
      : "";
  return loadSkillSection("extract-guidance", type, {
    WELLS: wells,
    CATEGORIES: categories,
    INFO_FIELDS: infoFields,
  });
}

/** The reason-first, type-specific system prompt for phase-2 extraction. */
function buildPrompt(type: IngestType, ctx: IngestContext): string {
  return [head(type), guidance(type, ctx), existingBlock(type, ctx)]
    .filter(Boolean)
    .join("\n\n");
}

/** Field names of a row schema (a `ZodObject`), for the JSON output spec. */
function rowFieldNames(schema: z.ZodTypeAny): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/**
 * Reorder a row's keys into the schema's field order so the review grid always
 * shows columns in a stable, intentional order — the model's JSON key order (and
 * Zod's parse output) is otherwise arbitrary, which is why headers looked
 * jumbled. Extra keys not in the schema are appended, never dropped.
 */
function orderRow(row: unknown, fields: string[]): unknown {
  if (!row || typeof row !== "object") return row;
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of fields) if (k in src) out[k] = src[k];
  for (const k of Object.keys(src)) if (!(k in out)) out[k] = src[k];
  return out;
}

/**
 * Best-effort recovery of complete row objects from a TRUNCATED reply. When the
 * model hits its output ceiling mid-array the top-level `JSON.parse` fails; rather
 * than lose the whole chunk, walk the `rows` array and pull out every COMPLETE
 * `{...}` object (the final, partial one is dropped). Returns [] if no array is
 * found. A string-aware scan so braces inside string values don't confuse depth.
 */
function salvageRowObjects(raw: string): unknown[] {
  const key = raw.indexOf('"rows"');
  const start = key < 0 ? -1 : raw.indexOf("[", key);
  if (start < 0) return [];
  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          out.push(JSON.parse(raw.slice(objStart, i + 1)));
        } catch {
          /* skip a malformed object */
        }
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }
  return out;
}

/**
 * Parse the model's JSON reply into validated rows. On a hard parse failure it
 * first tries to SALVAGE the complete rows from a truncated reply (a chunk that
 * overran its output cap); only if nothing can be salvaged does it throw, so the
 * caller logs the failure loudly instead of silently dropping data. A single
 * malformed row is skipped (and counted) rather than failing the batch.
 */
function parseRows(
  raw: string,
  rowSchema: z.ZodTypeAny,
  type: IngestType
): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(isolateJson(raw));
  } catch (err) {
    const salvaged = salvageRowObjects(raw);
    if (salvaged.length > 0) {
      ilog("extract: salvaged rows from truncated reply", {
        type,
        salvaged: salvaged.length,
        responseChars: raw.length,
      });
      parsed = { rows: salvaged };
    } else {
      throw new Error(
        `extract(${type}): model did not return valid JSON (${
          (err as Error).message
        }); response length ${raw.length}`
      );
    }
  }
  const rawRows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rawRows)) return [];
  const fields = rowFieldNames(rowSchema);
  const rows: unknown[] = [];
  let dropped = 0;
  let firstError: { issues: unknown; row: unknown } | null = null;
  for (const r of rawRows) {
    const res = rowSchema.safeParse(r);
    if (res.success) rows.push(orderRow(res.data, fields));
    else {
      dropped++;
      // Capture WHY the first row failed — a silent 100% drop (e.g. a spreadsheet
      // date arriving as an Excel serial number) is otherwise invisible.
      if (!firstError) {
        firstError = {
          issues: res.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
            message: i.message,
          })),
          row: r,
        };
      }
    }
  }
  if (dropped > 0) {
    ilog("extract: dropped invalid rows", {
      type,
      dropped,
      kept: rows.length,
      firstError,
    });
  }
  return rows;
}

/**
 * Stage 2 (skill): extract the rows of ONE type from the already-transcribed
 * document TEXT. Uses a plain `generateText` call that returns JSON, which we
 * validate against the row schema ourselves — deliberately NOT `generateObject`,
 * so no `output_config` grammar is compiled (that was the timeout). The reader
 * (Stage 1) already turned the PDF into text; this step never sees the raw file.
 */
export async function extractType(
  type: IngestType,
  documentText: string,
  ctx: IngestContext
): Promise<{
  rows: unknown[];
  usage: { inputTokens?: number; outputTokens?: number; model?: string };
}> {
  // Parse the model's freeform JSON with the type's COERCING schema: the model
  // writes numbers as strings ("182.00", "$13,486.20") and blanks as null, and
  // this schema (the same one the write path uses) coerces them. A strict schema
  // would reject every such row — that was the "dropped 13, kept 0" bug.
  const rowSchema = INGEST_ROW_SCHEMA[type];
  const fields = rowFieldNames(rowSchema);

  // Give the reply a generous output ceiling so a chunk's rows are not truncated.
  // The document is already chunked upstream (see chunk.ts), so a chunk that still
  // overruns is rare — and parseRows salvages the complete rows even then.
  const maxOutputTokens = 32000;
  const system = [
    buildPrompt(type, ctx),
    "",
    "OUTPUT — respond with ONLY a JSON object, no markdown, no code fences, no",
    "commentary before or after:",
    '{"reasoning": "<1-2 sentences>", "rows": [ { ...one object per record... } ] }',
    fields.length
      ? `Each row object has exactly these fields: ${fields.join(", ")}. Use the meanings described above; include a field's value whenever the document shows it.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  ilog("extract: model call begin", {
    type,
    maxOutputTokens,
    systemChars: system.length,
    docChars: documentText.length,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  const callStart = Date.now();

  // Stream so the model call is observable: emit a heartbeat with chars-so-far
  // every few seconds while it generates, instead of one silent 30s wait.
  const result = streamText({
    model: scanModel(),
    maxOutputTokens,
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    maxRetries: 1,
    providerOptions: scanProviderOptions(),
    system,
    messages: [
      {
        role: "user",
        content: `Extract all ${INGEST_TYPE_META[type].plural} from this document.\n\n<document>\n${documentText}\n</document>`,
      },
    ],
  });
  let chars = 0;
  let lastBeat = Date.now();
  for await (const delta of result.textStream) {
    chars += delta.length;
    if (Date.now() - lastBeat > HEARTBEAT_MS) {
      ilog("extract: streaming", { type, charsSoFar: chars, ms: Date.now() - callStart });
      lastBeat = Date.now();
    }
  }
  const text = await result.text;
  const usage = await result.totalUsage;

  const rows = parseRows(text, rowSchema, type);
  ilog("extract: model call done", {
    type,
    model: SCAN_MODEL_ID,
    ms: Date.now() - callStart,
    rows: rows.length,
    responseChars: text.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  return {
    rows,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: SCAN_MODEL_ID,
    },
  };
}

// --- Comprehensive single-call extraction (DATA + PROMPT + MODEL) -----------

/** One group of proposed records: a destination type + its rows. */
export interface SuggestionGroup {
  type: IngestType;
  rows: unknown[];
}

/** A bulleted list of existing records for a prompt, capped so it can't blow up
 * the context. Empty → "(none yet)". */
export function bullets(items: string[] | undefined): string {
  const rows = (items ?? []).slice(0, 200);
  return rows.length ? rows.map((r) => `  - ${r}`).join("\n") : "  (none yet)";
}

/** The comma-separated field list a type's rows use, for the prompt's OUTPUT spec. */
export function fieldSpecFor(targetTypes: IngestType[]): string {
  return targetTypes
    .map((t) => `- ${t}: ${rowFieldNames(INGEST_ROW_SCHEMA[t]).join(", ")}`)
    .join("\n");
}

/**
 * The skill prompt for a comprehensive extraction. The prose lives in the named
 * `skills/<skill>.md` (edit it there); here we only fill the dynamic pieces — the
 * org's existing records to reuse and the per-type field lists. A SUPERSET of
 * tokens is passed (leases/tanks/wells for oil, meters/gatherers for gas); each
 * skill uses the ones it references and `loadSkill` leaves the rest untouched.
 */
function buildSuggestionPrompt(
  skill: string,
  targetTypes: IngestType[],
  ctx: IngestContext
): string {
  const categories = ctx.categories.length
    ? "Accounting categories (use the exact label + code):\n" +
      ctx.categories.map((c) => `  - ${c.code}: ${c.label} (${c.kind})`).join("\n") +
      "\n"
    : "";
  return loadSkill(skill, {
    EXISTING_LEASES: bullets(ctx.existing.leases),
    EXISTING_TANKS: bullets(ctx.existing.tanks),
    EXISTING_METERS: bullets(ctx.existing.meters),
    EXISTING_GATHERERS: bullets(ctx.existing.gatherers),
    // Vendor companies, for the invoice skill: it must reuse an existing
    // spelling rather than minting a near-duplicate directory entry.
    EXISTING_VENDORS: bullets(ctx.existing.serviceProviders),
    EXISTING_WELLS: ctx.wells.length
      ? ctx.wells.map((w) => `  - ${w.name}`).join("\n")
      : "  (none)",
    CATEGORIES: categories,
    // The workspace's own Info sheet, so a spec is filed under a field this
    // org actually keeps rather than a label the model made up.
    INFO_FIELDS: ctx.infoFields.length
      ? ctx.infoFields.map((f) => `  - ${f}`).join("\n")
      : "  (none configured — use the document's own labels)",
    FIELD_SPEC: fieldSpecFor(targetTypes),
    VALID_TYPES: targetTypes.join(", "),
  });
}

/** Parse the model's suggestion JSON into groups. Loose: an unknown type is
 * skipped; a row that fails its schema is KEPT (raw) so nothing silently
 * vanishes from the reviewer's view. Throws only on unparseable JSON. */
function parseSuggestions(
  raw: string,
  targetTypes: IngestType[]
): SuggestionGroup[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(isolateJson(raw));
  } catch (err) {
    throw new Error(
      `extractSuggestions: model did not return valid JSON (${
        (err as Error).message
      }); response length ${raw.length}`
    );
  }
  const allowed = new Set(targetTypes);
  const groups: SuggestionGroup[] = [];
  const rawGroups = (parsed as { suggestions?: unknown }).suggestions;
  // A reply that parses as JSON but carries no `suggestions` array is a CONTRACT
  // violation, not an empty document — the model extracted something and wrapped
  // it in a shape we do not read. Silently returning [] turned a prompt bug into
  // "nothing found", which cost a 27-second scan and looked like a bad document.
  if (!Array.isArray(rawGroups)) {
    ierr("extract: reply has no `suggestions` array — envelope mismatch", {
      topLevelKeys: Object.keys((parsed ?? {}) as object).slice(0, 10),
      responseChars: raw.length,
    });
  }
  for (const g of Array.isArray(rawGroups) ? rawGroups : []) {
    const type = (g as { type?: unknown }).type as IngestType;
    if (!allowed.has(type)) continue;
    const schema = INGEST_ROW_SCHEMA[type];
    const fields = rowFieldNames(schema);
    const rawRows = (g as { rows?: unknown }).rows;
    const rows: unknown[] = [];
    let dropped = 0;
    for (const r of Array.isArray(rawRows) ? rawRows : []) {
      const res = schema.safeParse(r);
      if (res.success) rows.push(orderRow(res.data, fields));
      else {
        rows.push(orderRow(r, fields)); // keep the raw row visible, but ordered
        dropped++;
      }
    }
    if (dropped > 0) {
      ilog("suggest: rows failed strict parse (kept raw)", { type, dropped });
    }
    if (rows.length > 0) groups.push({ type, rows });
  }
  return groups;
}

/**
 * The user message for the analysis agent: the document, plus — on a FIX pass —
 * the validator's issues and the agent's own previous output, so it re-extracts
 * the whole document correcting the flagged problems (this is the loop back from
 * the validate agent).
 */
function buildAnalyzeUser(
  documentText: string,
  opts?: { feedback?: string[]; priorGroups?: SuggestionGroup[] }
): string {
  const base = `<document>\n${documentText}\n</document>`;
  const feedback = opts?.feedback?.filter(Boolean) ?? [];
  if (feedback.length === 0) return base;
  const prior = JSON.stringify({
    suggestions: (opts?.priorGroups ?? []).map((g) => ({
      type: g.type,
      rows: g.rows,
    })),
  });
  return [
    base,
    "",
    "A separate VALIDATION agent checked your PREVIOUS extraction of this",
    "document against the operator's requirements and found the problems below.",
    "Re-extract the WHOLE document: keep everything that was already correct and",
    "FIX every issue. Return the full corrected set of suggestions (all types),",
    "in the same JSON shape.",
    "<issues>",
    ...feedback.map((f) => `- ${f}`),
    "</issues>",
    "",
    "Your previous output:",
    `<previous>${prior}</previous>`,
  ].join("\n");
}

/**
 * DATA + PROMPT + MODEL: feed the transcribed text plus the skill prompt to
 * Claude in ONE call and get back data-entry suggestions across every relevant
 * destination (leases, runs, transactions, ...). No grammar, no constraining
 * schema — the model decides what records the document holds; we validate
 * loosely for display and re-validate on approve at the write.
 *
 * `opts.feedback` (with `opts.priorGroups`) makes this a FIX pass: the analysis
 * agent sees the validator's issues + its own last output and returns a
 * corrected full set. This is how the analyze⇄validate loop closes.
 */
export async function extractSuggestions(
  documentText: string,
  targetTypes: IngestType[],
  ctx: IngestContext,
  opts?: {
    /** Which analyze skill drives the extraction (default the oil skill). */
    skill?: string;
    feedback?: string[];
    priorGroups?: SuggestionGroup[];
  }
): Promise<{
  groups: SuggestionGroup[];
  usage: { inputTokens?: number; outputTokens?: number; model?: string };
}> {
  const system = buildSuggestionPrompt(
    opts?.skill ?? "oil-run-statement",
    targetTypes,
    ctx
  );
  const fix = (opts?.feedback?.filter(Boolean) ?? []).length > 0;
  ilog("suggest: model call begin", {
    targetTypes,
    fixPass: fix,
    systemChars: system.length,
    docChars: documentText.length,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  const callStart = Date.now();

  const { text, usage } = await streamAgentJson({
    label: "suggest",
    system,
    user: buildAnalyzeUser(documentText, opts),
    maxOutputTokens: 32000,
    timeoutMs: EXTRACT_TIMEOUT_MS,
    // The one call that genuinely reasons: deciding which destination each part
    // of a document belongs to, and what a row's values are. Stepped down from
    // the `high` default rather than to `low` — this is where extraction
    // accuracy is won or lost, so it keeps the most headroom of any stage.
    effort: "medium",
  });

  const groups = parseSuggestions(text, targetTypes);
  ilog("suggest: model call done", {
    ms: Date.now() - callStart,
    fixPass: fix,
    groups: groups.map((g) => ({ type: g.type, rows: g.rows.length })),
    responseChars: text.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  return { groups, usage };
}

/**
 * Merge the reviewer's corrected groups over the raw extraction WITHOUT losing a
 * destination. For each type the extraction found, use the reviewer's rows when
 * it returned that type, else keep the raw rows — so a reviewer that silently
 * omits a whole group (it dropped `transactions` in testing) can never delete
 * data the extraction produced. A genuinely new type the reviewer adds is kept.
 */
export function mergeReviewedGroups(
  raw: SuggestionGroup[],
  reviewed: SuggestionGroup[]
): SuggestionGroup[] {
  const byType = new Map(reviewed.map((g) => [g.type, g] as const));
  const out = raw.map((g) => byType.get(g.type) ?? g);
  for (const g of reviewed) if (!out.some((o) => o.type === g.type)) out.push(g);
  return out;
}

/**
 * The reviewer prompt. Prose lives in `skills/review.md` (edit it there); it
 * frames the records as a THIRD PARTY's output so the model audits them instead
 * of rubber-stamping work it thinks is its own.
 */
function buildReviewPrompt(
  targetTypes: IngestType[],
  ctx: IngestContext
): string {
  return loadSkill("review", {
    DESTINATIONS: renderDestinationCatalog(targetTypes),
    EXISTING_LEASES: bullets(ctx.existing.leases),
    EXISTING_TANKS: bullets(ctx.existing.tanks),
    FIELD_SPEC: fieldSpecFor(targetTypes),
    VALID_TYPES: targetTypes.join(", "),
  });
}

/**
 * Second pass of the skill: an INDEPENDENT review of the extracted suggestions
 * that catches common errors (bad date formats, `$`/comma numbers, misreads,
 * misplaced values) the first pass let through. It runs as a fresh call framed
 * as reviewing another system's work — a stateless call with no self-authorship
 * cue — so it genuinely audits rather than approving its own output. Returns the
 * corrected groups; the caller falls back to the unreviewed set if this yields
 * nothing.
 */
export async function reviewSuggestions(
  documentText: string,
  groups: SuggestionGroup[],
  targetTypes: IngestType[],
  ctx: IngestContext
): Promise<{
  groups: SuggestionGroup[];
  usage: { inputTokens?: number; outputTokens?: number; model?: string };
}> {
  const system = buildReviewPrompt(targetTypes, ctx);
  const proposed = JSON.stringify({
    suggestions: groups.map((g) => ({ type: g.type, rows: g.rows })),
  });
  ilog("review: model call begin", {
    targetTypes,
    groups: groups.map((g) => ({ type: g.type, rows: g.rows.length })),
    docChars: documentText.length,
  });
  const callStart = Date.now();

  const result = streamText({
    model: scanModel(),
    maxOutputTokens: 32000,
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    maxRetries: 1,
    providerOptions: scanProviderOptions(),
    system,
    messages: [
      {
        role: "user",
        content: `Document:\n<document>\n${documentText}\n</document>\n\nProposed records to review and correct:\n${proposed}`,
      },
    ],
  });
  let chars = 0;
  let lastBeat = Date.now();
  for await (const delta of result.textStream) {
    chars += delta.length;
    if (Date.now() - lastBeat > HEARTBEAT_MS) {
      ilog("review: streaming", { charsSoFar: chars, ms: Date.now() - callStart });
      lastBeat = Date.now();
    }
  }
  const text = await result.text;
  const usage = await result.totalUsage;

  const reviewed = parseSuggestions(text, targetTypes);
  ilog("review: model call done", {
    model: SCAN_MODEL_ID,
    ms: Date.now() - callStart,
    groups: reviewed.map((g) => ({ type: g.type, rows: g.rows.length })),
    responseChars: text.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  return {
    groups: reviewed,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: SCAN_MODEL_ID,
    },
  };
}
