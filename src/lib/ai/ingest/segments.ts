import type { PageCategory, PageVerdict } from "@/lib/ai/ingest/classify-pages";

/**
 * Group classified pages into SEGMENTS — runs of contiguous pages that form one
 * logical document and get routed together.
 *
 * Pure module (no server imports, no model calls) so every rule below is
 * unit-testable, because the rules are where this phase succeeds or fails.
 *
 * The asymmetry that drives every decision here: a wrong SPLIT is expensive and
 * a wrong MERGE is cheap. Splitting a form in half sends each piece to its own
 * extraction call, and any record that spans the boundary is lost outright.
 * Merging two unrelated forms only hands the extractor some text it will filter
 * out anyway — the per-type prompts already reject content that isn't theirs.
 * So every ambiguous case below resolves toward merging.
 */

/** Below this, the classifier is guessing and must not START a new segment. */
export const MIN_SPLIT_CONFIDENCE = 0.5;

export interface Segment {
  category: PageCategory;
  /** 1-based page numbers, contiguous and ascending. */
  pages: number[];
  /** The segment's pages joined with a blank line. */
  text: string;
  /** Confidence of the verdict that STARTED this segment. */
  confidence: number;
}

/** A page that never starts a segment and only ever attaches to one. */
function isAttaching(category: PageCategory): boolean {
  return category === "continuation" || category === "blank";
}

/**
 * Group pages into segments.
 *
 * Rules, in the order they apply to each page:
 *  - the first non-attaching page always starts a segment, whatever its
 *    confidence — something has to;
 *  - `continuation` and `blank` attach to the open segment (a leading run of
 *    them, with nothing to attach to, starts one as `other`);
 *  - the same category as the open segment merges — five consecutive run
 *    tickets are one segment, and extraction over five pages returns five rows,
 *    which is both cheaper and more accurate than five separate calls;
 *  - a different category below {@link MIN_SPLIT_CONFIDENCE} merges rather than
 *    splitting, per the asymmetry above;
 *  - anything else starts a new segment.
 *
 * A trailing run of `blank` pages is dropped rather than padding the last
 * segment with empty text.
 */
export function groupSegments(
  pages: string[],
  verdicts: PageVerdict[]
): Segment[] {
  const segments: Segment[] = [];

  pages.forEach((text, i) => {
    const verdict = verdicts[i] ?? {
      page: i + 1,
      category: "other" as PageCategory,
      confidence: 0,
      why: "",
    };
    const open = segments[segments.length - 1];
    const attach =
      open !== undefined &&
      (isAttaching(verdict.category) ||
        verdict.category === open.category ||
        verdict.confidence < MIN_SPLIT_CONFIDENCE);

    if (attach) {
      open.pages.push(i + 1);
      return;
    }
    segments.push({
      // A leading `continuation` has nothing to continue, and a leading `blank`
      // is not a document — both become an ordinary unknown segment.
      category: isAttaching(verdict.category) ? "other" : verdict.category,
      pages: [i + 1],
      text: "",
      confidence: verdict.confidence,
    });
  });

  // Drop trailing blanks, then materialise each segment's text.
  for (const segment of segments) {
    while (segment.pages.length > 1) {
      const last = segment.pages[segment.pages.length - 1];
      if (!isBlank(pages[last - 1])) break;
      segment.pages.pop();
    }
    segment.text = segment.pages
      .map((p) => pages[p - 1])
      .filter((t) => t.trim().length > 0)
      .join("\n\n");
  }

  // A segment that is nothing but blank pages carries no document.
  return segments.filter((s) => s.text.trim().length > 0);
}

function isBlank(text: string | undefined): boolean {
  return (text ?? "").trim().length === 0;
}

/**
 * One whole-document segment — the shape used when there is no page structure
 * to work with (a spreadsheet, or a transcription whose page markers did not
 * reconcile). Routed exactly as the pipeline behaved before segmentation.
 */
export function wholeDocumentSegment(text: string): Segment {
  return { category: "other", pages: [], text, confidence: 0 };
}

/**
 * Merge adjacent segments until at most `max` remain, so a classifier that
 * alternates categories page-by-page across a long file cannot spawn one
 * routing decision per page.
 *
 * Merges the smallest adjacent pair first, preferring pairs that share a
 * category — those are free (they were only separated by a spurious split),
 * while a cross-category merge costs the extractor some noise.
 */
export function capSegments(segments: Segment[], max: number): Segment[] {
  if (segments.length <= max) return segments;
  const out = segments.map((s) => ({ ...s, pages: [...s.pages] }));

  while (out.length > max) {
    let bestAt = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i++) {
      const size = out[i].pages.length + out[i + 1].pages.length;
      // Same-category pairs sort ahead of every cross-category pair.
      const cost = out[i].category === out[i + 1].category ? size : size + 1000;
      if (cost < bestCost) {
        bestCost = cost;
        bestAt = i;
      }
    }
    const [a, b] = [out[bestAt], out[bestAt + 1]];
    out.splice(bestAt, 2, {
      // Keep the more confident label; a merged pair is routed as one thing.
      category: a.confidence >= b.confidence ? a.category : b.category,
      pages: [...a.pages, ...b.pages],
      text: [a.text, b.text].filter(Boolean).join("\n\n"),
      confidence: Math.min(a.confidence, b.confidence),
    });
  }
  return out;
}
