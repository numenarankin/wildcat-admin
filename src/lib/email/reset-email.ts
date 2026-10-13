import "server-only";

import { getAppUrl } from "@/lib/env";
import { sendBrevoEmail, type BuiltEmail } from "@/lib/email/brevo";

/**
 * Build + send the password-reset email.
 *
 * Sent through Brevo rather than Supabase's built-in mailer for the same reason
 * sign-up verification is (`./verify-email`): the project's transactional mail
 * already goes out from one verified sender, and Supabase's default SMTP is
 * rate-limited to a handful of messages an hour — a limit a locked-out operator
 * would hit exactly when it matters most. The link still carries a genuine
 * Supabase recovery token; only the delivery is ours.
 *
 * Markup deliberately mirrors `./verify-email` and `./invite-email` — same table
 * shell, same inline styles, same button — so every email we send looks like it
 * came from the same company.
 */

/** Minimal HTML escaping for values interpolated into the email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Absolute URL for a Supabase recovery token.
 *
 * We build the link ourselves rather than forwarding Supabase's `action_link`
 * so that recovery does not depend on the project's redirect allow-list being
 * configured for every environment we run in. `/auth/reset` redeems the hash
 * with `verifyOtp` on arrival.
 */
export function resetUrl(tokenHash: string, appUrl: string = getAppUrl()): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/auth/reset?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`;
}

export interface SendResetEmailInput {
  /** The account's email — the recipient. */
  email: string;
  /** Supabase's hashed recovery token, straight from `generateLink`. */
  tokenHash: string;
  /**
   * The app whose `/auth/reset` redeems the link. Defaults to this admin app;
   * a customer's reset (sent from Clients) passes the customer app's origin.
   */
  appUrl?: string;
}

/** The reset message for an address + token hash. Pure; no I/O. */
export function buildResetEmail({
  email,
  tokenHash,
  appUrl,
}: SendResetEmailInput): BuiltEmail {
  const url = resetUrl(tokenHash, appUrl);
  const safeEmail = escapeHtml(email.trim());

  const htmlContent = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 12px;font-size:15px;">Hi,</p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
            We got a request to reset the password for <strong>${safeEmail}</strong>
            on WildcatIQ. Click below to choose a new one.
          </p>
          <p style="margin:0 0 24px;">
            <a href="${url}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">Reset your password</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#78716c;">Or paste this link into your browser:</p>
          <p style="margin:0 0 20px;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#0369a1;">${url}</a></p>
          <p style="margin:0;font-size:12px;color:#a8a29e;">This link expires in 1 hour and can only be used once. If you didn't ask to reset your password, you can ignore this email. Nothing has changed.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textContent = `Hi,

We got a request to reset the password for ${email.trim()} on WildcatIQ.

Reset your password: ${url}

This link expires in 1 hour and can only be used once. If you didn't ask to reset your password, you can ignore this email. Nothing has changed.`;

  return {
    subject: "Reset your WildcatIQ password",
    htmlContent,
    textContent,
  };
}

/** Send the reset link. Throws on delivery failure. */
export async function sendResetEmail(
  input: SendResetEmailInput
): Promise<void> {
  await sendBrevoEmail({ to: [{ email: input.email }], ...buildResetEmail(input) });
}
