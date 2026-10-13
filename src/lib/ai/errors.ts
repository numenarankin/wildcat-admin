/**
 * One place that turns any Orion failure into something a person can act on.
 *
 * The failures we actually hit are provider-shaped, and the useful parts are
 * buried: an `AI_APICallError` carries the HTTP status, the raw response body,
 * and — the single most valuable field — Anthropic's `request-id`, which is what
 * support needs to look a failure up. `console.error(err)` in a serverless log
 * prints the message and drops all of it, and the AI SDK masks the error on the
 * way to the browser by design ("An error occurred."), so the user's console
 * shows nothing either. Both sides now print the same fields keyed by the same
 * `turnId`, so a screenshot from a user can be matched to a server log line.
 */

export interface AIErrorDetail {
  name: string;
  message: string;
  /** HTTP status, when the failure came from the provider. */
  statusCode?: number;
  /** Anthropic's request id — quote this to support. */
  requestId?: string;
  url?: string;
  /** Provider error type, e.g. "invalid_request_error". */
  errorType?: string;
  /** Raw provider body, truncated. */
  responseBody?: string;
  isRetryable?: boolean;
  /** AI SDK errors nest the real cause; flattened newest-first. */
  causes?: string[];
  stack?: string;
}

const MAX_BODY = 2000;
const MAX_CAUSES = 5;

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function truncate(v: string | undefined, max = MAX_BODY): string | undefined {
  if (v == null) return undefined;
  return v.length > max ? `${v.slice(0, max)}… [+${v.length - max} chars]` : v;
}

/** Flatten an error into loggable fields, following the `cause` chain. */
export function describeAIError(err: unknown): AIErrorDetail {
  if (!(err instanceof Error)) {
    return { name: "NonError", message: truncate(str(err)) ?? "unknown" };
  }

  const e = err as Error & {
    statusCode?: number;
    url?: string;
    responseBody?: string;
    responseHeaders?: Record<string, string>;
    isRetryable?: boolean;
    data?: { error?: { type?: string; message?: string } };
  };

  const causes: string[] = [];
  let cause: unknown = e.cause;
  while (cause instanceof Error && causes.length < MAX_CAUSES) {
    causes.push(`${cause.name}: ${cause.message}`);
    cause = cause.cause;
  }

  return {
    name: e.name,
    message: e.message,
    statusCode: e.statusCode,
    requestId: e.responseHeaders?.["request-id"],
    url: e.url,
    errorType: e.data?.error?.type,
    responseBody: truncate(e.responseBody),
    isRetryable: e.isRetryable,
    causes: causes.length ? causes : undefined,
    stack: e.stack,
  };
}

/**
 * OUR Anthropic platform account is out of credits, which is not the same thing
 * as the customer being out of AI credits and must not be reported as such.
 *
 * Anthropic returns it as a plain `400 invalid_request_error`, indistinguishable
 * by status from a malformed request, so the message text is the only signal.
 * Worth its own branch because the two are opposite problems: one is fixed by
 * the customer buying credits, the other by us topping up at console.anthropic.com,
 * and telling an operator to buy credits when their balance is fine is the kind
 * of thing that costs trust.
 */
export function isProviderOutOfCredits(err: unknown): boolean {
  const d = describeAIError(err);
  return (
    d.statusCode === 400 && /credit balance is too low/i.test(d.message ?? "")
  );
}

/**
 * What the user sees. Plain English, then the turn id so a screenshot is enough
 * to find the server log — the raw provider message is for the console, not for
 * a pumper looking at a red box.
 */
export function userFacingError(err: unknown, turnId: string): string {
  const d = describeAIError(err);
  const reason = isProviderOutOfCredits(err)
    ? "Orion is temporarily unavailable (the AI provider account needs attention). This is on us, not your account — please let support know."
    : d.statusCode === 402
      ? "This organization is out of AI credits."
      : d.statusCode === 429
        ? "Orion is rate limited right now. Try again in a moment."
        : d.statusCode === 400
          ? "Orion couldn't process this conversation."
          : d.statusCode && d.statusCode >= 500
            ? "The AI provider had an error."
            : "Orion hit an error.";
  return `${reason} (ref ${turnId})`;
}
