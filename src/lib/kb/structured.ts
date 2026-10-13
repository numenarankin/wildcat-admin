/**
 * On-demand access to structured data files for Orion's analytic tools. The
 * file in storage / inline `content` is the source of truth; the cached
 * `structured_summary` answers metadata questions, and heavy reads (curve
 * arrays, table columns) re-parse the file here so we never hold raw numbers in
 * the embedding index.
 */

import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { isLas, parseLas, type ParsedLas } from "@/lib/kb/parsers/las";
import { isMainLogName, mainLogLasText } from "@/lib/kb/mainlog-derive";

const BUCKET = "files";

/**
 * Parsed-LAS cache.
 *
 * Reading one curve used to download the whole file from Storage and re-parse
 * every data line, then throw all but one column away — and a log question asks
 * for three or four curves, each its own tool call. On a 10k-row, 20-curve log
 * that was four downloads and ~800k field splits for one question, all inside a
 * wall-clocked request.
 *
 * Keyed by file id, held across requests in a warm instance. Small and
 * short-lived on purpose: a parsed log is megabytes of number arrays, so this
 * keeps only a few and lets them expire rather than growing into the heap.
 */
const PARSE_TTL_MS = 5 * 60_000;
const PARSE_MAX_ENTRIES = 3;

/**
 * A small in-process cache: entries expire after `PARSE_TTL_MS`, at most
 * `PARSE_MAX_ENTRIES` are held, a hit refreshes recency (not age), and the
 * least recently used entry is evicted first.
 */
function ttlCache<V>() {
  const entries = new Map<string, { at: number; value: V }>();
  return {
    get(key: string): V | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at >= PARSE_TTL_MS) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency so the file being actively analysed isn't the one evicted.
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key: string, value: V) {
      entries.delete(key);
      if (entries.size >= PARSE_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { at: Date.now(), value });
    },
  };
}

const parsedLas = ttlCache<{ name: string; las: ParsedLas }>();

/**
 * MainLog files whose on-demand decode failed or produced nothing, by file id.
 * Without it every Orion tool call on such a file downloads and inflates the
 * whole bundle again only to fail the same way. Same policy as `parsedLas`, so
 * a file re-uploaded or backfilled is retried within minutes; a stored
 * `derived_content` is read before this is consulted, so it always wins.
 */
const mainLogDecodeFailed = ttlCache<true>();

async function loadLas(
  fileId: string,
  preloaded?: { name: string; text: string }
): Promise<{ name: string; las: ParsedLas } | null> {
  const hit = parsedLas.get(fileId);
  if (hit) return hit;

  const loaded = preloaded ?? (await loadText(fileId));
  if (!loaded || !loaded.text) return null;
  const las = parseLas(loaded.text, true);
  if (!las.data) return null;

  const value = { name: loaded.name, las };
  parsedLas.set(fileId, value);
  return value;
}

/**
 * Read a file's full text, best mirror first: the inline body of a native doc,
 * then a cached native PDF transcription, then the OCR text.
 *
 * `pdf_native_content` outranks `derived_content` because it is the model's own
 * read of the PDF, written by `readPdfNative` when OCR proved insufficient. Once
 * that exists it is strictly better text at zero cost, so read_file should hand
 * it back rather than the OCR pass it was written to replace.
 */
export async function loadText(fileId: string): Promise<{ name: string; text: string } | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data: file } = await sb
    .from("files")
    .select("name, content, pdf_native_content, derived_content, storage_key")
    .eq("id", fileId)
    .maybeSingle();
  if (!file) return null;

  let text = (file.content || file.pdf_native_content || file.derived_content || "").trim();
  const mainLog = isMainLogName(file.name);
  if (!text && mainLog && mainLogDecodeFailed.get(fileId)) {
    return { name: file.name, text: "" };
  }
  if (!text && file.storage_key) {
    const { data: blob } = await getSupabaseAdmin().storage
      .from(BUCKET)
      .download(file.storage_key);
    if (blob && mainLog) {
      // A mud log is binary: read as text it is garbage the LAS parser would
      // still try to read. No stored rendition yet (uploaded before the
      // decoder, or its write failed), so decode it now, or return nothing.
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        text = ((await mainLogLasText(file.name, bytes)) ?? "").trim();
      } catch (error) {
        console.error("loadText (mainlog) failed", error);
      }
      if (!text) mainLogDecodeFailed.set(fileId, true);
    } else if (blob) {
      text = (await blob.text()).trim();
    }
  }
  return { name: file.name, text };
}

