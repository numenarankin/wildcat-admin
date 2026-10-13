import "server-only";

import type { BuiltEmail } from "@/lib/email/brevo";
import { notificationType } from "@/lib/notifications/types";

/**
 * Turn a stored notification (`type` + `payload`) into a ready-to-send email.
 *
 * Returns null for an unknown type or a payload that can't be rendered, so the
 * route handler can mark the row `skipped` instead of sending garbage. The HTML
 * shell mirrors the invite email for a consistent look.
 */

// The shape every builder in the email layer returns; defined once, in brevo.ts.
export type { BuiltEmail } from "@/lib/email/brevo";

type Payload = Record<string, unknown>;

/** Minimal HTML escaping for values interpolated into the email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function str(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** Wrap body HTML in the shared card shell (matches invite-email.ts). */
function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${escapeHtml(title)}</p>
          ${bodyHtml}
          <p style="margin:24px 0 0;font-size:12px;color:#a8a29e;">You're receiving this because notifications for this event are on. Manage them in Settings &gt; Notifications.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escapeHtml(
    text
  )}</p>`;
}

/** Build the subject/body for a notification, or null if it can't be rendered. */
export function buildNotificationEmail(
  type: string,
  payload: Payload
): BuiltEmail | null {
  const def = notificationType(type);
  if (!def) return null;

  switch (type) {
    // Wells and every other facility render identically; only the payload key
    // for the facility's name differs (`well_comment` predates the shared
    // thread and keeps its original shape).
    case "well_comment":
    case "facility_comment": {
      const facility =
        type === "well_comment"
          ? str(payload.well_name) || str(payload.well_id) || "a well"
          : str(payload.entity_name) || str(payload.entity_id) || "a facility";
      const body = str(payload.body).trim();
      const subject = `New comment on ${facility}`;
      const lines = [`A new comment was posted on ${facility}.`];
      if (body) lines.push(`"${body}"`);
      return {
        subject,
        htmlContent: shell(
          subject,
          paragraph(`A new comment was posted on ${facility}.`) +
            (body
              ? `<p style="margin:0 0 12px;padding:12px 14px;background:#f5f5f4;border-radius:8px;font-size:14px;line-height:1.5;color:#44403c;">${escapeHtml(
                  body
                )}</p>`
              : "")
        ),
        textContent: lines.join("\n\n"),
      };
    }

    // Directed siblings of the comment fan-out above: the subject names the
    // person, because the recipient was answered or named personally.
    case "comment_reply":
    case "comment_mention": {
      const facility =
        str(payload.entity_name) || str(payload.entity_id) || "a facility";
      const author = str(payload.author_name) || "Someone";
      const body = str(payload.body).trim();
      const verb =
        type === "comment_reply" ? "replied to your comment" : "mentioned you";
      const subject = `${author} ${verb} on ${facility}`;
      const lines = [`${author} ${verb} on ${facility}.`];
      if (body) lines.push(`"${body}"`);
      return {
        subject,
        htmlContent: shell(
          subject,
          paragraph(`${author} ${verb} on ${facility}.`) +
            (body
              ? `<p style="margin:0 0 12px;padding:12px 14px;background:#f5f5f4;border-radius:8px;font-size:14px;line-height:1.5;color:#44403c;">${escapeHtml(
                  body
                )}</p>`
              : "")
        ),
        textContent: lines.join("\n\n"),
      };
    }

    // Off by default on email (the user has to opt in), but still rendered:
    // a type with no builder would silently drop for whoever turns it on.
    case "comment_like": {
      const facility =
        str(payload.entity_name) || str(payload.entity_id) || "a facility";
      const liker = str(payload.liker_name) || "Someone";
      const body = str(payload.body).trim();
      const subject = `${liker} liked your comment on ${facility}`;
      const lines = [`${liker} liked your comment on ${facility}.`];
      if (body) lines.push(`"${body}"`);
      return {
        subject,
        htmlContent: shell(
          subject,
          paragraph(`${liker} liked your comment on ${facility}.`) +
            (body
              ? `<p style="margin:0 0 12px;padding:12px 14px;background:#f5f5f4;border-radius:8px;font-size:14px;line-height:1.5;color:#44403c;">${escapeHtml(
                  body
                )}</p>`
              : "")
        ),
        textContent: lines.join("\n\n"),
      };
    }

    case "well_production": {
      const count = num(payload.count);
      const wellCount = num(payload.well_count);
      const date = str(payload.latest_date);
      const names = Array.isArray(payload.well_names)
        ? (payload.well_names as unknown[]).map((n) => str(n)).filter(Boolean)
        : [];
      const readings = `${count} production reading${count === 1 ? "" : "s"}`;
      const wells = `${wellCount} well${wellCount === 1 ? "" : "s"}`;
      const subject = `${readings} added`;
      const dateText = date ? ` (through ${date})` : "";
      const namesText = names.length
        ? `Wells: ${names.join(", ")}${wellCount > names.length ? ", …" : ""}.`
        : "";
      return {
        subject,
        htmlContent: shell(
          subject,
          paragraph(`${readings} across ${wells} were added${dateText}.`) +
            (namesText ? paragraph(namesText) : "")
        ),
        textContent:
          `${readings} across ${wells} were added${dateText}.` +
          (namesText ? `\n\n${namesText}` : ""),
      };
    }

    case "well_equipment_status": {
      const well = str(payload.well_name) || str(payload.well_id) || "a well";
      const equipment = str(payload.equipment_name) || "Equipment";
      const from = str(payload.old_status);
      const to = str(payload.new_status);
      const subject = `${equipment} on ${well} is now ${to}`;
      const change =
        from && to
          ? `${equipment} on ${well} changed from ${from} to ${to}.`
          : `${equipment} on ${well} is now ${to}.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(change)),
        textContent: change,
      };
    }

    case "transaction_added": {
      const source = str(payload.source);
      if (source === "upload") {
        const file = str(payload.file_name) || "an accounting file";
        const count = num(payload.txn_count);
        const total = USD.format(num(payload.total_amount));
        const txns = `${count} transaction${count === 1 ? "" : "s"}`;
        const subject = `${txns} imported from ${file}`;
        const line = `${txns} totaling ${total} were imported from ${file}.`;
        return {
          subject,
          htmlContent: shell(subject, paragraph(line)),
          textContent: line,
        };
      }
      if (source === "manual_batch") {
        const count = num(payload.count);
        const total = USD.format(num(payload.total_amount));
        const txns = `${count} transaction${count === 1 ? "" : "s"}`;
        const subject = `${txns} added`;
        const line = `${txns} totaling ${total} were added.`;
        return {
          subject,
          htmlContent: shell(subject, paragraph(line)),
          textContent: line,
        };
      }
      // Single manual transaction.
      const kind = str(payload.kind) || "transaction";
      const counterparty = str(payload.counterparty);
      const amount = USD.format(num(payload.amount));
      const date = str(payload.txn_date);
      const who = counterparty ? ` with ${counterparty}` : "";
      const when = date ? ` on ${date}` : "";
      const subject = `New ${kind}: ${amount}`;
      const line = `A ${kind} of ${amount}${who}${when} was added.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "chat_message": {
      // Off by default (see the registry). Someone who turns it ON wants the
      // message itself in the inbox, not a "you have a notification" stub.
      const sender = str(payload.sender_name) || "Someone";
      const group = str(payload.channel_kind) === "channel";
      const name = str(payload.channel_name).trim();
      const body = str(payload.body).trim();
      const where = group ? ` in ${name || "a group chat"}` : "";
      const subject = group
        ? `${sender} posted${where}`
        : `${sender} sent you a message`;
      const lead = `${sender} sent a message${where}.`;
      const lines = [lead];
      if (body) lines.push(`"${body}"`);
      lines.push("Open Messages in the app to reply.");
      return {
        subject,
        htmlContent: shell(
          subject,
          paragraph(lead) +
            (body
              ? `<p style="margin:0 0 12px;padding:12px 14px;background:#f5f5f4;border-radius:8px;font-size:14px;line-height:1.5;color:#44403c;">${escapeHtml(
                  body
                )}</p>`
              : "") +
            paragraph("Open Messages in the app to reply.")
        ),
        textContent: lines.join("\n\n"),
      };
    }

    case "support_reply": {
      const topic = str(payload.subject) || "your support request";
      const body = str(payload.body).trim();
      const subject = `Support replied to ${topic}`;
      const lines = [`Our support team replied to ${topic}.`];
      if (body) lines.push(`"${body}"`);
      lines.push("Open Support in the app to continue the conversation.");
      return {
        subject,
        htmlContent: shell(
          subject,
          paragraph(`Our support team replied to ${topic}.`) +
            (body
              ? `<p style="margin:0 0 12px;padding:12px 14px;background:#f5f5f4;border-radius:8px;font-size:14px;line-height:1.5;color:#44403c;">${escapeHtml(
                  body
                )}</p>`
              : "") +
            paragraph("Open Support in the app to continue the conversation.")
        ),
        textContent: lines.join("\n\n"),
      };
    }

    case "invite_accepted": {
      const name = str(payload.member_name) || str(payload.member_email) || "Someone";
      const email = str(payload.member_email);
      const subject = `${name} joined your workspace`;
      const line = `${name}${email ? ` (${email})` : ""} accepted your invitation and now has access.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "membership_changed": {
      const removed = str(payload.change) === "removed";
      const subject = removed
        ? "You were removed from the workspace"
        : "Your workspace access was updated";
      const line = removed
        ? "Your access to the workspace has been removed. Contact an administrator if this was unexpected."
        : "An administrator updated your permissions. Sign in to see what changed.";
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "task_assigned": {
      const title = str(payload.title) || "a task";
      const priority = str(payload.priority);
      const subject = `Task assigned: ${title}`;
      const line = `You were assigned "${title}"${priority ? ` (${priority} priority)` : ""}.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "task_deadline": {
      const title = str(payload.title) || "a task";
      const due = str(payload.due_date);
      const subject = `Task due tomorrow: ${title}`;
      const line = `"${title}" is due${due ? ` on ${due}` : " tomorrow"}.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "inventory_status": {
      const name = str(payload.name) || "An item";
      const qty = str(payload.quantity, "0");
      const unit = str(payload.unit);
      const location = str(payload.location);
      const subject = `Low inventory: ${name}`;
      const line = `${name} is low, ${qty}${unit ? ` ${unit}` : ""} remaining${location ? ` at ${location}` : ""}.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "document_ready": {
      const name = str(payload.name) || "Your document";
      const subject = `"${name}" is ready`;
      const line = `${name} finished processing and is now searchable in your files.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "seismic_ready": {
      const name = str(payload.name) || "Your volume";
      const subject = `"${name}" is ready`;
      const line = `${name} finished seismic analysis and is ready to open in your files.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "seismic_failed": {
      const name = str(payload.name) || "Your volume";
      const error = str(payload.error).trim().replace(/\.+$/, "");
      const subject = `"${name}" could not be analyzed`;
      const line = `${name} could not be analyzed${error ? `: ${error}.` : "."}`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "calendar_reminder": {
      const title = str(payload.title) || "an event";
      const date = str(payload.event_date);
      const time = str(payload.start_time);
      const location = str(payload.location);
      const subject = `Reminder: ${title} tomorrow`;
      const when = date ? ` on ${date}` : " tomorrow";
      const at = time ? ` at ${time}` : "";
      const where = location ? `, ${location}` : "";
      const line = `"${title}" is coming up${when}${at}${where}.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "billing_payments": {
      const event = str(payload.event);
      const status = str(payload.status);
      let subject: string;
      let line: string;
      const wells = num(payload.wells);
      const amount = num(payload.delta_usd);
      const per = str(payload.interval) === "year" ? "year" : "month";
      const money = amount ? `$${Math.round(amount).toLocaleString()} / ${per}` : null;
      if (event === "band_up_available") {
        subject = "Your wells have outgrown your plan";
        line = `You now have ${wells?.toLocaleString() ?? "more"} wells, which is more than your current plan covers. Upgrade from Billing to keep adding wells.`;
      } else if (event === "band_down_available") {
        subject = "You can move to a cheaper plan";
        line = `You're down to ${wells?.toLocaleString() ?? "fewer"} wells, which fits a smaller plan. Switch from Billing and pay less from your next bill.`;
      } else if (event === "band_upgraded") {
        subject = "Your plan was upgraded";
        line = `Your plan now covers ${wells?.toLocaleString() ?? "your"} wells${money ? `, ${money} more` : ""}. The difference was charged pro rata for the rest of your billing term.`;
      } else if (event === "band_downgraded") {
        subject = "Your plan was downgraded";
        line = `Your plan now matches your ${wells?.toLocaleString() ?? ""} wells${money ? `, ${money} less` : ""}. The lower amount starts on your next bill.`;
      } else if (event === "switched_to_annual") {
        subject = "You're now billed annually";
        line = payload.trialing
          ? "Your plan is now billed annually. Nothing is charged while your free trial runs; your first annual invoice arrives when it ends."
          : "Your plan is now billed annually, starting today. The unused part of this month was credited against your annual invoice.";
      } else if (event === "payment_failed") {
        subject = "A payment failed";
        line =
          "A recent payment for your subscription failed. Update your billing details to avoid an interruption in service.";
      } else if (event === "canceled") {
        subject = "Your subscription was canceled";
        line =
          "Your subscription has been canceled. You can resubscribe any time from Billing.";
      } else {
        subject = "Your subscription changed";
        line = `Your subscription${status ? ` is now ${status}` : " was updated"}. Review the details in Billing.`;
      }
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    case "credits_low": {
      const balance = num(payload.balance);
      const subject = "AI credits running low";
      const line = `Your workspace has ${balance.toLocaleString("en-US")} AI credit${balance === 1 ? "" : "s"} left. Top up to keep AI features running.`;
      return {
        subject,
        htmlContent: shell(subject, paragraph(line)),
        textContent: line,
      };
    }

    default:
      return null;
  }
}
