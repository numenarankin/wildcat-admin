import "server-only";

import { hasBrevo, sendBrevoEmail, type BuiltEmail } from "@/lib/email/brevo";

/**
 * Notify the platform account executive (AE) when a user posts a support
 * message. One AE serves the whole platform (address in `SUPPORT_AE_EMAIL`), so
 * there is no per-tenant routing. The AE opens Archon and replies through the
 * staff support view; this email is purely a heads-up, so a delivery failure is
 * logged, never fatal (the user's message must still go through).
 */

export interface AeAlertInput {
  /** Sender's display name (may be empty). */
  name: string;
  /** Sender's email (used as the reply-to so the AE can reach them directly). */
  email: string;
  /** Sender's company / organization name (may be empty). */
  company: string;
  /** The support message body the user sent. */
  body: string;
  /** Number of files attached to the message (0 when none). */
  attachmentCount?: number;
}

/** Minimal HTML escaping for values interpolated into the email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap body HTML in the shared card shell (matches the other support emails). */
function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${escapeHtml(title)}</p>
          ${bodyHtml}
          <p style="margin:24px 0 0;font-size:12px;color:#a8a29e;">Open Archon to reply from the support desk.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * The AE heads-up for one support message. Pure; no I/O, so `/dev/notifications`
 * can render the alert staff receive without mailing anyone.
 */
export function buildAeAlertEmail({
  name,
  email,
  company,
  body,
  attachmentCount = 0,
}: AeAlertInput): BuiltEmail {
  const who = name.trim() || email;
  const org = company.trim();
  const subject = org
    ? `New support message from ${who} (${org})`
    : `New support message from ${who}`;

  const text = body.trim();
  const attachmentNote =
    attachmentCount > 0
      ? `\n\n(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"} included)`
      : "";

  const detailsHtml = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#44403c;">
    <tr><td style="padding-right:12px;color:#78716c;">Name</td><td>${escapeHtml(name.trim() || "-")}</td></tr>
    <tr><td style="padding-right:12px;color:#78716c;">Email</td><td>${escapeHtml(email)}</td></tr>
    <tr><td style="padding-right:12px;color:#78716c;">Company</td><td>${escapeHtml(org || "-")}</td></tr>
  </table>`;

  const bodyBlockHtml = text
    ? `<p style="margin:0 0 8px;font-size:13px;color:#78716c;">Message</p>
       <p style="margin:0 0 12px;padding:12px 14px;background:#f5f5f4;border-radius:8px;font-size:14px;line-height:1.5;color:#1c1917;white-space:pre-wrap;">${escapeHtml(text)}</p>`
    : "";

  const attachmentHtml =
    attachmentCount > 0
      ? `<p style="margin:0;font-size:13px;color:#78716c;">${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"} included.</p>`
      : "";

  const textContent = `New support message from ${who}${org ? ` (${org})` : ""}.

Name: ${name.trim() || "-"}
Email: ${email}
Company: ${org || "-"}

Message:
${text || "(no text)"}${attachmentNote}

Open Archon to reply from the support desk.`;

  return {
    subject,
    htmlContent: shell(subject, detailsHtml + bodyBlockHtml + attachmentHtml),
    textContent,
  };
}

/**
 * Email the account executive about a new user support message. Silently no-ops
 * (with a warning) when email or the AE address is unconfigured, and swallows
 * send failures after logging them, so the caller's flow is never broken.
 */
export async function notifyAccountExecutive({
  name,
  email,
  company,
  body,
  attachmentCount = 0,
}: AeAlertInput): Promise<void> {
  const aeEmail = process.env.SUPPORT_AE_EMAIL?.trim();
  const aeName = process.env.SUPPORT_AE_NAME?.trim() || undefined;

  // One line per attempt, before any of the guards below can silently skip it:
  // which knobs the process can actually see. The address is printed because
  // the usual failure is that it is empty or points somewhere unexpected.
  console.info("notifyAccountExecutive: start", {
    aeEmail: aeEmail || "(unset)",
    aeName: aeName ?? "(unset)",
    brevoConfigured: hasBrevo(),
    from: process.env.BREVO_SENDER_EMAIL ?? "(unset)",
  });

  if (!aeEmail) {
    console.warn(
      "notifyAccountExecutive: SUPPORT_AE_EMAIL is unset; skipping AE alert"
    );
    return;
  }
  if (!hasBrevo()) {
    console.warn(
      "notifyAccountExecutive: Brevo is not configured; skipping AE alert"
    );
    return;
  }

  const { subject, htmlContent, textContent } = buildAeAlertEmail({
    name,
    email,
    company,
    body,
    attachmentCount,
  });

  try {
    const { messageId } = await sendBrevoEmail({
      to: [{ email: aeEmail, name: aeName }],
      subject,
      htmlContent,
      textContent,
      // Let the AE reply straight to the user if they choose to.
      replyTo: { email, name: name.trim() || undefined },
    });
    console.info("notifyAccountExecutive: sent", { to: aeEmail, messageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "send failed";
    console.error("notifyAccountExecutive: AE alert send failed", msg);
  }
}