/** The cached parsed summary (header + per-curve/column stats), or null. */
export async function getStructuredSummary(
  fileId: string
): Promise<Record<string, unknown> | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data } = await sb
    .from("files")
    .select("structured_summary")
    .eq("id", fileId)
    .maybeSingle();
  return (data?.structured_summary as Record<string, unknown> | null) ?? null;
}

/** Full text of a (prose) file, capped so a tool result stays manageable. */
export async function readFileText(
  fileId: string,
  maxChars = 24000
): Promise<{ name: string; text: string; truncated: boolean } | null> {
  const loaded = await loadText(fileId);
  if (!loaded) return null;

  // A LAS never goes through the character cap. 24,000 characters lands in the
  // middle of the ~A block, and the model has no way to tell that the log it is
  // reasoning over stops at an arbitrary depth. Route it through the stripped
  // rendering instead, which is smaller AND complete.
  if (isLas(loaded.name, loaded.text)) {
    const log = await readLasText(fileId, LAS_MAX_TOKENS, loaded);
    if (log) {
      return { name: log.name, text: log.text, truncated: log.dataOmitted };
    }
  }

  const truncated = loaded.text.length > maxChars;
  return {
    name: loaded.name,
    text: truncated ? loaded.text.slice(0, maxChars) : loaded.text,
    truncated,
  };
}

/**
 * Model-ready rendering of a whole LAS file.
 *
 * The retrieval loop this replaces existed on the assumption that logs don't fit
 * in context. They do, once the padding is gone: `Sky Heighten.las` is 6,925
 * rows / ~459k tokens as written, but 5,994 of those rows are the null value
 * across every single curve — the tools weren't recording. 931 rows carry data,
 * and stripping the rest puts the file at ~62k tokens. Every log in this org
 * fits in one prompt, so the model can read it once and answer instead of
 * fetching decimated curves one call at a time.
 *
 * What is deliberately KEPT:
 *   - Nulls inside retained rows. "Not logged here" is a real fact, and dropping
 *     those cells would break row alignment between curves.
 *   - Each curve's actual logged interval, so a curve that only ran over part of
 *     the hole reads as such rather than being inferred from gaps.
 *   - A count of what was dropped. Silent truncation reads as "this is the whole
 *     log" when it isn't.
 */

/**
 * Characters per token in the STRIPPED rendering. An estimate on purpose: a
 * `count_tokens` call made to decide whether to send a tool result would cost a
 * round trip to save one.
 *
 * Nowhere near the usual 4 for prose. Measured against `Sky Heighten.las` with
 * Anthropic's count_tokens: the raw file is 2.91 chars/token, but the stripped
 * rendering is 1.51 — stripping removes the fixed-width padding, and what's left
 * is nothing but dense decimals, which tokenize several to a number. An earlier
 * 2.8 here underestimated the real count by 46%, i.e. it would have waved a file
 * twice over budget straight through the check this constant exists to make.
 */
const CHARS_PER_TOKEN = 1.5;

/**
 * Budget for one log in one tool result. Not a context limit — the window is 1M;
 * this is a cost and latency ceiling. `Sky Heighten.las`, the largest log in the
 * org, is 54,890 tokens stripped, so this clears it about 3x over. Past here,
 * a depth window genuinely beats sending the whole hole.
 */
export const LAS_MAX_TOKENS = 150_000;

export interface LasTextResult {
  name: string;
  /** Header, curve list, per-curve stats, and (unless omitted) every data row. */
  text: string;
  rowsTotal: number;
  rowsKept: number;
  rowsDropped: number;
  /** Depth range of the rows that carry any measurement. */
  loggedFrom: number | null;
  loggedTo: number | null;
  approxTokens: number;
  /** True when the stripped log still exceeds the budget: header + stats only. */
  dataOmitted: boolean;
}

/** Trim float noise from re-serialised values; nulls are written as NULL. */
function cell(v: number): string {
  if (!Number.isFinite(v)) return "NULL";
  return String(Math.round(v * 1e4) / 1e4);
}

function depthRange(from: number | null, to: number | null, unit: string): string {
  if (from === null || to === null) return "not logged";
  return `${cell(from)}-${cell(to)}${unit ? ` ${unit}` : ""}`;
}

/**
 * Render a parsed LAS as text for the model. Pure — the async wrapper below
 * handles loading; this is what the tests drive.
 */
