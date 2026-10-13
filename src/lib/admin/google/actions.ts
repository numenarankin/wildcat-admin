"use server";

import { revalidatePath } from "next/cache";
import { assertSignedIn } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { deleteGoogleConnection, getGoogleRefreshToken } from "@/lib/admin/google/connections";
import { revokeToken } from "@/lib/admin/google/oauth";

/**
 * Disconnect the caller's Google account: revoke the grant at Google (every
 * service at once; Google has no per-scope revoke), then drop the row.
 */
export async function disconnectGoogle(): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await assertSignedIn();
  if (!(await isPlatformAdmin())) return { ok: false, error: "Not found." };
  try {
    const refresh = await getGoogleRefreshToken(me.id);
    if (refresh) {
      // A failed revoke still disconnects here; the grant is then listed under
      // the Google account's third-party access for removal by hand.
      await revokeToken(refresh).catch((e) => console.error("disconnectGoogle: revoke failed", e));
    }
    await deleteGoogleConnection(me.id);
  } catch (error) {
    console.error("disconnectGoogle failed", error);
    return { ok: false, error: "Couldn't disconnect Google." };
  }
  revalidatePath("/settings");
  return { ok: true };
}
