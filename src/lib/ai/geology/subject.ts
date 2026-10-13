/**
 * Which log is this geology turn about.
 *
 * The router says a turn is geology; it does not say which file. Orion addresses
 * LAS files by `fileId` (see `readLasText`), so that is what the harness needs
 * before it can do anything.
 *
 * Three places to look, most specific first:
 *
 *   1. The page the user is on. `buildPageContext` writes "file id: <id>" when a
 *      file is open or selected, which is the strongest signal there is — they
 *      are looking at it.
 *   2. The conversation. A LAS read earlier in the thread is almost always the
 *      log still under discussion, and it survives the user navigating away.
 *   3. The project folder — matched against the question when there is more than
 *      one log in it.
 *
 * Finding nothing is a normal outcome, not an error: "what does high GR mean"
 * is a geology question with no log attached, and it belongs on the general
 * path. The caller treats null as "not for the harness".
 *
 * ## What went wrong here, twice, and what it means for changing this file
 *
 * Both rules below were originally written against what the schema SAID rather
 * than what the rows CONTAIN, and both failed on the first real question.
 *
 *   - The page rule required the marker "(LAS)". `buildPageContext` writes the
 *     file's `type`, and an uploaded well log is typed `doc` — the value `las`
 *     exists in the union and is not what the uploader assigns. So the marker
 *     never appeared, and selecting the log did nothing.
 *   - The folder rule required EXACTLY ONE log, treating two as ambiguous. Real
 *     projects hold "Repass 2.las" and "Repass 2 (1).las" — the same log, kept
 *     twice. Ambiguity in the strict sense; not in any sense the operator means.
 *
 * Both failed the same way: silently, into the no-log path, producing a
 * confident answer about a well whose log was sitting right there. Match on the
 * FILENAME, which is the thing the operator controls and can see.
 */
import type { UIMessage } from "ai";

export interface LasSubject {
  fileId: string;
  /** How it was found, for the turn log. */
  via: "page" | "history" | "folder" | "library";
  name?: string;
}

/** Tools that take a `fileId` naming a LAS file. */
const LAS_TOOLS = ["read_las_full", "get_curves_data", "get_curve_data"];

export function subjectFromPageContext(pageContext?: string): LasSubject | null {
  if (!pageContext) return null;
  const name = /the file "([^"]+)"/i.exec(pageContext)?.[1];
  // The FILENAME, not the type marker. See the note above: an uploaded log is
  // typed `doc`, so `(LAS)` never appears and this rule matched nothing.
  if (!name || !isLas(name)) return null;
  const m = /file id:\s*([\w-]+)/i.exec(pageContext);
  if (!m) return null;
  return { fileId: m[1], via: "page", name };
}

/**
 * The extensions of a well log. A MainLog mud log (`.mlw`, or the `.ml_` /
 * `.td_` bundles) is read through its LAS rendition, so it is a log here too.
 */
const LOG_EXT = /\.(las|mlw|ml_|td_)\b/i;

/** A log by its name. The extension is the only reliable signal there is. */
export function isLas(name: string): boolean {
  return LOG_EXT.test(name);
}

/**
 * Score a filename against the question.
 *
 * Not fuzzy matching for its own sake — the operator names the well in the
 * question ("the Repass 2 well") and the file is named after the well. Word
 * overlap is the whole mechanism, and it is deliberately dumb: it ranks, and the
 * caller only uses the ranking to break a tie between logs it already has.
 */
function nameScore(fileName: string, prompt: string): number {
  const words = fileName
    .replace(/\.(las|mlw|ml_|td_)\b.*$/i, "")
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length > 1);
  if (words.length === 0) return 0;
  const haystack = prompt.toLowerCase();
  return words.filter((w) => haystack.includes(w.toLowerCase())).length / words.length;
}

/**
 * The most recent LAS read in this thread.
 *
 * Walks backwards: in a conversation that moved from one log to another, the
 * later one is the subject.
 */
export function subjectFromHistory(messages: UIMessage[]): LasSubject | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as { type?: string; input?: unknown };
      if (typeof part.type !== "string" || !part.type.startsWith("tool-")) continue;
      if (!LAS_TOOLS.includes(part.type.slice("tool-".length))) continue;
      const fileId = (part.input as { fileId?: string } | undefined)?.fileId;
      if (fileId) return { fileId, via: "history" };
    }
  }
  return null;
}

/**
 * The log in the project folder that the question is about.
 *
 * One log: that one. Several: the one whose name the question names. This is
 * the common case on a project page — nothing is selected, the logs are simply
 * in the project, and the operator says which well they mean in words.
 *
 * A tie is broken by the shortest name, which picks "Repass 2.las" over
 * "Repass 2 (1).las" — duplicate uploads of the same log, where either answer is
 * right and having none is wrong. Nothing matching the question at all resolves
 * to null: several DIFFERENT wells and no clue which is genuine ambiguity.
 */
