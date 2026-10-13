/**
 * Structured, greppable logging for the proactive-ingest pipeline. Every line is
 * prefixed `[ingest]` so the whole flow (upload -> triage -> extract -> write)
 * can be filtered from the server log with one grep, and every payload is
 * JSON-encoded so it stays on one line and is machine-parseable.
 *
 * Use `ilog` for progress, `ierr` for failures (pass `errorInfo(err)` in the
 * extra to capture name/message/cause/stack), and `timed` to wrap any awaited
 * step so its wall-clock duration is always recorded. Pure of app deps so it is
 * safe to import from anywhere in the pipeline.
 */

import type { ContentPart } from "@/lib/ai/document-part";

/** Info-level pipeline log. `extra` is JSON-encoded onto the same line. */
export function ilog(msg: string, extra?: Record<string, unknown>): void {
  console.info(`[ingest] ${msg}`, extra ? JSON.stringify(extra) : "");
}

/** Error-level pipeline log. Pass `errorInfo(err)` in `extra` for full detail. */
export function ierr(msg: string, extra?: Record<string, unknown>): void {
  console.error(`[ingest] ${msg}`, extra ? JSON.stringify(extra) : "");
}

/**
 * Flatten an unknown thrown value into a loggable object: the error's name,
 * message, a short stack, and its `cause` (the field the AI SDK hides the real
 * provider error in, e.g. "Grammar compilation timed out"). Spread into an
 * `ierr` extra so a failure is diagnosable instead of a bare message.
 *
 * Postgrest errors are plain objects, not `Error`s — `String(err)` on one is
 * "[object Object]", which is how a NOT NULL violation reached the log as no
 * information at all. Their `code`/`message`/`details`/`hint` are carried
 * through instead, since the code is the whole diagnosis (23502 null column,
 * 23505 duplicate key, 42501 RLS).
 */
export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const cause = err.cause;
    return {
      errName: err.name,
      errMessage: err.message,
      errStack: err.stack?.split("\n").slice(0, 5).join(" | "),
      errCause:
        cause instanceof Error
          ? { name: cause.name, message: cause.message }
          : cause !== undefined
            ? String(cause)
            : undefined,
    };
  }
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of ["code", "message", "details", "hint"] as const) {
      if (e[k] !== undefined && e[k] !== null) picked[`err${k[0].toUpperCase()}${k.slice(1)}`] = e[k];
    }
    // An object with none of those keys still has to be readable, so fall back
    // to its JSON rather than the useless "[object Object]".
    if (Object.keys(picked).length > 0) return picked;
    try {
      return { errValue: JSON.stringify(err) };
    } catch {
      return { errValue: String(err) };
    }
  }
  return { errValue: String(err) };
}

/** One-line descriptor of a model content part (kind + size) for logging. */
export function describePart(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") return { partKind: "text", chars: part.text.length };
  if (part.type === "file")
    return {
      partKind: "file",
      bytes: part.data.byteLength,
      mediaType: part.mediaType,
    };
  return { partKind: "image", bytes: part.image.byteLength };
}

/**
 * Wrap an awaited step so its start, duration, and outcome are always logged.
 * On success logs `<label>: done {ms,...summary}` (summary derived from the
 * result); on throw logs `<label>: FAILED {ms, ...errorInfo}` and re-throws so
 * the caller still handles it. `Date.now()` is fine here (plain server code).
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: {
    begin?: Record<string, unknown>;
    summary?: (result: T) => Record<string, unknown>;
  }
): Promise<T> {
  const start = Date.now();
  ilog(`${label}: begin`, opts?.begin);
  try {
    const result = await fn();
    ilog(`${label}: done`, {
      ms: Date.now() - start,
      ...(opts?.summary?.(result) ?? {}),
    });
    return result;
  } catch (err) {
    ierr(`${label}: FAILED`, { ms: Date.now() - start, ...errorInfo(err) });
    throw err;
  }
}
