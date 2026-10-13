/**
 * The knowledge base and its two-level table of contents.
 *
 * Level 1 is `toc/TOC.md`: one card per document, ~33K tokens, held resident by
 * the gatherer. Level 2 is `toc/<section>/<slug>.md`: section-level entries with
 * exact character offsets into the corpus file, opened on demand. Level 3 is the
 * corpus document itself, read by offset.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. CHUNKS ARE VERBATIM. The gatherer returns source text, never a summary — a
 *    summarized chunk is an unattributable claim by the time Fable sees it. So a
 *    read here is a byte slice of the corpus file, and nothing in this module
 *    rewrites, trims, or reflows it.
 *
 * 2. THE INDEX MATCHES THE CORPUS. Every offset in the TOC was computed against
 *    a specific version of the document. If the corpus is rebuilt and the TOC is
 *    not, those offsets still parse, still fall inside the file, and quietly
 *    return the wrong passage. `build_toc.py` records a content hash per
 *    document in `toc/.doc-hashes.json`, so the check is exact and free:
 *    re-hash the file and compare. Drift is an error, not a warning — a
 *    plausible chunk from the wrong offsets is worse than no chunk.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DocumentCard {
  slug: string;
  section: string;
  covers: string;
  authoritativeFor: string[];
  notGoodFor: string[];
  scope: string;
  segments: number;
}

export interface SegmentEntry {
  /** `section/slug#index` — the ID the model selects and the chunk carries. */
  id: string;
  section: string;
  slug: string;
  index: number;
  heading: string;
  /** The questions this segment answers. What retrieval actually matches on. */
  answers: string[];
  entities: string[];
  equations: string[];
  start: number;
  end: number;
}

export interface Chunk {
  id: string;
  section: string;
  slug: string;
  heading: string;
  start: number;
  end: number;
  /** Verbatim slice of the corpus file. Never rewritten. */
  text: string;
}

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

/** The index and the corpus disagree: the TOC was built against other text. */
export class CorpusDriftError extends CorpusError {
  constructor(slug: string, expected: string, actual: string) {
    super(
      `corpus drift on "${slug}": TOC was built against ${expected}, file hashes ${actual}. ` +
        `Re-run build_toc.py; every offset for this document is suspect.`
    );
    this.name = "CorpusDriftError";
  }
}

export interface CorpusPaths {
  /** Directory holding `<section>/<slug>.md`. */
  knowledgeBase: string;
  /** Directory holding `TOC.md`, `<section>/<slug>.md`, `.doc-hashes.json`. */
  toc: string;
}

/** Matches `build_toc.py`'s `doc_hash`: sha256 of the UTF-8 text, first 12 hex. */
export function docHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

export class Corpus {
  private cards: DocumentCard[] | null = null;
  private level1Text: string | null = null;
  private hashes: Record<string, string> | null = null;
  private readonly details = new Map<string, SegmentEntry[]>();
  private readonly files = new Map<string, string>();

  constructor(private readonly paths: CorpusPaths) {}

  /** Raw `TOC.md`. This is the text the gatherer holds resident. */
  async level1(): Promise<string> {
    if (this.level1Text === null) {
      this.level1Text = await readFile(path.join(this.paths.toc, "TOC.md"), "utf8");
    }
    return this.level1Text;
  }

  async documentCards(): Promise<DocumentCard[]> {
    if (this.cards) return this.cards;
    this.cards = parseIndex(await this.level1());
    return this.cards;
  }

  async card(slug: string): Promise<DocumentCard | undefined> {
    return (await this.documentCards()).find((c) => c.slug === slug);
  }

  /** Level 2 for one document. Opened on demand, then held for the turn. */
  async detail(section: string, slug: string): Promise<SegmentEntry[]> {
    const key = `${section}/${slug}`;
    const cached = this.details.get(key);
    if (cached) return cached;

    const text = await readFile(path.join(this.paths.toc, section, `${slug}.md`), "utf8").catch(() => {
      throw new CorpusError(`no TOC detail for ${key}`);
    });
    const entries = parseDetail(text, section, slug);
    this.details.set(key, entries);
    return entries;
  }

  /**
   * Read one segment verbatim.
   *
   * Verifies the document hash before slicing. That check is what separates
   * "the passage the TOC promised" from "whatever now lives at those offsets".
   */
  async read(ref: string): Promise<Chunk> {
    const parsed = parseRef(ref);
    const entries = await this.detail(parsed.section, parsed.slug);
    const entry = entries.find((e) => e.index === parsed.index);
    if (!entry) throw new CorpusError(`no segment ${ref} in the TOC`);

    const text = await this.document(parsed.section, parsed.slug);
    if (entry.end > text.length) {
      throw new CorpusError(
        `segment ${ref} ends at ${entry.end} but ${parsed.slug} is ${text.length} chars`
      );
    }
    return {
      id: entry.id,
      section: entry.section,
      slug: entry.slug,
      heading: entry.heading,
      start: entry.start,
      end: entry.end,
      text: text.slice(entry.start, entry.end),
    };
  }

