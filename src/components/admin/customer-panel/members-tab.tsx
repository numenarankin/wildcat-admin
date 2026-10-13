"use client";

import { useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmModal, SettingsChip } from "@/components/settings/panel";
import { Stat } from "@/components/admin/admin-summary-stats";
import { sendMemberPasswordReset, setMemberRemoved } from "@/lib/admin/customer-actions";
import { RECENT_WINDOW_DAYS, unlistedEntries, usageTotals } from "@/lib/admin/customer-usage";
import type { CustomerPanelData, PanelMember } from "@/lib/admin/customer-panel-types";
import {
  SortHead,
  TABLE_HEAD_CLASS,
  count,
  fmtDateTime,
  fmtDay,
  useSort,
  type RunAction,
} from "@/components/admin/customer-panel/panel-ui";

type SortKey = "name" | "email" | "status" | "signIn" | "phone" | "entries";

const STATUS_LABEL: Record<PanelMember["status"], string> = {
  active: "Active",
  invited: "Invited",
  removed: "Removed",
};

const PLATFORM_LABEL: Record<string, string> = { ios: "iOS", android: "Android" };

/** Who is in the workspace, how they use it, and the account fixes staff do for them. */
export function MembersTab({ panel, run }: { panel: CustomerPanelData; run: RunAction }) {
  const totals = usageTotals(panel);
  const sort = useSort<SortKey>("entries");
  const [removing, setRemoving] = useState<PanelMember | null>(null);
  const other = unlistedEntries(panel);

  const rows = sort.sort(panel.members, (m, key) => {
    switch (key) {
      case "name":
        return m.name;
      case "email":
        return m.email;
      case "status":
        return m.status;
      case "signIn":
        return m.lastSignInAt ? Date.parse(m.lastSignInAt) : null;
      case "phone":
        return m.phoneLastSeenAt ? Date.parse(m.phoneLastSeenAt) : null;
      default:
        return m.entries;
    }
  });

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="People with accounts" value={count.format(totals.activeMembers)} />
        <Stat label="Pending invites" value={count.format(totals.invitedMembers)} />
        <Stat label={`On the phone (${RECENT_WINDOW_DAYS}d)`} value={count.format(totals.phoneUsersRecent)} />
        <Stat
          label="Phones registered"
          value={count.format(panel.members.reduce((n, m) => n + m.devices.length, 0))}
        />
      </div>

      <div className="rounded-[0.15rem] border">
        <Table className="text-[0.95rem]">
          <TableHeader className={TABLE_HEAD_CLASS}>
            <TableRow className="hover:bg-muted">
              <SortHead column="name" label="Name" sort={sort} />
              <SortHead column="email" label="Email" sort={sort} />
              <SortHead column="status" label="Status" sort={sort} />
              <SortHead column="signIn" label="Last sign-in" numeric sort={sort} />
              <SortHead column="phone" label="Phone last seen" numeric sort={sort} />
              <TableHead>Phones</TableHead>
              <SortHead column="entries" label={`Entries (${RECENT_WINDOW_DAYS}d)`} numeric sort={sort} />
              <TableHead className="text-right">Last entry</TableHead>
              <TableHead className="text-right">Manage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.memberId ?? m.authUserId ?? m.name} className="group [&>td]:py-3">
                <TableCell className="font-medium">
                  <span className="inline-flex items-center gap-2">
                    {m.name}
                    {m.isOwner ? <SettingsChip tone="primary">Owner</SettingsChip> : m.isAdmin ? <SettingsChip>Admin</SettingsChip> : null}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{m.email ?? "—"}</TableCell>
                <TableCell>{STATUS_LABEL[m.status]}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtDateTime(m.lastSignInAt)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtDateTime(m.phoneLastSeenAt)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {m.devices.length
                    ? m.devices
                        .map((d) => d.name || PLATFORM_LABEL[d.platform] || d.platform)
                        .join(", ")
                    : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{count.format(m.entries)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtDay(m.lastEntry)}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    {m.authUserId || (m.memberId && !m.isOwner) ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`Actions for ${m.name}`}
                              className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 hover:bg-accent hover:text-foreground"
                            />
                          }
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {m.authUserId && m.status !== "removed" ? (
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onClick={() =>
                                void run(
                                  () => sendMemberPasswordReset(panel.orgId, m.authUserId!),
                                  `Password reset sent to ${m.email ?? m.name}.`
                                )
                              }
                            >
                              Send password reset
                            </DropdownMenuItem>
                          ) : null}
                          {m.memberId && !m.isOwner ? (
                            m.status === "removed" ? (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() =>
                                  void run(() => setMemberRemoved(panel.orgId, m.memberId!, false), `${m.name} restored.`)
                                }
                              >
                                Restore
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem className="cursor-pointer" onClick={() => setRemoving(m)}>
                                Remove from workspace
                              </DropdownMenuItem>
                            )
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {other > 0 && (
              <TableRow className="[&>td]:py-3">
                <TableCell className="text-muted-foreground">Imports and others</TableCell>
                <TableCell colSpan={5} />
                <TableCell className="text-right tabular-nums">{count.format(other)}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <ConfirmModal
        open={removing !== null}
        elevated
        title={`Remove ${removing?.name ?? ""}?`}
        description="Nothing they entered is deleted."
        body={`${removing?.name ?? "They"} loses access to ${panel.name} on their next page load. Their readings, notes and history stay, and they can be restored from this menu.`}
        confirmLabel="Remove from workspace"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const m = removing;
          setRemoving(null);
          if (m?.memberId) void run(() => setMemberRemoved(panel.orgId, m.memberId!, true), `${m.name} removed.`);
        }}
      />
    </>
  );
}
