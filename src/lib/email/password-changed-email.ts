import "server-only";

import { sendBrevoEmail, type BuiltEmail } from "@/lib/email/brevo";

/**
 * "Your password was changed" — sent after the fact, to the account's own
 * address.
 *
 * Not a confirmation the user has to act on: the change has already happened.
 * It exists because a password change nobody is told about is a silent account
 * takeover, and the person who did not make it is the one who needs to know.
 * Sent for both routes a password can change — the Settings card and the
 * emailed reset link — since either could be someone else.
 *
 * Never blocking: a mail failure must not undo or report a password change that
 * already succeeded.
 */

const SOURCE_PHRASE: Record<"settings" | "reset", string> = {
  settings: "changed from your account settings",
  reset: "reset using an emailed link",
};

/** Which route changed the password, so the notice matches what just happened. */
export type PasswordChangeRoute = "settings" | "reset";

/** The after-the-fact notice for one route. Pure; no I/O. */
export function buildPasswordChangedEmail(
  via: PasswordChangeRoute
): BuiltEmail {
  const htmlContent = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 12px;font-size:15px;">Hi,</p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
            The password on your WildcatIQ account was just
            ${SOURCE_PHRASE[via]}. Nothing else about your account has changed.
          </p>
          <p style="margin:0;font-size:12px;color:#a8a29e;">If this wasn't you, reset your password from the sign-in page straight away and contact us. Someone else may have access to your account.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textContent = `Hi,

The password on your WildcatIQ account was just ${SOURCE_PHRASE[via]}. Nothing else about your account has changed.

If this wasn't you, reset your password from the sign-in page straight away and contact us. Someone else may have access to your account.`;

  return {
    subject: "Your WildcatIQ password was changed",
    htmlContent,
    textContent,
  };
}

export async function sendPasswordChangedEmail({
  email,
  via,
}: {
  email: string;
  via: PasswordChangeRoute;
}): Promise<void> {
  await sendBrevoEmail({
    to: [{ email }],
    ...buildPasswordChangedEmail(via),
  });
}