  /** The corpus document itself, hash-verified against the TOC's ledger. */
  async document(section: string, slug: string): Promise<string> {
    const key = `${section}/${slug}`;
    const cached = this.files.get(key);
    if (cached !== undefined) return cached;

    const text = await readFile(path.join(this.paths.knowledgeBase, section, `${slug}.md`), "utf8").catch(
      () => {
        throw new CorpusError(`no corpus document ${key}`);
      }
    );
    const expected = (await this.docHashes())[slug];
    if (expected) {
      const actual = docHash(text);
      if (actual !== expected) throw new CorpusDriftError(slug, expected, actual);
    }
    this.files.set(key, text);
    return text;
  }

  private async docHashes(): Promise<Record<string, string>> {
    if (this.hashes) return this.hashes;
    const raw = await readFile(path.join(this.paths.toc, ".doc-hashes.json"), "utf8").catch(() => "{}");
    this.hashes = JSON.parse(raw) as Record<string, string>;
    return this.hashes;
  }
}

/**
 * Where the library lives, and how to open it.
 *
 * `geology-corpus/` at the repo root holds the markdown and the two-level TOC —
 * the PDFs, the OCR cache and the equation sidecars are deliberately left
 * behind, which is the difference between 11 MB and half a gigabyte. An env var
 * still overrides it, for pointing a dev instance at a work-in-progress corpus.
 *
 * Two callers now — the harness and Orion's own reference tools — so the root
 * resolution lives here rather than in either of them. `null` means the library
 * is not on disk; every caller must degrade rather than throw, and each says so
 * in its own words.
 */
export function corpusRoot(): string {
  return process.env.GEOLOGY_CORPUS_ROOT ?? path.join(process.cwd(), "geology-corpus");
}

export function openCorpus(): Corpus | null {
  const root = corpusRoot();
  if (!existsSync(path.join(root, "toc", "TOC.md"))) return null;
  return new Corpus({
    knowledgeBase: path.join(root, "knowledge-base"),
    toc: path.join(root, "toc"),
  });
}

/* ------------------------------------------------------------------ *
 * Parsing. The TOC is generated markdown with a fixed shape; these are
 * deliberately strict so a format change fails loudly instead of silently
 * yielding an empty index that reads as "the corpus has nothing on that".
 * ------------------------------------------------------------------ */

export function parseRef(ref: string): { section: string; slug: string; index: number } {
  const m = /^([^/]+)\/(.+)#(\d+)$/.exec(ref.trim());
  if (!m) throw new CorpusError(`malformed segment ref "${ref}" (want section/slug#n)`);
  return { section: m[1], slug: m[2], index: Number(m[3]) };
}

function bullet(block: string, label: string): string {
  const m = new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, "m").exec(block);
  return m ? m[1].trim() : "";
}

function list(value: string): string[] {
  if (!value || value === "—") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseIndex(toc: string): DocumentCard[] {
  const cards: DocumentCard[] = [];
  let section = "";
  // Split on headings, keeping the delimiters, so each card is one block.
  const lines = toc.split("\n");
  let current: string[] | null = null;
  let slug = "";

  const flush = () => {
    if (!current || !slug) return;
    const block = current.join("\n");
    const segMatch = /·\s*(\d+)\s+segments/.exec(block);
    cards.push({
      slug,
      section,
      covers: bullet(block, "Covers"),
      authoritativeFor: list(bullet(block, "Authoritative for")),
      notGoodFor: list(bullet(block, "Not good for")),
      scope: bullet(block, "Scope"),
      segments: segMatch ? Number(segMatch[1]) : 0,
    });
    current = null;
    slug = "";
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      section = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("### ")) {
      flush();
      slug = line.slice(4).trim();
      current = [];
      continue;
    }
    current?.push(line);
  }
  flush();
  return cards;
}

/** `### heading  \`section/slug#3\` (chars 196-10041)` plus its Answers/Entities lines. */
export function parseDetail(text: string, section: string, slug: string): SegmentEntry[] {
  const entries: SegmentEntry[] = [];
  const headingRe = /^### (.*?)\s+`([^`]+)#(\d+)`\s+\(chars (\d+)-(\d+)\)$/;
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    const entry: SegmentEntry = {
      id: `${m[2]}#${m[3]}`,
      section,
      slug,
      index: Number(m[3]),
      heading: m[1].trim(),
      answers: [],
      entities: [],
      equations: [],
      start: Number(m[4]),
      end: Number(m[5]),
    };
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("### "); j++) {
      const line = lines[j];
      if (line.startsWith("Answers: ")) entry.answers = line.slice(9).split(" · ").map((s) => s.trim());
      else if (line.startsWith("Entities: ")) entry.entities = list(line.slice(10));
      else if (line.startsWith("Equations: ")) entry.equations = list(line.slice(11));
    }
    if (entry.end <= entry.start) {
      throw new CorpusError(`segment ${entry.id} has a non-positive span (${entry.start}-${entry.end})`);
    }
    entries.push(entry);
  }
  return entries;
}
