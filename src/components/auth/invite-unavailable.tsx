/** Why an invite link can't be used, as `lookupInvite` reports it. */
export type InviteUnavailableReason = "invalid" | "expired" | "unavailable";

const ERRORS: Record<InviteUnavailableReason, string> = {
  invalid: "This invite link is invalid or has already been used.",
  expired: "This invite has expired. Ask the admin who sent it for a new one.",
  unavailable: "We couldn't validate your invite right now. Please try again.",
};

/** The invite landing when the link can't be used. */
export function InviteUnavailable({ reason }: { reason: InviteUnavailableReason }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-[0.15rem] border bg-card p-6 text-center">
        <h1 className="text-lg font-semibold">Invite unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{ERRORS[reason]}</p>
      </div>
    </div>
  );
}
