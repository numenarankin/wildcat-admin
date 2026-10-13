"use client";

import { BuildingIcon, CheckIcon } from "lucide-react";
import { Spokes } from "@/components/ui/spokes";
import { cn } from "@/lib/utils";
import type { OrgOption } from "@/lib/auth/org-types";

/**
 * The list of workspaces a user can enter, as a stack of large rows.
 *
 * Presentational on purpose: the sign-in picker (`/select-org`) and the switcher
 * in the account menu are the same list in two frames, and the frames own the
 * write. That also makes it renderable in the dev harness with no backend.
 *
 * Rows are buttons, not links. Entering a workspace is a write (it moves the
 * user's active org), and the navigation that follows is a full page load.
 */
export function OrgPicker({
  orgs,
  currentOrgId = null,
  busyOrgId = null,
  onSelect,
}: {
  orgs: OrgOption[];
  /** The workspace they are in now, marked as such. */
  currentOrgId?: string | null;
  /** The row that was clicked, while its write is in flight. */
  busyOrgId?: string | null;
  onSelect: (org: OrgOption) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {orgs.map((org) => {
        const current = org.id === currentOrgId;
        const busy = org.id === busyOrgId;
        return (
          <button
            key={org.id}
            type="button"
            disabled={busyOrgId !== null}
            onClick={() => onSelect(org)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-3 rounded-[0.15rem] border px-4 py-3.5 text-left transition-colors",
              "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              busyOrgId !== null && !busy && "opacity-50",
              current && "border-foreground/40 bg-muted/40"
            )}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[0.15rem] border bg-background">
              <BuildingIcon className="size-4 text-muted-foreground" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{org.name}</span>
              <span className="block text-xs text-muted-foreground">
                {org.isOwner ? "Owner" : "Member"}
              </span>
            </span>
            {busy ? (
              <Spokes className="size-4 shrink-0 text-muted-foreground" />
            ) : current ? (
              <CheckIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