export function renderLasText(
  las: ParsedLas,
  maxTokens = LAS_MAX_TOKENS
): Omit<LasTextResult, "name"> {
  const data = las.data ?? [];
  const depthCol = data[0] ?? [];
  const rowsTotal = las.rowCount;

  // A row survives if ANY non-depth curve has a reading. The depth column is
  // always populated, so counting it would keep every padded row.
  const kept: number[] = [];
  for (let i = 0; i < depthCol.length; i++) {
    let any = false;
    for (let c = 1; c < data.length; c++) {
      if (Number.isFinite(data[c][i])) {
        any = true;
        break;
      }
    }
    if (any) kept.push(i);
  }

  const loggedFrom = kept.length ? depthCol[kept[0]] : null;
  const loggedTo = kept.length ? depthCol[kept[kept.length - 1]] : null;
  const du = las.depth.unit;

  const head: string[] = [];
  head.push(`LAS well log. Null cells are written NULL (file null value ${las.nullValue}).`);
  head.push(
    `Rows: ${rowsTotal} in file, ${kept.length} carry data, ${
      rowsTotal - kept.length
    } all-null rows dropped (no measurements on any curve).`
  );
  head.push(
    `Declared interval: ${depthRange(las.depth.start, las.depth.stop, du)}` +
      (las.depth.step !== null ? `, step ${cell(las.depth.step)}` : "") +
      `. Logged interval: ${depthRange(loggedFrom, loggedTo, du)}.`
  );

  const wellLines = Object.entries(las.well).map(([k, v]) => `${k}: ${v}`);
  if (wellLines.length) head.push(`\n## Well\n${wellLines.join("\n")}`);
  // `~Other` slots in here; everything after it is `tail`.
  const beforeOther = head.length;
  const paramLines = Object.entries(las.params).map(([k, v]) => `${k}: ${v}`);
  if (paramLines.length) head.push(`\n## Parameters\n${paramLines.join("\n")}`);

  // Stats are per column, in curve order. Paired by index, never by mnemonic:
  // a log can carry the same mnemonic twice (ROP in min/ft and in ft/hr).
  const curveLines = las.curves.map((c, idx) => {
    const s = las.stats[idx];
    const bits = [`${c.mnemonic}${c.unit ? ` (${c.unit})` : ""}`];
    if (c.description) bits.push(c.description);
    if (idx > 0 && s) {
      // Per-curve logged interval: where THIS curve actually has readings.
      const col = data[idx] ?? [];
      let first: number | null = null;
      let last: number | null = null;
      for (const i of kept) {
        if (!Number.isFinite(col[i])) continue;
        if (first === null) first = depthCol[i];
        last = depthCol[i];
      }
      bits.push(`logged ${depthRange(first, last, du)}`);
      bits.push(
        `n=${s.count} nulls=${s.nullCount}` +
          (s.min !== null ? ` min=${cell(s.min)} max=${cell(s.max ?? NaN)} mean=${cell(s.mean ?? NaN)}` : "")
      );
    }
    return bits.join(" | ");
  });
  head.push(`\n## Curves (${las.curves.length})\n${curveLines.join("\n")}`);

  // `shown` caps how many `~Other` lines go out; a cut says so in the block.
  const other = las.other;
  const headerWith = (shown: number): string => {
    if (!other.length) return head.join("\n");
    const lines = other.slice(0, shown);
    if (shown < other.length) {
      const rest = other.slice(shown).join("\n").length;
      lines.push(
        `Truncated: first ${shown} of ${other.length} ~Other lines shown; the other ` +
          `${other.length - shown} (~${Math.ceil(rest / CHARS_PER_TOKEN).toLocaleString()} tokens) ` +
          `exceed the ${maxTokens.toLocaleString()}-token budget for one tool result.`
      );
    }
    const block = `\n## Other\n${lines.join("\n")}`;
    return [...head.slice(0, beforeOther), block, ...head.slice(beforeOther)].join("\n");
  };
  const header = headerWith(other.length);
  const columns = las.curves.map((c) => c.mnemonic).join(" ");
  const rows = kept.map((i) =>
    las.curves.map((_, c) => cell((data[c] ?? [])[i])).join(" ")
  );
  const withData = `${header}\n\n## Data (${kept.length} rows)\n${columns}\n${rows.join("\n")}\n`;
  const approxTokens = Math.ceil(withData.length / CHARS_PER_TOKEN);

  if (approxTokens <= maxTokens) {
    return {
      text: withData,
      rowsTotal,
      rowsKept: kept.length,
      rowsDropped: rowsTotal - kept.length,
      loggedFrom,
      loggedTo,
      approxTokens,
      dataOmitted: false,
    };
  }

  // Over budget even stripped. Return the header rather than a decimated data
  // section: a sketch of every curve answers worse than the real numbers over
  // the interval the question is actually about, so send the model back for a
  // depth window instead of quietly halving the resolution.
  const omittedWith = (h: string) =>
    `${h}\n\n## Data\nOmitted: ~${approxTokens.toLocaleString()} tokens of data ` +
    `exceeds the ${maxTokens.toLocaleString()}-token budget for one tool result. ` +
    `Call get_curves_data with the curves you need and a depth window inside ` +
    `${depthRange(loggedFrom, loggedTo, du)}.\n`;
  const fits = (t: string) => Math.ceil(t.length / CHARS_PER_TOKEN) <= maxTokens;
  let omitted = omittedWith(header);

  // Still over with the data gone, and `~Other` is the bulk: keep its leading
  // lines up to the budget (binary search on count) and note the cut. With no
  // `~Other` the header goes out whole, as it always has.
  if (other.length && !fits(omitted)) {
    let lo = 0;
    let hi = other.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(omittedWith(headerWith(mid)))) lo = mid;
      else hi = mid - 1;
    }
    omitted = omittedWith(headerWith(lo));
  }
  return {
    text: omitted,
    rowsTotal,
    rowsKept: kept.length,
    rowsDropped: rowsTotal - kept.length,
    loggedFrom,
    loggedTo,
    approxTokens: Math.ceil(omitted.length / CHARS_PER_TOKEN),
    dataOmitted: true,
  };
}

