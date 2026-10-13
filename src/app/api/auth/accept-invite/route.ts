import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hashInviteToken } from "@/lib/auth/invite";
import { ADMIN_ONLY_FLAG } from "@/lib/auth/admin-only";
import { cleanPages } from "@/lib/admin/pages";

interface AcceptRequest {
  token?: unknown;
  password?: unknown;
}

/**
 * Accept an admin team invite. The customer app's `/api/auth/accept-invite`
 * over `platform_admin_invites`, cut down for an internal tool: the invitee
 * chooses a password and nothing else. Their name is the one the inviter
 * typed. The token is re-validated entirely server-side (hash match + not
 * expired), then:
 *   1. The auth account is created for the invited email in the shared
 *      Supabase project (the same auth the customer app signs into), email
 *      pre-confirmed and marked ADMIN-ONLY (`lib/auth/admin-only.ts`): it
 *      exists for the admin side and is not a user of the app.
 *   2. The `platform_admins` row is created with the pages the invite carried.
 *   3. The invite is deleted, so the link can't be replayed.
 *
 * Returns the invited email so the client can establish a browser session.
 *
 * ## Someone who already has an account
 *
 * A customer, or staff who also use the app. Step 1 is skipped: their
 * password, profile and workspaces are left exactly as they were, and the
 * response says `existingAccount` so the client sends them to sign in instead
 * of trying a password they were never asked for. Whether the account exists is
 * decided HERE, from the database, never from a flag the client sent.
 */
export async function POST(req: Request) {
  let body: AcceptRequest;
  try {
    body = (await req.json()) as AcceptRequest;
  } catch {
    return Response.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const { token, password } = body;
  if (typeof token !== "string" || !token) {
    return Response.json({ ok: false, error: "A valid invite is required." }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const tokenHash = hashInviteToken(token);

  const { data: invite, error: lookupErr } = await admin
    .from("platform_admin_invites")
    .select("id, email, name, pages, invite_expires_at, invited_by")
    .eq("invite_token_hash", tokenHash)
    .maybeSingle();
  if (lookupErr) {
    console.error("accept-invite lookup failed", lookupErr);
    return Response.json(
      { ok: false, error: "Could not validate your invite. Please try again." },
      { status: 500 }
    );
  }
  if (!invite) {
    return Response.json(
      { ok: false, error: "This invite link is invalid or has already been used." },
      { status: 400 }
    );
  }
  const row = invite as {
    id: string;
    email: string;
    name: string | null;
    pages: string[] | null;
    invite_expires_at: string;
    invited_by: string | null;
  };
  if (Date.parse(row.invite_expires_at) < Date.now()) {
    return Response.json(
      { ok: false, error: "This invite has expired. Ask your admin to re-send it." },
      { status: 410 }
    );
  }

  // Already a user? Then this invite adds the admin side, not an account.
  const { data: existingUserId } = await admin.rpc("auth_user_id_by_email", { addr: row.email });
  const existingAccount = typeof existingUserId === "string" && existingUserId;

  if (!existingAccount) {
    if (typeof password !== "string") {
      return Response.json({ ok: false, error: "A password and a valid invite are required." }, { status: 400 });
    }
    if (password.length < 6) {
      return Response.json({ ok: false, error: "Password must be at least 6 characters." }, { status: 400 });
    }
  }

  const name = (row.name ?? "").trim();

  let userId: string;
  if (existingAccount) {
    userId = existingAccount;
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: row.email,
      password: password as string,
      email_confirm: true,
      app_metadata: { [ADMIN_ONLY_FLAG]: true },
    });
    if (createErr || !created?.user) {
      const alreadyExists = /already.*regist|already.*exist|duplicate/i.test(createErr?.message ?? "");
      return Response.json(
        {
          ok: false,
          error: alreadyExists
            ? "An account with this email already exists. Sign in instead."
            : "Could not create your account. Please try again.",
        },
        { status: alreadyExists ? 409 : 500 }
      );
    }
    userId = created.user.id;
  }

  // Put them on the list with the pages and the name the invite carried.
  const { error: insertErr } = await admin.from("platform_admins").insert({
    user_id: userId,
    email: row.email,
    name,
    pages: cleanPages(row.pages ?? []),
    is_seed: false,
    added_by: row.invited_by,
  });
  if (insertErr) {
    console.error("accept-invite roster insert failed", insertErr);
    // Roll a JUST-CREATED account back so the invite can be retried cleanly.
    // Never an existing one: it holds their workspaces.
    if (!existingAccount) {
      await admin.auth.admin.deleteUser(userId).catch((delErr) => {
        console.error("orphan cleanup failed", delErr);
      });
    }
    return Response.json(
      {
        ok: false,
        error:
          insertErr.code === "23505"
            ? "This account is already on the admin team. Sign in instead."
            : "Could not finish joining. Please try again.",
      },
      { status: insertErr.code === "23505" ? 409 : 500 }
    );
  }

  // Consume the invite. Keyed on the hash again so two concurrent accepts
  // cannot both win past the roster's primary key.
  const { error: consumeErr } = await admin
    .from("platform_admin_invites")
    .delete()
    .eq("id", row.id)
    .eq("invite_token_hash", tokenHash);
  if (consumeErr) console.error("accept-invite consume failed", consumeErr);

  // Seed a new account's profile so the invite's name shows in the header. An
  // existing account keeps the profile it has. Best-effort: a failure here
  // shouldn't undo a successful join.
  if (!existingAccount && name) {
    const { error: profileErr } = await admin
      .from("profile")
      .upsert({ user_id: userId, name }, { onConflict: "user_id" });
    if (profileErr) console.error("accept-invite profile seed failed", profileErr);
  }

  return Response.json({ ok: true, email: row.email, existingAccount: Boolean(existingAccount) });
}
