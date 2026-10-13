/**
 * Read a figure off the local disk. Development and the test suite only.
 *
 * This is a separate module for one reason: keeping the filesystem read out of
 * `/api/chat`'s static import graph. Turbopack traces a dynamic `readFile` by
 * giving up and marking the whole project as a dependency of the route — with
 * `figure-image.ts` doing the read directly, the route's file list came to 2,635
 * entries including all 319 rendered figures, which is the 161 MB bundle blowout
 * that already failed the Python function once, arriving by a different road.
 * Neither `turbopackIgnore` nor a dynamic `fs` import moved it.
 *
 * Imported dynamically, and only when `GEOLOGY_CORPUS_ROOT` names a corpus, so
 * on the deployed function this file is never reached and never traced. In
 * production the figures live in object storage; see `figure-image.ts`.
 */
import { readFile } from "node:fs/promises";

export async function readFigureFromDisk(target: string): Promise<Buffer | null> {
  try {
    return await readFile(target);
  } catch {
    // Absent by design on any host without a local corpus. Silent: on Vercel
    // this is the normal path, and a warning per figure would bury the failures
    // that matter.
    return null;
  }
}
