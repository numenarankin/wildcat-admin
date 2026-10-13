/**
 * Attach a corpus figure to the model turn as an image, not as a description.
 *
 * `figure_fetch` returns a map or cross-section. Everything else in this layer
 * returns numbers, so the tool bridge serialises results to JSON and that is the
 * right default — but a JSON blob containing the *path* of a structure-contour
 * map is useless to the thing that needs to read the contours.
 *
 * The alternative was to transcribe every plate once at ingest and answer from
 * that prose forever. That is a game of telephone: whatever the one pass missed
 * or garbled is lost silently, and every later answer inherits the loss. So the
 * index says which sheets exist and this hands over the pixels.
 *
 * ## The budget is real and deliberate
 *
 * A full-resolution page costs up to ~4,800 input tokens — a few cents per sheet
 * on the reasoning model. That is a fair price for not guessing, and it is
 * billed through AI credits. What it is not is unbounded: `MAX_IMAGES_PER_RUN`
 * stops one question from pulling twenty plates, and past the cap the tool still
 * answers with its index entry, so the turn degrades to the old behaviour rather
 * than failing.
 */
import path from "node:path";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The local corpus, when one is configured. Storage otherwise.
 *
 * Every other module in this layer defaults this to `path.join(process.cwd(),
 * "geology-corpus")`. This one deliberately does not, and the reason is the
 * bundler rather than the domain: a `process.cwd()` join inside a module that
 * also reads the filesystem makes Turbopack give up on tracing and pull the
 * *entire project* into `/api/chat`'s file list — which would drag the 161 MB of
 * figures into the Next function, the same blowout that just failed the Python
 * one. Neither `turbopackIgnore` on the join nor a dynamic `fs` import clears it;
 * removing `process.cwd()` does.
 *
 * Nothing is lost by that. On the deployed function the figures are not on disk
 * at all, so the read this guards was always going to miss there and storage was
 * always going to be the real path. Set `GEOLOGY_CORPUS_ROOT` to read them
 * locally — the test suite does, in `vitest.config.ts`.
 */
function corpusRoot(): string | null {
  return process.env.GEOLOGY_CORPUS_ROOT ?? null;
}

/**
 * The figures are the one part of the corpus that does not deploy with the code.
 *
 * 161 MB of rendered pages took the geology function's bundle to 249 MB against
 * a 250 MB ceiling, and the Next function never traced them at all — so the
 * feature worked in development, where the files are on disk, and would have
 * quietly degraded to its index entry in production, where they are not. That is
 * the worst failure shape available: no error, just a model answering about a map
 * it never saw.
 *
 * So they live in a private bucket, and this reads disk first and storage second.
 * Disk keeps development and the test suite working with no credentials; storage
 * is what production actually uses.
 */
const BUCKET = "geology-figures";

/**
 * Images one run may pull.
 *
 * Four is enough to compare a structure map against an isopach and a
 * cross-section; a turn that wants more is browsing, not answering.
 */
export const MAX_IMAGES_PER_RUN = 4;
/** Refuse to inline anything the API would reject outright. */
const MAX_IMAGE_BYTES = 9_500_000;

export interface FigureImage {
  path: string;
  mediaType: string;
}

/**
 * The image a tool result points at, if it points at one.
 *
 * Deliberately a search rather than a fixed path: the result has been through
 * the citation scrub and the dispatcher's flattening by the time it gets here,
 * and pinning an exact shape would make this break quietly the next time either
 * of those changes. The contract is narrower than it looks — an object under an
 * `image` key with a string `path` and a `media_type` — and nothing else in the
 * layer emits that.
 */
export function findFigureImage(value: unknown, depth = 0): FigureImage | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFigureImage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidate = record.image;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const image = candidate as Record<string, unknown>;
    if (typeof image.path === "string" && typeof image.media_type === "string") {
      return { path: image.path, mediaType: image.media_type };
    }
  }

  for (const entry of Object.values(record)) {
    const found = findFigureImage(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Read a figure out of the corpus as base64.
 *
 * Returns null rather than throwing on anything suspect — a path that escapes
 * the corpus, a missing file, an image over the wire limit. The caller falls
 * back to the JSON index entry, which is a worse answer but still an answer.
 */
export async function readFigureImage(image: FigureImage): Promise<string | null> {
  const configured = corpusRoot();
  if (configured) {
    const root = path.resolve(configured);
    const target = path.resolve(root, image.path);
    // The path comes out of a corpus table rather than from the model, but it
    // reaches a `readFile`, so it is checked anyway.
    if (target !== root && !target.startsWith(root + path.sep)) {
      console.warn("geology:figure-outside-corpus", { path: image.path });
      return null;
    }
    const local = await fromDisk(target, image.path);
    if (local) return local;
  }
  return fromStorage(image.path);
}

async function fromDisk(target: string, key: string): Promise<string | null> {
  // Dynamic, and in its own module: a static `readFile` here makes Turbopack
  // trace the entire project into /api/chat. See `figure-disk.ts`.
  const { readFigureFromDisk } = await import("./figure-disk");
  const bytes = await readFigureFromDisk(target);
  return bytes ? withinLimit(bytes, key) : null;
}

async function fromStorage(key: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin().storage.from(BUCKET).download(key);
    if (error || !data) {
      console.warn("geology:figure-unreadable", {
        path: key,
        error: error?.message ?? "no object returned",
      });
      return null;
    }
    return withinLimit(Buffer.from(await data.arrayBuffer()), key);
  } catch (err: unknown) {
    console.warn("geology:figure-storage-failed", {
      path: key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function withinLimit(bytes: Buffer, key: string): string | null {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    console.warn("geology:figure-too-large", { path: key, bytes: bytes.byteLength });
    return null;
  }
  return bytes.toString("base64");
}

/** Per-run image budget. Keyed on the run's deps object, which is per turn. */
const spent = new WeakMap<object, number>();

export function claimImageBudget(runKey: object): boolean {
  const used = spent.get(runKey) ?? 0;
  if (used >= MAX_IMAGES_PER_RUN) return false;
  spent.set(runKey, used + 1);
  return true;
}

export function imagesUsed(runKey: object): number {
  return spent.get(runKey) ?? 0;
}
