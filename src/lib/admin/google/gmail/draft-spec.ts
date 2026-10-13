/**
 * Orion's email drafts: the contract between the `draft_email` tool and the
 * composer card on /email.
 *
 * A draft is DATA, never an action. The tool returns this directive, the chat
 * hands it to the composer through `usePageAction`, and the composer copies it
 * into its fields. Nothing on that path can send: sending is the composer's
 * form submit, which it refuses unless the event came from the user's own
 * click or key press (`isTrusted`), and on the server every Gmail write is
 * refused while an Orion turn is running (`orion-guard.ts`).
 *
 * Pure, so the server bounds what the model wrote and the tests read it.
 */

/** Where the composer registers its handler; where the chat looks for one. */
export const EMAIL_DRAFT_ACTION = "email.draft";

export interface EmailDraftInput {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Plain text; blank lines separate paragraphs. */
  body?: string;
}

/** What the composer applies. Fields left undefined keep what the user typed. */
export interface EmailDraftDirective {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** The body as the composer's HTML. */
  html?: string;
}

const FIELD_MAX = 2_000;
const SUBJECT_MAX = 500;
const BODY_MAX = 50_000;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text to the editor's HTML: a paragraph per blank-line block, line breaks kept. */
export function bodyToHtml(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

const oneLine = (s: string, max: number) => s.replace(/[\r\n]+/g, " ").trim().slice(0, max);

/** Bound what the model wrote. Only fields it actually supplied are set. */
export function normalizeEmailDraft(input: EmailDraftInput): EmailDraftDirective {
  const out: EmailDraftDirective = {};
  if (typeof input.to === "string") out.to = oneLine(input.to, FIELD_MAX);
  if (typeof input.cc === "string") out.cc = oneLine(input.cc, FIELD_MAX);
  if (typeof input.bcc === "string") out.bcc = oneLine(input.bcc, FIELD_MAX);
  if (typeof input.subject === "string") out.subject = oneLine(input.subject, SUBJECT_MAX);
  if (typeof input.body === "string") out.html = bodyToHtml(input.body.slice(0, BODY_MAX));
  return out;
}
