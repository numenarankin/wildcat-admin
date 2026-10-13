import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks code as running on Orion's behalf, so the Google fetch layer can
 * refuse what Orion must never do. The admin chat route wraps every tool's
 * `execute` in `runAsOrion`; anything that tool awaits, however deep, sees
 * `inOrionCall()` true.
 *
 * The rule it carries: Orion never writes to Gmail. No send, no draft, no
 * label, nothing but reads (`googleFetchRaw` throws on any non-GET to the
 * Gmail API inside an Orion call). Orion can fill the composer on /email
 * (`draft_email`), which is the user's browser state, never Gmail's; only the
 * user's own click on Send sends.
 */
const orionCall = new AsyncLocalStorage<true>();

export function runAsOrion<T>(fn: () => T): T {
  return orionCall.run(true, fn);
}

export function inOrionCall(): boolean {
  return orionCall.getStore() === true;
}

const GMAIL_API = "https://gmail.googleapis.com/";

/** Throws when Orion is trying to write to Gmail. */
export function assertNotOrionGmailWrite(url: string, method: string | undefined): void {
  if (!inOrionCall()) return;
  if ((method ?? "GET").toUpperCase() === "GET") return;
  if (url.startsWith(GMAIL_API)) throw new Error("Orion cannot write to Gmail. Only the user can send email.");
}
