import type { UIMessage } from "ai";
import { pendingApprovals } from "@/components/ai/tool-approval";
import { chartSpecsFromMessage } from "@/lib/ai/chart-spec";
import { orionFileOf } from "@/lib/ai/file-spec";
import { toolActivity } from "@/lib/ai/tool-activity";

/**
 * Message helpers shared by the /orion page and the drawer, so both chat
 * surfaces answer "what is in this message?" the same way — and so a fix to one
 * can't miss the other.
 */

/** Concatenate the text parts of a UIMessage. */
export function messageText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Whether a message has any visible streamed text yet. */
export function hasText(message: UIMessage | undefined): boolean {
  return messageText(message).trim().length > 0;
}

/**
 * Is the assistant's visible text the most recent thing this turn produced?
 *
 * Parts are appended in production order, so the tail is the only one that can be
 * live. Text at the tail means the user is either watching tokens land or looking
 * at the sentence that just finished — output is current, so nothing needs
 * announcing. Anything else at the tail (a tool call, a reasoning block, or no
 * parts at all yet) means Orion has moved on to work that shows nothing, and the
 * user is staring at output that has stopped.
 *
 * That second case is the whole point, and it is why "has this turn produced any
 * text yet" was the wrong question. Orion routinely opens with "Let me grab that
 * for you", then spends twenty seconds thinking and calling tools. Once ANY text
 * existed the old rule dropped the indicator for the rest of the turn, so those
 * twenty seconds looked exactly like a finished — and useless — answer.
 *
 * Note this reads the tail's TYPE, not a text part's `state`. Treating a finished
 * text part as stopped output would be more literal and worse: at the end of every
 * answer the last `text-end` and the closing of the stream are separate events, so
 * the indicator would flash back on as each reply completed.
 */
export function textIsLatest(message: UIMessage | undefined): boolean {
  const parts = message?.parts;
  if (!parts || parts.length === 0) return false;
  return parts[parts.length - 1].type === "text";
}

/** Names of tools invoked in a message (static `tool-<name>` + dynamic). */
export function toolCallNames(message: UIMessage | undefined): string[] {
  if (!message) return [];
  const names: string[] = [];
  for (const part of message.parts) {
    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      names.push(part.type.slice("tool-".length));
    } else if (part.type === "dynamic-tool") {
      const name = (part as { toolName?: string }).toolName;
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * What Orion is doing, in plain English, for the tools running in this message.
 *
 * Consecutive repeats collapse: two `get_well` calls in a row rendered as two
 * identical lines reads like a stutter, where `get_well()` twice at least looked
 * like distinct calls. Non-adjacent repeats are kept — they mark a real second
 * pass after other work.
 */
export function toolActivityLabels(message: UIMessage | undefined): string[] {
  const labels: string[] = [];
  for (const name of toolCallNames(message)) {
    const label = toolActivity(name);
    if (label !== labels[labels.length - 1]) labels.push(label);
  }
  return labels;
}

/**
 * Whether a message renders anything at all.
 *
 * An assistant turn exists as a message the moment it starts calling tools, but
 * until text streams back it draws nothing — yet its wrapper still counted as a
 * child of the message column, so the thinking indicator jumped down a full gap
 * the instant a tool fired. Skipping empty turns keeps the indicator still until
 * there is actually something to show above it.
 */
export function hasVisibleContent(message: UIMessage): boolean {
  if (message.role === "user") return true;
  if (hasText(message)) return true;
  if (pendingApprovals(message).length > 0) return true;
  if (chartSpecsFromMessage(message).length > 0) return true;
  if (message.parts.some((p) => orionFileOf(p))) return true;
  return message.parts.some((p) => p.type === "file");
}

/**
 * Flatten markdown to plain prose.
 *
 * Two callers want the words without the syntax: read-aloud, so the voice does
 * not pronounce asterisks, and the history panel's preview line, where a raw
 * `**Fix Roach Parrot 7.**` and a row of table pipes are what the reader sees
 * of an answer.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // bullets
    .replace(/[*_~]+/g, "") // emphasis marks
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** How much of a message a one-line history row can possibly show. */
const PREVIEW_LIMIT = 160;

/**
 * A message as one line of preview text: no markdown, no line breaks, capped.
 *
 * The cap is the point. The row truncates with CSS, so without it every row
 * would still ship its whole message to the browser — and an Orion answer runs
 * to paragraphs and tables. `160` is comfortably more than the ~40 characters a
 * `w-80` row can actually display, so the ellipsis is still CSS's to place.
 */
export function previewText(message: UIMessage | undefined): string {
  const flat = stripMarkdown(messageText(message)).replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT)}…` : flat;
}
