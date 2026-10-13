/**
 * Client-safe formatter for the in-app channel (bell rows + bottom-right toasts).
 *
 * The mirror of `buildNotificationEmail` (email.ts) but shorter strings and a
 * deep link instead of an HTML shell — and, crucially, **no `server-only`
 * import**, so it can run in the browser inside the notifications provider. Both
 * are driven by the same `NOTIFICATION_TYPES` registry so the text stays in
 * lockstep across channels.
 *
 * The payload arrives over the Realtime wire here (unlike the email route, which
 * reloads the row by id), so treat it as **display data only, never a trust
 * decision**. React escapes the strings; we never build HTML.
 */

import { notificationType } from "@/lib/notifications/types";

export interface InAppNotification {
  /** Toast headline + bell row label. */
  title: string;
  /** One-line secondary text for the toast description / bell card. */
  body?: string;
  /** Deep link opened on click; undefined = not clickable. */
  href?: string;
}

type Payload = Record<string, unknown>;

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

/** How an unnamed facility reads in a comment notification title. */
const FACILITY_LABEL: Record<string, string> = {
  well: "a well",
  tank: "a tank",
  meter: "a meter",
  battery: "a battery",
  lease: "a lease",
};

/** The page a facility comment links to. Mirrors `commentPaths` in @/lib/comments. */
function facilityHref(entityType: string, entityId: string): string | undefined {
  if (!entityId) return undefined;
  switch (entityType) {
    case "well":
      return `/production/wells/${entityId}`;
    case "tank":
      return `/production/tanks/${entityId}`;
    case "meter":
      return `/production/meters/${entityId}`;
    case "battery":
      return `/production/batteries/${entityId}`;
    case "lease":
      return `/leases/${entityId}`;
    default:
      return undefined;
  }
}

/**
 * Turn a stored notification (`type` + `payload`) into `{ title, body?, href? }`,
 * or null for an unknown/unrenderable type so the UI can skip the row/toast.
 */
