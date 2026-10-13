/**
 * Orion's tool traffic, in the browser console.
 *
 * ## Why this exists
 *
 * `resilient()` in `tools.ts` catches every tool throw and hands the model
 * `{ ok: false, error }` instead of failing the run. That is the right
 * behaviour — one broken lookup must not cost the whole answer — and it is also
 * why a broken tool is invisible from the outside. The model reads the refusal,
 * works around it, and writes a fluent answer that simply omits whatever it
 * could not fetch. Nothing on screen says a thing.
 *
 * The server logs it, but the server log is not where anyone is standing when
 * they notice an answer looks thin. So every failed call is a `console.warn`
 * here, in the session that produced it, whatever the answer looks like.
 *
 * ## Both paths, one logger
 *
 * The typed drawer drives `useChat` and holds a `messages` array; the voice loop
 * reads UI-message snapshots by hand. Both end up with the same `UIMessage`
 * shape carrying the same tool parts, so this takes either and dedupes by tool
 * call id — a snapshot stream re-delivers a growing message on every chunk, and
 * without that a single call would print on every token.
 *
 * Console only. Never rendered, never persisted, nothing in the product reads it.
 *
 * All `warn`, never `error`: Next's dev overlay promotes a `console.error` into
 * a full-screen panel, so a diagnostic about a degraded answer would look like a
 * crash and would interrupt the session it exists to inform.
 */
import type { UIMessage } from "ai";

const STYLE = "color:#0369a1;font-weight:600";
const ALARM = "color:#b91c1c;font-weight:600";

/**
 * Tool calls already printed, keyed by call id and state.
 *
 * Module-level rather than per-component: the drawer and the voice loop can be
 * mounted at once, and a call should print once per session regardless of which
 * surface saw it first. Bounded so a long session cannot grow it without limit.
 */
const seen = new Set<string>();
const MAX_SEEN = 5_000;

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function isToolPart(part: unknown): part is ToolPart {
  const p = part as ToolPart;
  return (
    typeof p?.type === "string" &&
    (p.type.startsWith("tool-") || p.type === "dynamic-tool")
  );
}

/** `tool-get_measure` → `get_measure`. */
function toolName(part: ToolPart): string {
  if (part.type === "dynamic-tool") return "dynamic";
  return part.type.slice("tool-".length);
}

/**
 * A tool that answered with a refusal rather than a result.
 *
 * This is the shape `resilient()` produces on a throw, and the shape the
 * ontology and analysis tools return for a bad handle or an unknown analysis.
 * All of them are `{ ok: false, error }` and all of them reach the model as a
 * perfectly ordinary result.
 */
function refusal(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const o = output as { ok?: unknown; error?: unknown };
  if (o.ok !== false) return null;
  return typeof o.error === "string" ? o.error : "refused with no reason given";
}

/**
 * A result that came back empty.
 *
 * Not a failure, and worth seeing: an empty series or an unmatched name is the
 * most common reason an answer is thin, and it looks identical to a well that
 * genuinely made nothing.
 */
function emptiness(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const o = output as Record<string, unknown>;
  for (const key of ["matches", "entries", "members", "handles", "points", "edges", "rows"]) {
    const value = o[key];
    if (Array.isArray(value) && value.length === 0) return `${key}: []`;
  }
  return null;
}

function print(part: ToolPart): void {
  const name = toolName(part);
  const failed = part.state === "output-error";
  const refused = refusal(part.output);

  if (failed || refused) {
    console.warn(
      `%corion tool%c ${name} — ${failed ? "threw" : "refused"}`,
      ALARM,
      "",
      failed ? part.errorText : refused
    );
    console.warn("  input:", part.input);
    if (!failed) console.warn("  output:", part.output);
    return;
  }

  const empty = emptiness(part.output);
  const label = empty ? ` — empty (${empty})` : "";
  // Collapsed: the one-line summary is what you read at a glance, and the
  // arguments and result are there when it is the call you are chasing.
  console.groupCollapsed(`%corion tool%c ${name}${label}`, STYLE, "");
  console.log("input:", part.input);
  console.log("output:", part.output);
  console.groupEnd();
}

/**
 * Log every tool call not already logged.
 *
 * Takes the whole message list, or one snapshot, so both callers pass what they
 * already have. Safe to call on every render.
 */
export function logToolParts(messages: UIMessage[] | UIMessage | undefined): void {
  if (!messages) return;
  const list = Array.isArray(messages) ? messages : [messages];

  for (const message of list) {
    for (const part of message?.parts ?? []) {
      if (!isToolPart(part)) continue;
      // Only terminal states carry a result worth reading. Skipping the
      // streaming ones also keeps one call from printing once per chunk.
      if (part.state !== "output-available" && part.state !== "output-error") continue;

      const key = `${part.toolCallId ?? part.type}:${part.state}`;
      if (seen.has(key)) continue;
      if (seen.size >= MAX_SEEN) seen.clear();
      seen.add(key);
      print(part);
    }
  }
}

/** Test seam: forget what has been printed. */
export function resetToolLog(): void {
  seen.clear();
}
