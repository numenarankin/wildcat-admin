"use client";

import { useState } from "react";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { OrgPicker } from "@/components/orgs/org-picker";
import { enterOrg } from "@/lib/auth/orgs";
import { enterWorkspace } from "@/components/orgs/enter-workspace";
import type { OrgOption } from "@/lib/auth/org-types";

/**
 * Switch workspace, from the account menu.
 *
 * The same list as the sign-in picker, in the platform's modal. Choosing a
 * workspace reloads the app at the root rather than refreshing in place: the
 * sidebar, the credits, the notification feed, the AI context and every open
 * realtime channel were all built for the org being left.
 */
export function SwitchOrgModal({
  open,
  onClose,
  orgs,
  currentOrgId,
  /** Injected by the dev harness; production uses the real server action. */
  onEnter = enterOrg,
  /** What follows a successful switch. Overridden by the harness. */
  onEntered = enterWorkspace,
}: {
  open: boolean;
  onClose: () => void;
  orgs: OrgOption[];
  currentOrgId: string | null;
  onEnter?: (orgId: string) => Promise<void>;
  onEntered?: () => void;
}) {
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function select(org: OrgOption) {
    if (org.id === currentOrgId) {
      onClose();
      return;
    }
    setBusyOrgId(org.id);
    setError(null);
    try {
      await onEnter(org.id);
      onEntered();
    } catch (err) {
      setBusyOrgId(null);
      setError(err instanceof Error ? err.message : "Couldn't open that one.");
    }
  }

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      title="Switch workspace"
      className="max-w-lg"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-5">
        <OrgPicker
          orgs={orgs}
          currentOrgId={currentOrgId}
          busyOrgId={busyOrgId}
          onSelect={select}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </SwipeUpModal>
  );
}
