import "server-only";

/**
 * The session's user id when they are a platform admin. Not Google-specific:
 * the Google connection's guard is the admin side's one gate, used here too.
 * Every Slack reader, action and route passes THIS id, never one from input.
 */
export { googleAdminId as slackAdminId, requireGoogleAdminId as requireSlackAdminId } from "@/lib/admin/google/guard";
