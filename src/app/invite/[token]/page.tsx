import { lookupInvite } from "@/lib/auth/invite-data";
import { AcceptInvite } from "@/components/auth/accept-invite";
import { InviteUnavailable } from "@/components/auth/invite-unavailable";

export const metadata = { title: "Invitation" };

/**
 * Admin invite landing. Validates the token on the server, then shows the
 * accept form (read-only email, a password) or a friendly error. The accept
 * route re-validates the token, so this page-load check is purely for UX.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await lookupInvite(token);

  if (!result.ok) return <InviteUnavailable reason={result.reason} />;

  return <AcceptInvite token={token} email={result.email} hasAccount={result.hasAccount} />;
}
