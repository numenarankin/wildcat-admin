/**
 * Land in the workspace that was just entered.
 *
 * A full document load, not a router push or a refresh. The sidebar, the credit
 * balance, the notification feed, the AI page context and every open realtime
 * channel were all built for the org being left, and a client-side navigation
 * keeps them. Half a workspace from the org you just left is worse than a second
 * of white.
 */
export function enterWorkspace(): void {
  window.location.assign("/");
}