export function buildInApp(
  type: string,
  payload: Payload
): InAppNotification | null {
  if (!notificationType(type)) return null;
  const p = payload ?? {};

  switch (type) {
    case "well_comment": {
      const well = str(p.well_name) || str(p.well_id) || "a well";
      const wellId = str(p.well_id);
      const body = str(p.body).trim();
      return {
        title: `New comment on ${well}`,
        body: body || undefined,
        href: wellId ? `/wells/${wellId}` : undefined,
      };
    }

    case "facility_comment": {
      const kind = str(p.entity_type);
      const name = str(p.entity_name) || str(p.entity_id) || FACILITY_LABEL[kind];
      const body = str(p.body).trim();
      const href = facilityHref(kind, str(p.entity_id));
      return {
        title: `New comment on ${name}`,
        body: body || undefined,
        href,
      };
    }

    // A reply and a mention are DIRECTED — the recipient is the person answered
    // or named, not the facility's watchers — so the author leads the title.
    // Both carry the same payload shape; only the verb differs.
    case "comment_reply":
    case "comment_mention": {
      const kind = str(p.entity_type);
      const name =
        str(p.entity_name) || str(p.entity_id) || FACILITY_LABEL[kind] || "a facility";
      const author = str(p.author_name) || "Someone";
      const body = str(p.body).trim();
      const verb =
        type === "comment_reply" ? "replied to your comment" : "mentioned you";
      return {
        title: `${author} ${verb} on ${name}`,
        body: body || undefined,
        href: facilityHref(kind, str(p.entity_id)),
      };
    }

    case "comment_like": {
      const kind = str(p.entity_type);
      const name =
        str(p.entity_name) || str(p.entity_id) || FACILITY_LABEL[kind] || "a facility";
      const liker = str(p.liker_name) || "Someone";
      const body = str(p.body).trim();
      return {
        title: `${liker} liked your comment on ${name}`,
        body: body || undefined,
        href: facilityHref(kind, str(p.entity_id)),
      };
    }

    case "well_production": {
      const count = num(p.count);
      const wellCount = num(p.well_count);
      const readings = `${count} production reading${count === 1 ? "" : "s"}`;
      const wells = `${wellCount} well${wellCount === 1 ? "" : "s"}`;
      const date = str(p.latest_date);
      return {
        title: `${readings} added`,
        body:
          `Across ${wells}` + (date ? ` (through ${date}).` : "."),
        href: "/production",
      };
    }

    case "well_equipment_status": {
      const well = str(p.well_name) || str(p.well_id) || "a well";
      const wellId = str(p.well_id);
      const equipment = str(p.equipment_name) || "Equipment";
      const to = str(p.new_status);
      const from = str(p.old_status);
      return {
        title: `${equipment} on ${well} is now ${to}`,
        body: from && to ? `Changed from ${from} to ${to}.` : undefined,
        href: wellId ? `/wells/${wellId}` : undefined,
      };
    }

    case "transaction_added": {
      const source = str(p.source);
      if (source === "upload") {
        const file = str(p.file_name) || "an accounting file";
        const count = num(p.txn_count);
        const total = USD.format(num(p.total_amount));
        const txns = `${count} transaction${count === 1 ? "" : "s"}`;
        return {
          title: `${txns} imported from ${file}`,
          body: `Totaling ${total}.`,
          href: "/accounting",
        };
      }
      if (source === "manual_batch") {
        const count = num(p.count);
        const total = USD.format(num(p.total_amount));
        const txns = `${count} transaction${count === 1 ? "" : "s"}`;
        return {
          title: `${txns} added`,
          body: `Totaling ${total}.`,
          href: "/accounting",
        };
      }
      // Single manual transaction.
      const kind = str(p.kind) || "transaction";
      const amount = USD.format(num(p.amount));
      const counterparty = str(p.counterparty);
      return {
        title: `New ${kind}: ${amount}`,
        body: counterparty ? `With ${counterparty}.` : undefined,
        href: "/accounting",
      };
    }

    case "chat_message": {
      const sender = str(p.sender_name) || "Someone";
      const group = str(p.channel_kind) === "channel";
      const name = str(p.channel_name).trim();
      const body = str(p.body).trim();
      const channelId = str(p.channel_id);
      return {
        // A DM is from a person; a group post is from a person IN somewhere,
        // and which group it was is the thing that decides whether to look now.
        title: group
          ? `${sender} posted in ${name || "a group chat"}`
          : `${sender} sent you a message`,
        // An attachment-only message has no body. Say something happened rather
        // than showing a headline with a blank line under it.
        body: body || "Sent an attachment",
        href: channelId ? `/messages?c=${channelId}` : "/messages",
      };
    }

    case "support_reply": {
      const topic = str(p.subject) || "your support request";
      const body = str(p.body).trim();
      return {
        title: `Support replied to ${topic}`,
        body: body || undefined,
        href: "/support",
      };
    }

    case "invite_accepted": {
      const name = str(p.member_name) || str(p.member_email) || "Someone";
      return {
        title: `${name} joined your workspace`,
        body: str(p.member_email) || undefined,
        href: "/settings",
      };
    }

    case "membership_changed": {
      const removed = str(p.change) === "removed";
      return {
        title: removed
          ? "You were removed from the workspace"
          : "Your workspace access was updated",
        body: removed ? undefined : "Your permissions changed.",
        href: removed ? undefined : "/settings",
      };
    }

    case "task_assigned": {
      const title = str(p.title) || "a task";
      const priority = str(p.priority);
      return {
        title: `Task assigned: ${title}`,
        body: priority ? `${priority} priority.` : undefined,
        href: "/agenda?view=board",
      };
    }

    case "task_deadline": {
      const title = str(p.title) || "a task";
      return {
        title: `Due tomorrow: ${title}`,
        body: str(p.due_date) ? `Due ${str(p.due_date)}.` : undefined,
        href: "/agenda?view=board",
      };
    }

    case "inventory_status": {
      const name = str(p.name) || "An item";
      const qty = str(p.quantity, "0");
      const unit = str(p.unit);
      return {
        title: `Low inventory: ${name}`,
        body: `${qty}${unit ? ` ${unit}` : ""} remaining.`,
        href: "/inventory",
      };
    }

    case "document_ready": {
      const name = str(p.name) || "Your document";
      return {
        title: `"${name}" is ready`,
        body: "Finished processing and now searchable.",
        href: "/files",
      };
    }

    case "seismic_ready": {
      const name = str(p.name) || "Your volume";
      const fileId = str(p.file_id);
      return {
        title: `"${name}" is ready`,
        body: "Seismic analysis finished.",
        href: fileId ? `/files/docs/${fileId}` : "/files",
      };
    }

    case "seismic_failed": {
      const name = str(p.name) || "Your volume";
      const fileId = str(p.file_id);
      const error = str(p.error);
      return {
        title: `"${name}" could not be analyzed`,
        body: error || undefined,
        href: fileId ? `/files/docs/${fileId}` : "/files",
      };
    }

    case "calendar_reminder": {
      const title = str(p.title) || "an event";
      const time = str(p.start_time);
      return {
        title: `Tomorrow: ${title}`,
        body: time ? `At ${time}.` : undefined,
        href: "/agenda",
      };
    }

    case "billing_payments": {
      const event = str(p.event);
      const wells = num(p.wells);
      // Band changes: the well count moved into another band. The "available"
      // pair is the prompt waiting to be clicked; the applied pair is what
      // happened when it was.
      if (event === "band_up_available") {
        return {
          title: "Your wells have outgrown your plan",
          body: `${wells?.toLocaleString() ?? "Your"} wells now need the next plan up. Upgrade in Billing.`,
          href: "/settings",
        };
      }
      if (event === "band_down_available") {
        return {
          title: "You can move to a cheaper plan",
          body: `You're down to ${wells?.toLocaleString() ?? "fewer"} wells. Downgrade in Billing and save.`,
          href: "/settings",
        };
      }
      if (event === "switched_to_annual") {
        return {
          title: "You're now billed annually",
          body: "The unused part of this month was credited against your annual invoice.",
          href: "/settings",
        };
      }
      if (event === "band_upgraded" || event === "band_downgraded") {
        const amount = num(p.delta_usd);
        const per = str(p.interval) === "year" ? "year" : "month";
        const money = amount ? `$${Math.round(amount).toLocaleString()}/${per}` : null;
        return event === "band_upgraded"
          ? {
              title: "Your plan was upgraded",
              body: money ? `${money} more, charged pro rata for the rest of your term.` : undefined,
              href: "/settings",
            }
          : {
              title: "Your plan was downgraded",
              body: money ? `${money} less from your next bill.` : undefined,
              href: "/settings",
            };
      }
      if (event === "payment_failed") {
        return {
          title: "A payment failed",
          body: "Update your billing details to avoid interruption.",
          href: "/settings",
        };
      }
      if (event === "canceled") {
        return { title: "Your subscription was canceled", href: "/settings" };
      }
      return {
        title: "Your subscription changed",
        body: str(p.status) ? `Now ${str(p.status)}.` : undefined,
        href: "/settings",
      };
    }

    case "credits_low": {
      const balance = num(p.balance);
      return {
        title: "AI credits running low",
        body: `${balance.toLocaleString("en-US")} left.`,
        href: "/settings",
      };
    }

    default:
      return null;
  }
}
