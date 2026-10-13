"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * The Orion-generated morning brief that streams in at the top of the dashboard
 * on every load. Reads the route's plain text stream directly (so there's no
 * protocol ambiguity and it can never silently hang, so any failure flips to the
 * fallback heading), reveals it with the same buffered "glide" as the chat, and
 * falls back to a plain heading when the AI is unavailable (no `use_ai`
 * permission, out of credits, or a transient error).
 */

/**
 * The greeting is a HEADING, the rest is the brief.
 *
 * The first sentence is "Good afternoon, Jim." and nothing else (the prompt
 * pins that), so it is lifted out and set at heading size while the report
 * underneath keeps the reading size it had. Rendering the whole brief at one
 * size made the page open with no title at all, and setting all of it large
 * made a paragraph of numbers shout.
 *
 * Parsed rather than passed as a field: the brief arrives as one plain text
 * stream, and the greeting has to be able to appear before the sentence after it
 * exists. A brief that does not open with a greeting (an older cached one, or a
 * model that ignored the instruction) yields no heading and renders whole, which
 * is the honest fallback.
 */
function splitGreeting(text: string): { greeting: string; body: string } {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  const opens = GREETINGS.some((g) => lower.startsWith(g));

  if (!opens) {
    // Mid-word on the greeting itself ("Good aftern"): still the heading. Left
    // as body it would render at reading size for a frame and then jump, which
    // is the one thing a heading must not do.
    const typing = trimmed.length > 0 && GREETINGS.some((g) => g.startsWith(lower));
    return typing
      ? { greeting: trimmed, body: "" }
      : { greeting: "", body: text };
  }

  const end = trimmed.search(/[.!?]/);
  if (end === -1) return { greeting: trimmed, body: "" };
  return {
    greeting: trimmed.slice(0, end + 1).trim(),
    body: trimmed.slice(end + 1).trimStart(),
  };
}

/** The openings the prompt can produce, by the viewer's local hour. */
const GREETINGS = ["good morning", "good afternoon", "good evening"];

const HEADING_CLASS = "font-heading text-2xl font-semibold tracking-tight";

const PROSE_CLASS =
  "text-base font-medium leading-relaxed text-muted-foreground [&>*+*]:mt-3 [&_strong]:font-semibold [&_strong]:text-secondary-text";

/**
 * Safety net on the rendered brief, not a design target — the prompt asks for
 * at most 60 words after the greeting, and on a day with a lot to report it
 * runs over.
 * Set well above the target so this only catches a genuine runaway, and see
 * {@link capText}: it drops the overrunning SENTENCE rather than slicing a
 * sentence (or a `**bold**` run) in half.
 */
const MAX_CHARS = 600;

/**
 * Floor on the reveal rate, characters per second. This used to be 55, which
 * meant a full-length brief spent ~9 seconds typing itself out AFTER the model
 * had already finished — the single biggest reason the brief felt slow. At 400
 * a 300-character brief lands in under a second and still reads as arriving
 * rather than popping in.
 */
const MIN_REVEAL_CPS = 400;

/**
 * Strictly strip em/en dashes the brief must never contain, a safety net over
 * the prompt rule. Leaves hyphens ("3-day") and the minus sign ("−12%") alone.
 */
function noDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ");
}

/**
 * Trim an overrunning brief to its last COMPLETE sentence. Cutting mid-sentence
 * ("...tank is called in for…") reads as a broken app, and slicing inside a
 * `**bold**` run leaves raw asterisks on screen, so drop the whole unfinished
 * sentence instead. Only if the very first sentence already overruns do we fall
 * back to a word-boundary cut with an ellipsis.
 */
function capText(s: string): string {
  const text = s.trimEnd();
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const lastStop = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? ")
  );
  if (lastStop > 0) return cut.slice(0, lastStop + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Reveals `text` at a steady rate rather than popping in chunks: a rAF loop
 * advances a character cursor, catching up when it falls behind the stream, and
 * renders live markdown of the revealed prefix. A brief served from the
 * server's cache glides in the same way: the whole text landing in one frame
 * read as a block dropped on the page, whichever path it came by.
 */
function GlideText({ text }: { text: string }) {
  const targetRef = useRef("");
  const shownRef = useRef(0);
  const [revealed, setRevealed] = useState("");

  useEffect(() => {
    targetRef.current = text;
  }, [text]);

  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const tick = (ts: number) => {
      const target = targetRef.current;
      if (target.length > shownRef.current) {
        const backlog = target.length - shownRef.current;
        const dt = last == null ? 0 : (ts - last) / 1000;
        const charsPerSecond = Math.max(MIN_REVEAL_CPS, backlog / 0.25);
        const step = Math.max(1, Math.round(charsPerSecond * dt));
        shownRef.current = Math.min(target.length, shownRef.current + step);
        setRevealed(target.slice(0, shownRef.current));
      }
      last = ts;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { greeting, body } = splitGreeting(revealed);
  return (
    <div>
      {greeting && <h1 className={HEADING_CLASS}>{greeting}</h1>}
      {body && (
        <div className={cn(PROSE_CLASS, greeting && "mt-2")}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export function MorningBrief({ className }: { className?: string } = {}) {
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        console.log("[dashboard-brief] requesting");
        const res = await fetch("/api/dashboard/brief", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hour: new Date().getHours() }),
          signal: controller.signal,
        });
        console.log("[dashboard-brief] response", res.status, res.ok);
        if (!res.ok || !res.body) {
          setFailed(true);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setText(acc);
        }
        console.log("[dashboard-brief] done,", acc.length, "chars");
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("[dashboard-brief] fetch failed", err);
          setFailed(true);
        }
      }
    })();
    return () => controller.abort();
  }, []);

  // Reserve the vertical space up front so streaming text (and the skeleton)
  // never push the rest of the dashboard around as the brief fills in.
  return (
    <div className={cn("min-h-28 max-w-5xl py-4", className)}>
      {failed ? (
        <h1 className={HEADING_CLASS}>Dashboard</h1>
      ) : text ? (
        <GlideText text={capText(noDashes(text))} />
      ) : (
        <div className="flex flex-col gap-2.5" aria-hidden>
          <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
        </div>
      )}
    </div>
  );
}
