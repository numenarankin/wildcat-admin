/**
 * GET /: the front door, a redirect to the first page on the admin's list
 * (the dashboard for anyone who has it).
 *
 * A Route Handler, not a page, for the reason `app/route.ts` is one: a page
 * would have to await the gate under the root `loading.tsx` boundary, and a
 * `redirect()` after the response has begun streaming degrades to a meta
 * refresh. A handler answers with a real 307, or a real 404 for an outsider.
 */

import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { getPlatformAdminAccess } from "@/lib/auth/platform-admin";
import { adminPageDef } from "@/lib/admin/pages";

export async function GET(request: Request): Promise<Response> {
  const access = await getPlatformAdminAccess();
  const first = access.pages[0];
  if (!access.isAdmin || !first) notFound();
  return NextResponse.redirect(new URL(adminPageDef(first).path, request.url), 307);
}
