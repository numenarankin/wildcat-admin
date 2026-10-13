/**
 * Notification type registry: the single source of truth shared by the
 * Settings > Notifications toggle UI and the email builder.
 *
 * Each `key` matches a `type` written by a domain trigger, an app-code enqueue
 * (Stripe webhook), or a scheduled sweep (see the `2026070100200`, `2026070400*`
 * migrations and `/api/cron/notifications`).
 *
 * The shipped defaults, which SQL `notif_default_enabled(type, channel)` must
 * match key for key (it is what actually decides delivery for a user who has
 * never opened Settings):
 *
 *   in-app  on for every type — the bell is the cheap channel
 *   email   on for the six that reach someone who is NOT in the app:
 *           support replies, invitations accepted, access changes, billing,
 *           AI credits, and a finished seismic analysis
 *   mobile  on for everything except new financial transactions and a
 *           processed document — neither is worth a buzz in a truck
 *
 * Plain module (no `server-only`): imported by the client settings tab as well
 * as server-side email code, so it must stay free of server-only imports.
 */

/**
 * Which capability group gates a type's visibility in Settings:
 *   personal  — shown to everyone (it is about the signed-in user)
 *   financial — shown to users who can see accounting
 *   admin     — shown to workspace admins / member managers
 * The group is a UI concern only; who actually *receives* a type is decided by
 * the capability set passed to `enqueue_notification()` in the SQL triggers.
 */
export type NotificationGroup = "personal" | "financial" | "admin";

export interface NotificationType {
  /** Stable key stored on `notifications.type`. */
  key: string;
  /** Row label in the Settings toggle table. */
  label: string;
  /** One-line description under the label. */
  description: string;
  /** Drives which users see the row (financial rows need accounting access). */
  group: NotificationGroup;
  /** Default when the user has no explicit preference row. */
  defaultEnabled: boolean;
  /**
   * Per-channel overrides of {@link defaultEnabled}, for a type that should
   * arrive one way and not another out of the box: a direct message is worth a
   * bell and a buzz, and is not worth an email per message.
   *
   * The SQL side must agree: `notif_default_enabled(type, channel)` carries the
   * same table, and it is what decides delivery for a user who has never opened
   * the Settings row.
   */
  defaultChannels?: Partial<Record<keyof ChannelPreference, boolean>>;
}

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  {
    key: "well_comment",
    label: "Comments on wells",
    description: "When someone posts a comment on a well.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "facility_comment",
    label: "Comments on other facilities",
    description:
      "When someone posts a comment on a tank, meter, battery or lease.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "comment_reply",
    label: "Replies to your comments",
    description: "When someone replies to a comment you wrote.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "comment_like",
    label: "Likes on your comments",
    description: "When someone likes a comment you wrote.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "comment_mention",
    label: "Mentions",
    description: "When someone @-mentions you in a comment.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "well_production",
    label: "New production readings",
    description:
      "When production readings are added. Imports are batched into one alert.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "well_equipment_status",
    label: "Equipment status changes",
    description: "When a well's equipment changes status (e.g. goes down).",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "transaction_added",
    label: "New financial transactions",
    description:
      "When transactions are added or an accounting file is imported.",
    group: "financial",
    defaultEnabled: true,
    defaultChannels: { email: false, mobile: false },
  },
  {
    key: "chat_message",
    label: "Direct messages",
    description:
      "When a coworker sends you a message or posts in one of your group chats.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "support_reply",
    label: "Support replies",
    description: "When our support team replies to one of your requests.",
    group: "personal",
    defaultEnabled: true,
  },
  {
    key: "invite_accepted",
    label: "Invitations accepted",
    description: "When someone accepts an invite and joins your workspace.",
    group: "admin",
    defaultEnabled: true,
  },
  {
    key: "membership_changed",
    label: "Your access changes",
    description:
      "When your permissions change or you're removed from a workspace.",
    group: "personal",
    defaultEnabled: true,
  },
  {
    key: "task_assigned",
    label: "Tasks assigned to you",
    description: "When a task is assigned to you by name.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "task_deadline",
    label: "Task deadlines",
    description: "A reminder the day before a task is due.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "inventory_status",
    label: "Low inventory",
    description: "When an inventory item drops to Low.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "document_ready",
    label: "Document processed",
    description: "When a file you uploaded finishes text extraction.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false, mobile: false },
  },
  {
    key: "calendar_reminder",
    label: "Calendar reminders",
    description: "A reminder the day before a calendar event.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    // docs/plans/seismic.md, "### Notifications": bell and phone on for both,
    // email on for ready (an analysis runs long enough that whoever started
    // it has left) and off for failures. SQL side: 2026091600600.
    key: "seismic_ready",
    label: "Seismic analysis ready",
    description: "When a seismic volume you digitized finishes analysis.",
    group: "personal",
    defaultEnabled: true,
  },
  {
    key: "seismic_failed",
    label: "Seismic analysis failed",
    description: "When a seismic volume you digitized could not be analyzed.",
    group: "personal",
    defaultEnabled: true,
    defaultChannels: { email: false },
  },
  {
    key: "billing_payments",
    label: "Billing & payments",
    description: "When a payment fails or your subscription changes.",
    group: "admin",
    defaultEnabled: true,
  },
  {
    key: "credits_low",
    label: "AI credits low",
    description: "When your workspace's AI credit balance runs low.",
    group: "admin",
    defaultEnabled: true,
  },
] as const;

export const NOTIFICATION_TYPE_KEYS: readonly string[] = NOTIFICATION_TYPES.map(
  (t) => t.key
);

/** The delivery channels a user can toggle per type, independently. */
export type NotificationChannel = "email" | "in_app" | "mobile";

/** A type's on/off state for each channel. */
export interface ChannelPreference {
  email: boolean;
  inApp: boolean;
  /**
   * Push to the phone app. The preference and the per-row `notifications.mobile`
   * stamp are live (migration `2026081700200`); the dispatcher that turns a
   * stamped row into a push is not built yet, so this currently records an
   * instruction rather than delivering anything.
   */
  mobile: boolean;
}

const TYPE_BY_KEY = new Map(NOTIFICATION_TYPES.map((t) => [t.key, t]));

/** Look up a type, or undefined for an unknown key. */
export function notificationType(key: string): NotificationType | undefined {
  return TYPE_BY_KEY.get(key);
}

/** Whether a type key is one we know about. */
export function isNotificationType(key: string): boolean {
  return TYPE_BY_KEY.has(key);
}

/**
 * One type's default on one channel: its `defaultEnabled`, unless the registry
 * overrides that channel. The single place this fallback is expressed on the
 * TypeScript side — `defaultPreferences()` and the preferences loader both go
 * through it, so a per-channel default cannot apply in one and not the other.
 */
export function defaultChannelPreference(
  type: NotificationType
): ChannelPreference {
  const base = type.defaultEnabled;
  return {
    email: type.defaultChannels?.email ?? base,
    inApp: type.defaultChannels?.inApp ?? base,
    mobile: type.defaultChannels?.mobile ?? base,
  };
}

/**
 * Default per-channel preference map keyed by type, used to seed the settings
 * UI and the effective-preferences loader. A type's channels agree unless its
 * registry entry says otherwise (the SQL `notif_default_enabled()` must agree).
 */
export function defaultPreferences(): Record<string, ChannelPreference> {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((t) => [t.key, defaultChannelPreference(t)])
  );
}
