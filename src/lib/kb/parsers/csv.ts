/**
 * Minimal CSV / TSV parser that produces a schema + per-column summary stats.
 * Handles quoted fields and the common comma/tab/semicolon delimiters. Not a
 * full RFC-4180 implementation — enough to summarise tabular project data and
 * pull columns for analysis without bringing in a dependency.
 */

export interface CsvColumn {
  name: string;
  /** True when every non-empty value parsed as a finite number. */
  numeric: boolean;
  min: number | null;
  max: number | null;
  mean: number | null;
  count: number;
  emptyCount: number;
  /** A few distinct example values, for orientation. */
  sample: string[];
}

export interface ParsedCsv {
  headers: string[];
  rowCount: number;
  delimiter: string;
  columns: CsvColumn[];
  /** Row-major cell values, present only when parsed with `includeData`. */
  rows?: string[][];
}

const DELIMITERS = [",", "\t", ";", "|"];

/** Pick the delimiter that yields the most columns on the header line. */
function detectDelimiter(headerLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = splitLine(headerLine, d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Split one line on a delimiter, honouring double-quoted fields. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function isCsv(name: string): boolean {
  return /\.(csv|tsv)$/i.test(name);
}

export function parseCsv(text: string, includeData = false): ParsedCsv {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rowCount: 0, delimiter: ",", columns: [] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delimiter);
  const bodyLines = lines.slice(1);

  const accum = headers.map(() => ({
    numeric: true,
    seenValue: false,
    min: Infinity,
    max: -Infinity,
    sum: 0,
    count: 0,
    emptyCount: 0,
    sample: [] as string[],
  }));
  const rows: string[][] | undefined = includeData ? [] : undefined;

  for (const line of bodyLines) {
    const cells = splitLine(line, delimiter);
    if (rows) rows.push(cells);
    for (let i = 0; i < headers.length; i++) {
      const raw = (cells[i] ?? "").trim();
      const a = accum[i];
      if (raw === "") {
        a.emptyCount++;
        continue;
      }
      a.seenValue = true;
      if (a.sample.length < 5 && !a.sample.includes(raw)) a.sample.push(raw);
      const n = Number(raw);
      if (Number.isFinite(n)) {
        a.count++;
        a.sum += n;
        if (n < a.min) a.min = n;
        if (n > a.max) a.max = n;
      } else {
        a.numeric = false;
      }
    }
  }

  const columns: CsvColumn[] = headers.map((name, i) => {
    const a = accum[i];
    const numeric = a.numeric && a.seenValue && a.count > 0;
    return {
      name,
      numeric,
      min: numeric ? a.min : null,
      max: numeric ? a.max : null,
      mean: numeric ? a.sum / a.count : null,
      count: a.count,
      emptyCount: a.emptyCount,
      sample: a.sample,
    };
  });

  return {
    headers,
    rowCount: bodyLines.length,
    delimiter,
    columns,
    rows,
  };
}