/** The whole log, null padding stripped, as one tool result. */
export async function readLasText(
  fileId: string,
  maxTokens = LAS_MAX_TOKENS,
  preloaded?: { name: string; text: string }
): Promise<LasTextResult | null> {
  const loaded = await loadLas(fileId, preloaded);
  if (!loaded || !loaded.las.data) return null;
  return { name: loaded.name, ...renderLasText(loaded.las, maxTokens) };
}

export interface CurveSample {
  depth: number;
  value: number;
}

export interface CurveDataResult {
  curve: string;
  unit: string;
  depthMnemonic: string;
  depthUnit: string;
  from: number | null;
  to: number | null;
  count: number;
  /** Decimated samples (depth, value), nulls dropped. */
  samples: CurveSample[];
  decimated: boolean;
}

/**
 * Find a curve's column by name. `name` is a mnemonic, optionally with a unit:
 * `ROP`, `ROP (ft/hr)` (as `renderLasText` lists curves) or `ROP.ft/hr` (as a
 * LAS `~Curve` line writes it). Case-insensitive; the unit also ignores spaces.
 *
 * A log can carry one mnemonic more than once in different units. With a unit,
 * the column whose unit matches is returned; a bare mnemonic returns the first
 * column in file order, and the result's `unit` says which one that was.
 * Index 0 (depth) is never returned. -1 when nothing matches.
 */
export function findCurveIndex(las: Pick<ParsedLas, "curves">, name: string): number {
  const raw = name.trim();
  const m = /^(.*?)\s*\((.*)\)$/.exec(raw) ?? /^([^.]+)\.(.*)$/.exec(raw);
  const mnemonic = (m ? m[1] : raw).trim().toUpperCase();
  const norm = (u: string) => u.replace(/\s+/g, "").toLowerCase();
  const unit = m ? norm(m[2]) : null;
  return las.curves.findIndex(
    (c, i) =>
      i > 0 &&
      c.mnemonic.toUpperCase() === mnemonic &&
      (unit === null || norm(c.unit) === unit)
  );
}

/**
 * Pull one LAS curve against depth, optionally within a depth window. Samples
 * are decimated to `maxPoints` so a tool call returns a usable series, not tens
 * of thousands of rows. `curveMnemonic` may carry a unit to pick between
 * same-name curves; see `findCurveIndex`.
 */
