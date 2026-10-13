"use client";

import { toast } from "sonner";

import type { InAppNotification } from "@/lib/notifications/in-app";

/**
 * Fire the bottom-right toast for one in-app notification.
 *
 * Lives beside the provider rather than inside it so the dev harness
 * (`/dev/notifications`) raises the SAME toast a real row raises: one call site
 * for the sonner options, so a change to the action label or the description
 * cannot land in the app and miss the harness.
 */
export function showNotificationToast(
  info: InAppNotification,
  navigate: (href: string) => void
): void {
  toast(info.title, {
    description: info.body,
    action: info.href
      ? { label: "View", onClick: () => navigate(info.href!) }
      : undefined,
  });
}
