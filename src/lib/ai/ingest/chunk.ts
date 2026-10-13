import "server-only";

/**
 * Split an already-transcribed document into extraction-sized chunks so a single
 * per-type extraction call can never truncate: one giant JSON array (e.g. five
 * years of daily tank gauges) overruns the model's output-token ceiling, the
 * reply is cut off mid-array, JSON.parse throws, and the WHOLE type is dropped.
 * Chunking bounds each call's output, and the caller extracts the chunks in
 * parallel and concatenates their rows — so no file is too big to process, and a
 * single overrun costs at most one chunk's slice, not the entire type.
 */

/** Max characters of SOURCE text per chunk. Deliberately small: a chunk of dense,
 * one-row-per-line data expands to roughly 3x its size once re-emitted as JSON
 * (every field name repeats per row), so the budget is set against the extract
 * call's OUTPUT-token cap, not its input — sizing by input is what let a readings
 * chunk still truncate while the sparser run-ticket chunks came through. */
export const CHUNK_BUDGET_CHARS = 12_000;

/** Leading lines repeated atop every chunk after the first, so a table's column
 * headers survive the split and later chunks' bare data rows stay interpretable. */
const PREAMBLE_LINES = 8;

/** Does the head of the document read as delimited tabular data (CSV / table)?
 * Only then is a header preamble meaningful; prose gets none, to avoid the model
 * re-proposing the preamble's first lines as records in every chunk. */
function looksTabular(lines: string[]): boolean {
  const sample = lines.slice(0, 10).filter((l) => l.trim());
  if (sample.length === 0) return false;
  const delimited = sample.filter(
    (l) => (l.match(/[,\t]/g)?.length ?? 0) >= 2
  ).length;
  return delimited >= Math.ceil(sample.length / 2);
}

/**
 * Break `text` into chunks no larger than `budget` chars, splitting only on line
 * boundaries so a record is never cut in half. A document already under budget
 * returns as a single chunk (identity — no behavior change for normal files).
 * For tabular sources, the first {@link PREAMBLE_LINES} lines (the header row and
 * a few examples) are prepended to every later chunk so column meaning carries.
 */
export function chunkDocument(
  text: string,
  budget: number = CHUNK_BUDGET_CHARS
): string[] {
  if (text.length <= budget) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const line of lines) {
    // +1 for the "\n" we rejoin with. Flush before pushing so a chunk that is
    // already at budget starts a fresh one; a lone over-budget line (rare) still
    // becomes its own chunk rather than looping forever.
    if (size + line.length + 1 > budget && buf.length > 0) {
      chunks.push(buf.join("\n"));
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length > 0) chunks.push(buf.join("\n"));
  if (chunks.length <= 1) return chunks;

  if (!looksTabular(lines)) return chunks;
  const preamble = lines.slice(0, PREAMBLE_LINES).join("\n");
  return chunks.map((c, i) => (i === 0 ? c : `${preamble}\n${c}`));
}

/**
 * Map over items with a bounded number of in-flight tasks, preserving input
 * order in the result. Lets the caller fan out every (type, chunk) extraction at
 * once without opening an unbounded number of concurrent model calls.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