export async function getCurveData(
  fileId: string,
  curveMnemonic: string,
  depthFrom?: number,
  depthTo?: number,
  maxPoints = 500
): Promise<CurveDataResult | null> {
  const loaded = await loadLas(fileId);
  if (!loaded) return null;
  const { las } = loaded;
  if (!las.data) return null;

  const depthIdx = 0; // LAS convention: the first curve is the depth index.
  const curveIdx = findCurveIndex(las, curveMnemonic);
  if (curveIdx < 0) return null;

  const depthCol = las.data[depthIdx] ?? [];
  const valueCol = las.data[curveIdx] ?? [];

  const pairs: CurveSample[] = [];
  for (let i = 0; i < depthCol.length; i++) {
    const d = depthCol[i];
    const v = valueCol[i];
    if (!Number.isFinite(d) || !Number.isFinite(v)) continue;
    if (depthFrom !== undefined && d < depthFrom) continue;
    if (depthTo !== undefined && d > depthTo) continue;
    pairs.push({ depth: d, value: v });
  }

  const decimated = pairs.length > maxPoints;
  const step = decimated ? Math.ceil(pairs.length / maxPoints) : 1;
  const samples = decimated ? pairs.filter((_, i) => i % step === 0) : pairs;

  const curve = las.curves[curveIdx];
  return {
    curve: curve.mnemonic,
    unit: curve.unit,
    depthMnemonic: las.depth.mnemonic,
    depthUnit: las.depth.unit,
    from: depthFrom ?? null,
    to: depthTo ?? null,
    count: pairs.length,
    samples,
    decimated,
  };
}

/**
 * Several curves from one LAS in a single call, sharing one parse.
 *
 * Exists because of round-trips, not parsing: a real log question ("is there pay
 * between 8,400 and 8,600?") needs GR + RHOB + NPHI + RT together, and asking
 * for them one tool call at a time costs a full model step — thinking included —
 * per curve. Batching turns four steps into one. Curves are returned aligned on
 * the SAME decimated depths so the model can compare them row-wise without
 * interpolating; unknown mnemonics come back in `missing` rather than failing
 * the call, so one bad guess doesn't cost another round-trip.
 */
export interface MultiCurveResult {
  depthMnemonic: string;
  depthUnit: string;
  from: number | null;
  to: number | null;
  /** Depths every curve's samples line up with. */
  depths: number[];
  curves: { curve: string; unit: string; values: (number | null)[] }[];
  missing: string[];
  count: number;
  decimated: boolean;
}

/** Each entry of `curveMnemonics` may carry a unit; see `findCurveIndex`. */
export async function getCurvesData(
  fileId: string,
  curveMnemonics: string[],
  depthFrom?: number,
  depthTo?: number,
  maxPoints = 500
): Promise<MultiCurveResult | null> {
  const loaded = await loadLas(fileId);
  if (!loaded) return null;
  const { las } = loaded;
  if (!las.data) return null;

  const depthIdx = 0;
  const missing: string[] = [];
  const picked: { mnemonic: string; unit: string; idx: number }[] = [];
  for (const name of curveMnemonics) {
    const idx = findCurveIndex(las, name);
    if (idx < 0) missing.push(name.trim().toUpperCase());
    else
      picked.push({
        mnemonic: las.curves[idx].mnemonic,
        unit: las.curves[idx].unit,
        idx,
      });
  }

  const depthCol = las.data[depthIdx] ?? [];
  // Row filter first (depth window + a readable depth), then decimate ONCE, so
  // every curve is sampled at identical depths.
  const rows: number[] = [];
  for (let i = 0; i < depthCol.length; i++) {
    const d = depthCol[i];
    if (!Number.isFinite(d)) continue;
    if (depthFrom !== undefined && d < depthFrom) continue;
    if (depthTo !== undefined && d > depthTo) continue;
    rows.push(i);
  }

  const decimated = rows.length > maxPoints;
  const step = decimated ? Math.ceil(rows.length / maxPoints) : 1;
  const kept = decimated ? rows.filter((_, i) => i % step === 0) : rows;

  return {
    depthMnemonic: las.depth.mnemonic,
    depthUnit: las.depth.unit,
    from: depthFrom ?? null,
    to: depthTo ?? null,
    depths: kept.map((i) => depthCol[i]),
    curves: picked.map((c) => {
      const col = las.data?.[c.idx] ?? [];
      return {
        curve: c.mnemonic,
        unit: c.unit,
        // null, not a sentinel: a LAS null (-999.25) is "not logged here", and
        // dropping the row instead would break alignment with the other curves.
        values: kept.map((i) => (Number.isFinite(col[i]) ? col[i] : null)),
      };
    }),
    missing,
    count: rows.length,
    decimated,
  };
}
