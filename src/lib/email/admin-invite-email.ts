import "server-only";

import { sendBrevoEmail, type BuiltEmail } from "@/lib/email/brevo";

/**
 * The email that brings someone onto the admin team: the customer app's
 * member invite (`lib/email/invite-email.ts`), addressed to the admin side.
 * The secure invite link is delivered here and nowhere else, so a delivery
 * failure is meaningful: the caller deletes the pending invite when this
 * throws.
 *
 * Markup mirrors `./reset-email` so every email we send looks alike.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The deployed admin origin. Hardcoded on purpose: env-driven URLs sent invites to localhost. */
const ADMIN_ORIGIN = "https://admin-suite-tan.vercel.app";

/** Absolute invite URL for a raw token on the deployed admin origin. */
export function inviteUrl(token: string): string {
  return `${ADMIN_ORIGIN}/invite/${token}`;
}

export interface AdminInviteInput {
  /** Invitee display name (may be empty). */
  name: string;
  /** Invitee email, the recipient. */
  email: string;
  /** Raw, single-use invite token to embed in the link. */
  token: string;
}

/** The invite message for a name + token. Pure; no I/O. */
export function buildAdminInviteEmail({ name, token }: Omit<AdminInviteInput, "email">): BuiltEmail {
  const url = inviteUrl(token);
  const safeName = escapeHtml(name.trim());
  const greeting = safeName ? `Hi ${safeName},` : "Hi,";

  const htmlContent = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 12px;font-size:15px;">${greeting}</p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
            You've been invited to join the WildcatIQ admin team. Click the button
            below to set up your account and get started.
          </p>
          <p style="margin:0 0 24px;">
            <a href="${url}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">Accept invite</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#78716c;">Or paste this link into your browser:</p>
          <p style="margin:0 0 20px;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#0369a1;">${url}</a></p>
          <p style="margin:0;font-size:12px;color:#a8a29e;">This invite link expires in 7 days. If you weren't expecting it, you can ignore this email.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textContent = `${name.trim() ? `Hi ${name.trim()},` : "Hi,"}

You've been invited to join the WildcatIQ admin team.

Accept your invite: ${url}

This invite link expires in 7 days. If you weren't expecting it, you can ignore this email.`;

  return { subject: "You've been invited to the WildcatIQ admin team", htmlContent, textContent };
}

/** Send the invite link to the invitee. Throws on delivery failure. */
export async function sendAdminInviteEmail({ name, email, token }: AdminInviteInput): Promise<void> {
  await sendBrevoEmail({
    to: [{ email, name: name.trim() || undefined }],
    ...buildAdminInviteEmail({ name, token }),
  });
}
