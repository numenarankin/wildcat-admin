import "server-only";

import { APICallError, streamText } from "ai";
import { ilog } from "@/lib/ai/ingest/log";
import {
  SCAN_MODEL_ID,
  scanModel,
  scanProviderOptions,
  supportsFastMode,
} from "@/lib/ai/scan-model";

/**
 * One streamed model call for the ingest agents (categorize / analyze /
 * validate). Each agent is its OWN call with its own skill prompt; this is only
 * the shared plumbing — the streaming loop, the throttled "still generating"
 * heartbeat, and the usage read — so no agent hand-rolls it. Returns the raw
 * text (each caller parses its own JSON shape) plus token usage to meter.
 */

/** How often to log a "still generating" heartbeat while a call streams. */
const HEARTBEAT_MS = 4_000;

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Which model produced these tokens, so `meterAnthropic` prices them at the
   * right rate instead of falling back to Opus 5. */
  model?: string;
}

/**
 * How hard the model deliberates before answering.
 *
 * This is the dominant cost in every ingest call, not the JSON the model
 * writes. Both Opus 5 and Sonnet 5 think by default and, with no `effort` set,
 * think at `high` — measured on a one-page document, a validate call spent 18
 * of its 19 seconds silent (1,443 output tokens billed against a ~50-character
 * verdict) before emitting anything. It is the single biggest latency lever
 * here, so each caller states what its job actually needs.
 *
 * NOTE: what a caller declares here is currently recorded but NOT applied —
 * every scan agent runs at the one pipeline-wide effort from
 * `@/lib/ai/scan-model` (`SCAN_EFFORT`, Anthropic only; OpenAI chat models have
 * no effort dial). The declarations stay so restoring this ladder is a change
 * to that one file.
 */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Whether to request FAST mode for this call.
 *
 * Fast mode runs the same model at up to 2.5x the output-token rate, which
 * attacks the same silent phase `effort` does — one shrinks how many thinking
 * tokens are produced, the other produces them quicker — so the two compound.
 * It bills at roughly double the per-token rate, so it belongs on the stages
 * whose output is SMALL (a verdict, a category), where the lower token count
 * offsets the higher rate, and not on the token-heavy analyze pass.
 *
 * The provider adds the `fast-mode-2026-02-01` beta and routes to the beta
 * endpoint on its own when `speed` is set — nothing to send by hand. It is a
 * research preview on the first-party Claude API only (not Bedrock / Vertex /
 * Foundry), and it draws on a rate-limit pool separate from standard Opus,
 * which is what the 429 fallback below exists for.
 */
export type AgentSpeed = "fast";

/** A rate limit specifically — the one error worth retrying at standard speed. */
function isRateLimited(err: unknown): boolean {
  return APICallError.isInstance(err) && err.statusCode === 429;
}

export async function streamAgentJson(opts: {
  /** Short label for the heartbeat/log lines (e.g. "categorize", "validate"). */
  label: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Omitted = `medium`. NOT the model's own default, which is `high`. */
  effort?: AgentEffort;
  /** Omitted = standard speed. See `AgentSpeed`. */
  speed?: AgentSpeed;
}): Promise<{ text: string; usage: AgentUsage }> {
  const { label, system, user, maxOutputTokens, timeoutMs, effort, speed } = opts;
  const callStart = Date.now();

  async function attempt(
    useSpeed: AgentSpeed | undefined
  ): Promise<{ text: string; usage: AgentUsage }> {
    // Every scan agent runs at the pipeline-wide scan effort. Each caller still
    // declares the effort its job actually needs (see `AgentEffort`); that
    // value is kept in the code and logged, but not applied, so the whole
    // pipeline is measurable as one configuration — and so reverting
    // `scan-model.ts` restores the original per-agent ladder with no other edit.
    const base = scanProviderOptions();
    const providerOptions = base.anthropic
      ? {
          ...base,
          anthropic: {
            ...base.anthropic,
            // Fast mode is Anthropic-Opus-only; asking for it anywhere else is
            // rejected, and a scan must not fail over a speed preference.
            ...(useSpeed && supportsFastMode() ? { speed: useSpeed } : {}),
          },
        }
      : base;
    const result = streamText({
      model: scanModel(),
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(timeoutMs),
      maxRetries: 1,
      system,
      messages: [{ role: "user", content: user }],
      providerOptions,
    });

    let chars = 0;
    let lastBeat = Date.now();
    for await (const delta of result.textStream) {
      chars += delta.length;
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        ilog(`${label}: streaming`, { charsSoFar: chars, ms: Date.now() - callStart });
        lastBeat = Date.now();
      }
    }

    const text = await result.text;
    const usage = await result.totalUsage;
    ilog(`${label}: model call done`, {
      model: SCAN_MODEL_ID,
      appliedEffort: providerOptions.anthropic?.effort ?? null,
      declaredEffort: effort ?? null,
      ms: Date.now() - callStart,
      outputTokens: usage.outputTokens,
    });
    return {
      text,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: SCAN_MODEL_ID,
      },
    };
  }

  try {
    return await attempt(speed);
  } catch (err) {
    // Fast mode has its own rate-limit pool. Exhausting it must not fail a scan
    // that standard capacity could still serve, so fall back once — slower, but
    // it completes. Any other error is the caller's to handle.
    if (speed && isRateLimited(err)) {
      ilog(`${label}: fast mode rate-limited — retrying at standard speed`);
      return await attempt(undefined);
    }
    throw err;
  }
}

/**
 * Unwrap a tool-call envelope around an otherwise-correct structured reply.
 *
 * `generateObject` asks the provider for a tool call and validates the tool's
 * arguments against the schema. Models occasionally answer with the shape of the
 * tool call rather than its arguments — `{"parameters": {...}}` — and the SDK
 * then reports "response did not match schema" for an extraction whose contents
 * were perfectly correct. Seen on the Revenue statement path after the scan model
 * moved to Opus 5, and it costs the user the whole upload.
 *
 * Identifies the envelope by the INNER object, not by the wrapper's name. An
 * earlier version matched a list of expected wrapper names (`parameters`,
 * `input`, …) and was defeated the first time a reply came back wrapped in
 * `parameter`, singular — the model picks that word freely, so no list of them
 * can be complete. `expectedKeys` are the schema's own top-level fields, and the
 * check is: the reply doesn't carry them, and a single-key wrapper does.
 *
 * Wired in as `experimental_repairText`, so it runs ONLY after validation has
 * already failed. Returns null when there is nothing to strip, which leaves the
 * original error intact — repairing is for a reply that is right in substance
 * and wrong in shape, never a way to paper over a bad extraction.
 */
export function unwrapToolEnvelope(
  raw: string,
  expectedKeys: string[]
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(isolateJson(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const outer = parsed as Record<string, unknown>;

  // The reply already speaks the schema's language: whatever failed validation,
  // it was not an envelope, and unwrapping would discard real fields.
  if (expectedKeys.some((k) => k in outer)) return null;

  const keys = Object.keys(outer);
  if (keys.length !== 1) return null;
  const inner = outer[keys[0]];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;

  // Only unwrap onto something that actually looks like what we asked for.
  const innerKeys = inner as Record<string, unknown>;
  if (!expectedKeys.some((k) => k in innerKeys)) return null;
  return JSON.stringify(inner);
}

/** Isolate the JSON object from a model reply (tolerate ``` fences / prose). */
export function isolateJson(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (s.startsWith("{") && s.endsWith("}")) return s;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}
