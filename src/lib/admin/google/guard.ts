import "server-only";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";

/**
 * The session's user id when they are a platform admin, else null. Every
 * Google reader, server action and route starts here, and passes THIS id to
 * `googleFetch`, never one from input.
 */
export async function googleAdminId(): Promise<string | null> {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return null;
  return user.id;
}

/** For server actions: throws the same "Not found." an outsider gets elsewhere. */
export async function requireGoogleAdminId(): Promise<string> {
  const id = await googleAdminId();
  if (!id) throw new Error("Not found.");
  return id;
}
