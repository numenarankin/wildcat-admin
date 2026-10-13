/**
 * Minimal LAS (Log ASCII Standard) parser for well-log files. Handles the
 * common v1.2 / v2.0 layout: `~`-prefixed sections with `MNEM.UNIT value :desc`
 * info lines and a `~ASCII` numeric data block.
 *
 * We parse the header (well info + curve definitions) and stream per-curve
 * summary statistics. Raw curve arrays are only materialised on demand
 * (`includeData`) so analytic tools can pull a depth window without us holding
 * every curve in memory during indexing.
 */

export interface LasCurve {
  mnemonic: string;
  unit: string;
  description: string;
}

export interface LasCurveStats {
  mnemonic: string;
  unit: string;
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Non-null sample count. */
  count: number;
  nullCount: number;
}

export interface ParsedLas {
  /** Well-info section, mnemonic → value (e.g. WELL, FLD, LOC, API, SRVC). */
  well: Record<string, string>;
  /** Parameter section, mnemonic → value. */
  params: Record<string, string>;
  curves: LasCurve[];
  /** The LAS-declared absent-value (NULL), default -999.25. */
  nullValue: number;
  depth: {
    mnemonic: string;
    unit: string;
    start: number | null;
    stop: number | null;
    step: number | null;
  };
  rowCount: number;
  stats: LasCurveStats[];
  /**
   * Raw `~Other` (`~O`) lines, trimmed, in file order; blanks and `#` comments
   * skipped. MainLog mud logs put lithology, descriptions and shows here.
   */
  other: string[];
  /** Column-major curve data, present only when parsed with `includeData`. */
  data?: number[][];
}

const SECTION_RE = /^~\s*([A-Za-z])/;

/** Parse one `MNEM.UNIT  value : description` info line. */
function parseInfoLine(
  line: string
): { mnemonic: string; unit: string; value: string; description: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const dot = trimmed.indexOf(".");
  if (dot < 0) return null;

  const mnemonic = trimmed.slice(0, dot).trim();
  const colon = trimmed.indexOf(":", dot);
  const description = colon >= 0 ? trimmed.slice(colon + 1).trim() : "";
  const middle = (colon >= 0 ? trimmed.slice(dot + 1, colon) : trimmed.slice(dot + 1));

  // The unit runs from just after the dot to the first whitespace; the
  // remainder (before the colon) is the value.
  const ws = middle.search(/\s/);
  const unit = (ws < 0 ? middle : middle.slice(0, ws)).trim();
  const value = (ws < 0 ? "" : middle.slice(ws)).trim();
  return { mnemonic, unit, value, description };
}

function toNumber(v: string): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Does this text look like a LAS file? A `.las` name, or `~V` and `~A`/`~Curve`
 * within the first 2,000 characters, or a line starting `~V` within them and a
 * line starting `~C` or `~A` anywhere. The last rule catches a long `~Well`
 * (a MainLog rendition's, say) pushing `~Curve` past the head; requiring both
 * markers at line starts keeps prose that merely mentions them out.
 */
export function isLas(name: string, text: string): boolean {
  if (/\.las$/i.test(name)) return true;
  const head = text.slice(0, 2000);
  if (/~V(ersion)?/i.test(head) && /~(A(SCII)?|Curve)/i.test(head)) return true;
  return /^[ \t]*~V/im.test(head) && /^[ \t]*~[AC]/im.test(text);
}

export function parseLas(text: string, includeData = false): ParsedLas {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const well: Record<string, string> = {};
  const params: Record<string, string> = {};
  const curves: LasCurve[] = [];
  let nullValue = -999.25;
  let section = "";
  const dataLines: string[] = [];
  const other: string[] = [];

  for (const line of lines) {
    const sec = line.match(SECTION_RE);
    if (sec) {
      section = sec[1].toUpperCase();
      continue;
    }
    if (!line.trim() || line.trim().startsWith("#")) continue;

    if (section === "A") {
      dataLines.push(line.trim());
      continue;
    }
    if (section === "O") {
      other.push(line.trim());
      continue;
    }
    const info = parseInfoLine(line);
    if (!info) continue;

    if (section === "W") {
      well[info.mnemonic] = info.value;
      if (info.mnemonic.toUpperCase() === "NULL") {
        const n = toNumber(info.value);
        if (n !== null) nullValue = n;
      }
    } else if (section === "C") {
      curves.push({
        mnemonic: info.mnemonic,
        unit: info.unit,
        description: info.description,
      });
    } else if (section === "P") {
      params[info.mnemonic] = info.value;
    }
  }

  const depthCurve = curves[0];
  const depth = {
    mnemonic: depthCurve?.mnemonic ?? "DEPT",
    unit: depthCurve?.unit ?? well.STRT_UNIT ?? "",
    start: toNumber(well.STRT ?? ""),
    stop: toNumber(well.STOP ?? ""),
    step: toNumber(well.STEP ?? ""),
  };

  // Stream stats (and optionally collect data) over the ASCII block.
  const n = curves.length;
  const accum = curves.map(() => ({
    min: Infinity,
    max: -Infinity,
    sum: 0,
    count: 0,
    nullCount: 0,
  }));
  const data: number[][] | undefined = includeData
    ? curves.map(() => [])
    : undefined;

  let rowCount = 0;
  for (const dl of dataLines) {
    const cells = dl.split(/\s+/).filter((c) => c.length > 0);
    if (cells.length === 0) continue;
    rowCount++;
    for (let i = 0; i < n; i++) {
      const v = toNumber(cells[i] ?? "");
      const a = accum[i];
      if (v === null || v === nullValue) {
        a.nullCount++;
        if (data) data[i].push(NaN);
        continue;
      }
      a.count++;
      a.sum += v;
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
      if (data) data[i].push(v);
    }
  }

  const stats: LasCurveStats[] = curves.map((c, i) => {
    const a = accum[i];
    return {
      mnemonic: c.mnemonic,
      unit: c.unit,
      min: a.count > 0 ? a.min : null,
      max: a.count > 0 ? a.max : null,
      mean: a.count > 0 ? a.sum / a.count : null,
      count: a.count,
      nullCount: a.nullCount,
    };
  });

  return { well, params, curves, nullValue, depth, rowCount, stats, other, data };
}
