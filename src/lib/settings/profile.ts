/**
 * Server-side access to the signed-in user's profile (`profile` table, one row
 * per auth user): display name, company name, and avatar. Read in server
 * components; written via `./actions`.
 *
 * RLS returns only the caller's own row, so reads don't filter by id. The
 * avatar is stored as a private-bucket object key and served as a short-lived
 * signed URL (the bucket is no longer public).
 */

import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";

const AVATAR_BUCKET = "avatars";

export interface Profile {
  name: string;
  /** First / last name, captured at onboarding (the combined `name` mirrors them). */
  firstName: string;
  lastName: string;
  companyName: string;
  avatarUrl: string | null;
  /** Optional contact phone, stored on the profile row. */
  phone: string;
  /** The signed-in user's email, read from auth (not editable here). */
  email: string;
}

/** Exported so callers can degrade to a known-empty profile without throwing. */
export const EMPTY_PROFILE: Profile = {
  name: "",
  firstName: "",
  lastName: "",
  companyName: "",
  avatarUrl: null,
  phone: "",
  email: "",
};

/** Mint a signed URL for a stored avatar object key (tolerating legacy URLs). */
async function signedAvatar(key: string | null): Promise<string | null> {
  if (!key) return null;
  // Pre-migration rows may hold a full public URL; pass those through.
  if (key.startsWith("http")) return key;
  const { data } = await getSupabaseAdmin()
    .storage.from(AVATAR_BUCKET)
    .createSignedUrl(key, 60 * 60);
  return data?.signedUrl ?? null;
}

/** Load the signed-in user's profile, or empty defaults when unavailable. */
export async function getProfile(): Promise<Profile> {
  if (!hasSupabase()) return EMPTY_PROFILE;
  try {
    const sb = await getSupabaseServer();
    // The company name is org-level (shared by every member), so it comes from
    // `organizations`, not the per-user profile. RLS scopes both reads to the
    // caller: their own profile row and their own org.
    const [{ data, error }, { data: org }] = await Promise.all([
      sb
        .from("profile")
        .select("name, first_name, last_name, avatar_url, phone")
        .maybeSingle(),
      sb
        .from("organizations")
        .select("name")
        .maybeSingle<{ name: string | null }>(),
    ]);
    if (error) throw error;
    const email = (await getSessionUser())?.email ?? "";
    const companyName = org?.name ?? "";
    if (!data) return { ...EMPTY_PROFILE, companyName, email };
    return {
      name: (data.name ?? "").trim(),
      firstName: (data.first_name ?? "").trim(),
      lastName: (data.last_name ?? "").trim(),
      companyName,
      avatarUrl: await signedAvatar(data.avatar_url),
      phone: (data.phone ?? "").trim(),
      email,
    };
  } catch (error) {
    console.error("getProfile failed", error);
    return EMPTY_PROFILE;
  }
}

/**
 * Signed avatar URLs for a set of auth users, keyed by user id.
 *
 * Everywhere the app shows OTHER people — a comment thread, the messages
 * roster — needs this, and profiles are RLS-scoped to their owner, so the read
 * goes through the admin client. Callers must pass ids they have already
 * established the viewer may see (members of their org, authors of comments RLS
 * let them read); this helper does no authorization of its own.
 *
 * Users without an avatar are simply absent from the map. Signing is one batch
 * call rather than one per user: a thread with twenty authors would otherwise
 * make twenty round trips to storage.
 */
export async function getAvatarUrls(
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0 || !hasSupabase()) return out;

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("profile")
      .select("user_id, avatar_url")
      .in("user_id", ids);
    if (error) throw error;

    const rows = ((data ?? []) as { user_id: string; avatar_url: string | null }[])
      .filter((r) => Boolean(r.avatar_url));
    if (rows.length === 0) return out;

    // Pre-migration rows may hold a full public URL; those pass through and
    // never reach the signer (which would treat them as object keys).
    const direct = rows.filter((r) => r.avatar_url!.startsWith("http"));
    for (const r of direct) out.set(r.user_id, r.avatar_url!);

    const keys = rows.filter((r) => !r.avatar_url!.startsWith("http"));
    if (keys.length > 0) {
      const { data: signed } = await admin.storage
        .from(AVATAR_BUCKET)
        .createSignedUrls(
          keys.map((r) => r.avatar_url!),
          60 * 60
        );
      // `createSignedUrls` answers in request order, so the key list indexes it.
      (signed ?? []).forEach((entry, i) => {
        const userId = keys[i]?.user_id;
        if (userId && entry?.signedUrl && !entry.error)
          out.set(userId, entry.signedUrl);
      });
    }
  } catch (error) {
    // An avatar is decoration: a failure here must not take the thread with it.
    console.error("getAvatarUrls failed", error);
  }
  return out;
}