export function subjectFromFolder(
  files: { id: string; name: string }[],
  prompt = ""
): LasSubject | null {
  const logs = files.filter((f) => isLas(f.name));
  if (logs.length === 0) return null;
  if (logs.length === 1) return { fileId: logs[0].id, via: "folder", name: logs[0].name };

  const ranked = logs
    .map((f) => ({ f, score: nameScore(f.name, prompt) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.f.name.length - b.f.name.length);

  const best = ranked[0];
  if (!best) return null;
  return { fileId: best.f.id, via: "folder", name: best.f.name };
}

/**
 * Every log in the library, ranked against the question.
 *
 * The fourth lookup, and the one that closes the hole the other three left. The
 * page rule needs the file open, the history rule needs it already read, and the
 * folder rule needs a project: in the drawer, on any other page, asking about a
 * log by name resolved to nothing and the harness answered that it had no log.
 *
 * Same scoring and the same shortest-name tie-break `subjectFromFolder` uses, so
 * "Repass 2.las" beats "Repass 2 (1).las" and a genuinely ambiguous pair
 * resolves to null with both returned as candidates.
 */
export function subjectFromLibrary(
  files: { id: string; name: string }[],
  prompt: string
): LasSubject | null {
  /*
   * The library is not a project folder, and the difference is this line.
   *
   * `subjectFromFolder` resolves a lone log outright, with no reference to the
   * question: you are IN a project holding one log, so "the log" means that one.
   * Applied to the whole library that rule captures everything — an operator
   * with a single LAS anywhere in their files had "why does the neutron read
   * high in gas" resolve onto that well and answered from its curves. A general
   * question came back about somebody's actual reservoir.
   *
   * So the library requires the question to point at a log first. After that the
   * lone-log shortcut is right again.
   */
  if (!pointsAtALog(prompt, files)) return null;
  const found = subjectFromFolder(files, prompt);
  return found ? { ...found, via: "library" } : null;
}

/**
 * Deictic references to a log the resolver could not pin.
 *
 * "analyze this LAS" names no well and matches no filename, but it is plainly
 * about a log. These are the phrasings that mean one without naming it.
 */
const POINTS_AT_A_LOG =
  /\b(this|that|the|my|our)\s+(las|log|well\s*log|curve|file)\b|\bmy\s+well\b/i;

/**
 * Does the question point at a specific log at all?
 *
 * This gates whether the candidate list is shown to the model on the no-log
 * path, and it exists because the prompt could not do the job. Told "these logs
 * are in the library, read one only if the question is about it", Fable read the
 * only log around and put one operator's numbers into an answer about how the
 * neutron tool behaves. Naming a file in the system prompt makes it salient
 * however carefully the sentence around it is hedged.
 *
 * So a general question is not shown the list. It gets the original no-log
 * contract, which is the one written for it.
 */
export function pointsAtALog(
  prompt: string,
  candidates: readonly { id: string; name: string }[]
): boolean {
  if (POINTS_AT_A_LOG.test(prompt)) return true;
  return candidates.some((c) => nameScore(c.name, prompt) > 0);
}

/**
 * Which log, and what else it could have been.
 *
 * The candidate list matters as much as the winner. When nothing resolves, it is
 * what lets the no-log prompt name the logs that DO exist and hand the reading
 * back to the model, instead of asserting there is no log at all.
 */
export interface SubjectResolution {
  subject: LasSubject | null;
  /** Every LAS in reach this turn, whether or not one of them won. */
  candidates: { id: string; name: string }[];
}

export async function resolveSubject(input: {
  pageContext?: string;
  messages: UIMessage[];
  folderFiles?: { id: string; name: string }[];
  /** The question, used only to pick between several logs. */
  prompt?: string;
  /**
   * The library lookup, injected.
   *
   * A parameter rather than a direct import because this module is otherwise
   * pure and unit-testable, and because the caller already knows whether it is
   * in a request scope that can reach Supabase.
   */
  lasFiles?: () => Promise<{ id: string; name: string }[]>;
}): Promise<SubjectResolution> {
  const prompt = input.prompt ?? "";
  const local = input.folderFiles ?? [];

  const pinned =
    subjectFromPageContext(input.pageContext) ??
    subjectFromHistory(input.messages) ??
    (local.length > 0 ? subjectFromFolder(local, prompt) : null);

  // The library read is skipped when a log is already pinned AND the folder
  // already answered, because neither the winner nor the candidate list would
  // change. It is not skipped merely because something is pinned: a page
  // selection still benefits from the list when the model has to choose.
  let library: { id: string; name: string }[] = [];
  if (input.lasFiles) {
    try {
      library = await input.lasFiles();
    } catch (err: unknown) {
      // A library that cannot be read costs the fourth lookup, never the turn.
      console.warn("geology:las-library-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const candidates = dedupeById([...local.filter((f) => isLas(f.name)), ...library]);
  const subject = pinned ?? subjectFromLibrary(candidates, prompt);
  return { subject, candidates };
}

function dedupeById(
  files: { id: string; name: string }[]
): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const f of files) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * The identity the evaluation is keyed on.
 *
 * The real API number comes out of the LAS header, which has not been read yet
 * when the turn starts — so a file-scoped identity stands in. Stage 0 skips its
 * header-vs-request identity check for these, because there is nothing to
 * disagree with: `file:` means "we did not claim to know the API".
 */
export function subjectIdentity(subject: LasSubject): string {
  return `file:${subject.fileId}`;
}

export function isFileIdentity(api: string): boolean {
  return api.startsWith("file:");
}
