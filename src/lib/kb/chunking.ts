/**
 * Structure-aware chunking for prose documents (reports, notes, leases, OCR'd
 * PDFs), tuned for analytic retrieval rather than naive fixed windows:
 *
 *  - Splits on Markdown/HTML headings so a chunk stays within one section.
 *  - Keeps tables and fenced code blocks intact (never splits mid-row).
 *  - Prepends a context header — "[Document › Section]" — to every chunk, so a
 *    retrieved passage carries its provenance into the model's context instead
 *    of arriving as an orphaned paragraph. (Contextual retrieval.)
 */

export interface ProseChunk {
  /** Text to embed — already includes the context header. */
  content: string;
  /** Heading path this chunk came from (for metadata / citations). */
  section: string;
}

const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
const HTML_HEADING_RE = /^<h([1-6])[^>]*>(.*?)<\/h\1>\s*$/i;

function headingOf(line: string): { level: number; title: string } | null {
  const md = line.match(MD_HEADING_RE);
  if (md) return { level: md[1].length, title: md[2].trim() };
  const html = line.trim().match(HTML_HEADING_RE);
  if (html) return { level: Number(html[1]), title: stripTags(html[2]).trim() };
  return null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/**
 * Split a section body into blocks (paragraphs / whole tables / code fences).
 * Blank lines separate blocks; table rows and fenced code are never split
 * because they aren't blank-separated internally.
 */
function toBlocks(body: string): string[] {
  const lines = body.split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const joined = buf.join("\n").trim();
    if (joined) blocks.push(joined);
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

interface Section {
  heading: string;
  body: string;
}

function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let stack: string[] = [];
  let body: string[] = [];

  const push = () => {
    const joined = body.join("\n").trim();
    if (joined) sections.push({ heading: stack.join(" › "), body: joined });
    body = [];
  };

  for (const line of lines) {
    const h = headingOf(line);
    if (h) {
      push();
      stack = stack.slice(0, h.level - 1);
      stack[h.level - 1] = h.title;
      stack = stack.slice(0, h.level);
    } else {
      body.push(line);
    }
  }
  push();
  return sections;
}

/** Hard-split a block that is itself larger than the budget. */
function hardSplit(text: string, max: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

export function chunkProse(
  text: string,
  opts: { title?: string; max?: number } = {}
): ProseChunk[] {
  const max = opts.max ?? 1500;
  const title = (opts.title ?? "").trim();
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const headerFor = (heading: string): string => {
    const ctx = [title, heading].filter(Boolean).join(" › ");
    return ctx ? `[${ctx}]\n\n` : "";
  };

  const sections = splitSections(clean);
  const effectiveSections =
    sections.length > 0 ? sections : [{ heading: "", body: clean }];

  const chunks: ProseChunk[] = [];

  for (const section of effectiveSections) {
    const header = headerFor(section.heading);
    const budget = Math.max(200, max - header.length);
    const blocks = toBlocks(section.body);
    let cur = "";

    const flush = () => {
      const trimmed = cur.trim();
      if (trimmed) chunks.push({ content: header + trimmed, section: section.heading });
      cur = "";
    };

    for (const block of blocks) {
      if (block.length > budget) {
        // Oversized single block (e.g. a giant table): flush, then hard-split.
        flush();
        for (const part of hardSplit(block, budget)) {
          chunks.push({ content: header + part, section: section.heading });
        }
        continue;
      }
      const candidate = cur ? `${cur}\n\n${block}` : block;
      if (candidate.length > budget && cur) {
        flush();
        cur = block;
      } else {
        cur = candidate;
      }
    }
    flush();
  }

  return chunks;
}
