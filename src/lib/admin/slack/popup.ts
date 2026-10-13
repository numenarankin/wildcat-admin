import "server-only";
import { GOOGLE_SETTINGS_PATH, type PopupTarget } from "@/lib/admin/google/popup";

/** Slack's popup round trip: the Google one's page, its own message and error parameter. */
export const SLACK_POPUP: PopupTarget = { source: "wildcat-admin-slack-oauth", errorParam: "slack_error", title: "Slack" };

/** Both connections live on Settings > Connections. */
export const SLACK_SETTINGS_PATH = GOOGLE_SETTINGS_PATH;
