import "server-only";

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * The model every document-scanning call uses: reading a scan or PDF to text,
 * and turning that text into structured records.
 *
 * Kept in ONE place because the whole pipeline has to move together to be
 * measurable. Stage 1 (`read-document.ts`) fans out per page-chunk, Stage 2
 * (triage / analyze / validate / extract) runs several sequential passes, and
 * the standalone extract routes read a document end-to-end on their own — a
 * comparison that switches only some of them tells you nothing.
 *
 * Configured entirely from the environment (`.env.local` in dev, which Next
 * loads for server code automatically), so switching providers is a restart,
 * not a deploy:
 *
 *   SCAN_PROVIDER=anthropic          # or `openai`. Default: anthropic.
 *   SCAN_MODEL_ID=claude-sonnet-5    # optional; defaults per provider below.
 *   SCAN_EFFORT=low                  # optional; Anthropic only. Default: low.
 *   OPENAI_API_KEY=sk-...            # required when SCAN_PROVIDER=openai.
 *
 * `SCAN_PROVIDER` is an explicit switch on purpose — having an OpenAI key in
 * the environment must never be enough to silently reroute every scan in the
 * product away from Claude.
 *
 * NOT covered here, deliberately: chat and voice (`router.ts` picks per turn),
 * the geology stack (its own Fable/Sonnet constants), and the digest / pumper /
 * narrative summarizers. None of those read scanned documents.
 */

export type ScanProvider = "anthropic" | "openai";

function readProvider(): ScanProvider {
  const raw = (process.env.SCAN_PROVIDER ?? "anthropic").trim().toLowerCase();
  if (raw === "openai" || raw === "anthropic") return raw;
  // A typo must not silently fall back to a different vendor than intended.
  throw new Error(
    `SCAN_PROVIDER must be "anthropic" or "openai" (got "${raw}").`
  );
}

/** Which vendor serves scans this process. */
export const SCAN_PROVIDER: ScanProvider = readProvider();

/** Sensible default per provider; override with `SCAN_MODEL_ID`. */
const DEFAULT_MODEL_ID: Record<ScanProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.4-nano",
};

/** The model id in use — exported for logging and for cost attribution. */
export const SCAN_MODEL_ID: string =
  process.env.SCAN_MODEL_ID?.trim() || DEFAULT_MODEL_ID[SCAN_PROVIDER];

/**
 * How hard the model deliberates. Anthropic only — this is the `effort`
 * provider option, which Claude models accept and OpenAI's chat models do not.
 *
 * It is load-bearing on Claude, not decoration: Sonnet 5 runs adaptive thinking
 * when no `thinking` field is set, and `maxOutputTokens` caps thinking and the
 * answer TOGETHER. Left at the default `high`, a scan spends its silent phase
 * deliberating about a transcription and eats the ceiling the transcription
 * needs. Raise it first if fill-rate drops — the analyze pass in `extract.ts`
 * was deliberately at `medium` before the switch to a single pinned effort, and
 * is the one place where extraction accuracy is genuinely won or lost.
 */
export const SCAN_EFFORT = process.env.SCAN_EFFORT?.trim() || "low";

/**
 * The resolved model for this process. Throws — rather than falling back to
 * Claude — when OpenAI is selected without a key, so a misconfigured experiment
 * fails visibly instead of quietly producing Anthropic numbers you then compare
 * against Anthropic numbers.
 *
 * Called per request rather than memoized at module load so the throw lands in
 * the caller's try/catch (surfacing as a failed scan) instead of taking down
 * every route that transitively imports this file.
 */
export function scanModel(): LanguageModel {
  if (SCAN_PROVIDER === "openai") {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error(
        "SCAN_PROVIDER=openai but OPENAI_API_KEY is not set. Add it to .env.local and restart."
      );
    }
    return openai(SCAN_MODEL_ID);
  }
  return anthropic(SCAN_MODEL_ID);
}

/**
 * Provider-scoped request options. The AI SDK namespaces these by provider and
 * drops the keys that don't match, but we still only send what the vendor
 * understands so a wrong-provider option can't be mistaken for a live setting.
 *
 * OpenAI gets nothing: GPT-4.1 is not a reasoning model and has no effort dial.
 * A reasoning model set via `SCAN_MODEL_ID` (o-series, gpt-5) would want
 * `reasoningEffort` here — add it when you actually test one.
 */
export function scanProviderOptions(): Record<
  string,
  Record<string, string>
> {
  if (SCAN_PROVIDER === "openai") return {};
  return { anthropic: { effort: SCAN_EFFORT } };
}

/**
 * Fast mode is a research preview on Anthropic's Opus line only (Opus 5 / 4.8);
 * asking for it anywhere else is rejected. `agent-call.ts` gates its `speed`
 * option on this so a caller that opts into fast mode degrades to standard
 * speed instead of failing the scan outright.
 */
export function supportsFastMode(): boolean {
  return (
    SCAN_PROVIDER === "anthropic" &&
    (SCAN_MODEL_ID === "claude-opus-5" || SCAN_MODEL_ID === "claude-opus-4-8")
  );
}
