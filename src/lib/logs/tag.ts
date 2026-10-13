/**
 * The one structured line the app prints for `platform_logs`. It goes through stdout like any
 * other line and reaches the table through the Vercel drain, which reads the fields back out
 * (`drain.ts`). The app never writes to the table itself.
 *
 *   [wc] {"k":"action","user":"<uuid>","action":"src/lib/tanks/actions.ts#wipeTankHistory"}
 *   [wc] {"k":"error","user":"<uuid>","route":"render /production/page"}
 *   <stack trace...>
 *
 * The same file lives in both apps (wildcat prints, wildcat-admin parses). Keep the copies identical.
 */

export const TAG = "[wc] ";

export interface Tag {
  k: "action" | "error";
  user?: string | null;
  action?: string | null;
  route?: string | null;
}

/** The tagged line, with an optional body (a stack trace) on the lines after it. */
export function formatTag(tag: Tag, body?: string): string {
  const fields = Object.fromEntries(Object.entries(tag).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  return `${TAG}${JSON.stringify(fields)}${body ? `\n${body}` : ""}`;
}

/** The tag and the body after it, or null when the message is not a tagged line. */
export function parseTag(message: string | null | undefined): { tag: Tag; body: string } | null {
  if (!message) return null;
  const nl = message.indexOf("\n");
  const first = nl < 0 ? message : message.slice(0, nl);
  // Only at the very start: a line that merely quotes a tag (say, user input inside an error
  // message) must not be able to claim a user or an action.
  if (!first.startsWith(`${TAG}{`)) return null;
  try {
    const v = JSON.parse(first.slice(TAG.length)) as Partial<Tag>;
    if (v.k !== "action" && v.k !== "error") return null;
    const str = (x: unknown) => (typeof x === "string" && x ? x : null);
    return {
      tag: { k: v.k, user: str(v.user), action: str(v.action), route: str(v.route) },
      body: nl < 0 ? "" : message.slice(nl + 1),
    };
  } catch {
    return null;
  }
}
