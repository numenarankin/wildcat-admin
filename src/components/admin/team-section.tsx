"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UserPlusIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableHead } from "@/components/ui/table";
import {
  ConfirmModal,
  MODAL_CONTROL,
  SettingsChip,
  SettingsEmptyRow,
  SettingsField,
  SettingsMessage,
  SettingsPanel,
  SettingsRow,
  SettingsTable,
} from "@/components/settings/panel";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { useServerState } from "@/hooks/use-server-state";
import {
  cancelPlatformInvite,
  invitePlatformAdmin,
  removePlatformAdmin,
  resendPlatformInvite,
  setPlatformAdminPages,
} from "@/lib/admin/team-actions";
import type { TeamRow } from "@/lib/admin/team";
import {
  ADMIN_PAGE_KEYS,
  cleanPages,
  groupedAdminPages,
  pagesLabel,
  type AdminPageGroup,
  type AdminPageKey,
} from "@/lib/admin/pages";

/**
 * The admin team: the customer Settings' Members panel (`organization-section.tsx`
 * `MembersSection`), for the people who can open /admin. Invited by name +
 * email with the pages they may open; the invitee sets a password from the
 * emailed link and lands on the list (`invitePlatformAdmin`, `/invite/<token>`).
 * Only the seed admin invites, edits pages or removes, which is the database's
 * rule (migrations 2026091600100, 2026101300100) shown rather than a UI choice.
 */
export function TeamSection({ initialRows, canEdit }: { initialRows: TeamRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [rows, setRows] = useServerState<TeamRow[]>(initialRows);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<TeamRow | null>(null);

  /** Rethrows so the modal can show the reason and stay open. */
  async function invite(name: string, email: string, pages: AdminPageKey[]) {
    const normalized = email.trim().toLowerCase();
    setError(null);
    setNotice(null);
    const optimistic: TeamRow = {
      id: `temp-${normalized}`,
      status: "invited",
      email: normalized,
      name: name.trim(),
      pages,
      isSeed: false,
      addedAt: new Date().toISOString(),
      isMe: false,
      adminOnly: false,
    };
    setRows((prev) => [...prev, optimistic]);
    try {
      await invitePlatformAdmin(name, normalized, pages);
      setNotice(`Invite sent to ${normalized}.`);
      router.refresh();
    } catch (err) {
      setRows((prev) => prev.filter((r) => r.id !== optimistic.id));
      throw err instanceof Error ? err : new Error("Failed to invite.");
    }
  }

  function changePages(row: TeamRow, next: AdminPageKey[]) {
    const prev = rows;
    setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, pages: next } : r)));
    setError(null);
    startTransition(async () => {
      try {
        await setPlatformAdminPages(row.id, next);
        router.refresh();
      } catch (err) {
        setRows(prev);
        setError(err instanceof Error ? err.message : "Failed to update pages.");
      }
    });
  }

  function resend(row: TeamRow) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await resendPlatformInvite(row.id);
        setNotice(`Invite sent to ${row.email}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send.");
      }
    });
  }

  function cancel(row: TeamRow) {
    const prev = rows;
    setRows((cur) => cur.filter((r) => r.id !== row.id));
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await cancelPlatformInvite(row.id);
        router.refresh();
      } catch (err) {
        setRows(prev);
        setError(err instanceof Error ? err.message : "Failed to cancel.");
      }
    });
  }

  function remove(row: TeamRow) {
    const prev = rows;
    setRows((cur) => cur.filter((r) => r.id !== row.id));
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await removePlatformAdmin(row.id);
        router.refresh();
      } catch (err) {
        setRows(prev);
        setError(err instanceof Error ? err.message : "Failed to remove.");
      }
    });
  }

  return (
    <SettingsPanel
      action={
        canEdit ? (
          <Button size="lg" onClick={() => setAddOpen(true)}>
            <UserPlusIcon />
            Add admin
          </Button>
        ) : undefined
      }
    >
      <SettingsMessage error={error} notice={notice} />

      <SettingsTable
        head={
          <>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Pages</TableHead>
            <TableHead className="text-right">Manage</TableHead>
          </>
        }
      >
        {rows.length === 0 ? (
          <SettingsEmptyRow colSpan={5}>No admins yet.</SettingsEmptyRow>
        ) : (
          rows.map((row) => (
            <TeamMemberRow
              key={row.id}
              row={row}
              canEdit={canEdit}
              onPagesChange={changePages}
              onResend={resend}
              onCancelInvite={cancel}
              onConfirmRemove={setPendingRemoval}
            />
          ))
        )}
      </SettingsTable>

      <AddAdminModal open={addOpen} onClose={() => setAddOpen(false)} onInvite={invite} />

      <ConfirmModal
        open={pendingRemoval !== null}
        title="Remove this admin?"
        description={
          pendingRemoval?.adminOnly
            ? "Their admin-only account is deleted."
            : "Their WildcatIQ account is untouched."
        }
        body={
          <>
            <span className="font-medium text-foreground">{pendingRemoval?.email}</span> loses the
            admin side immediately. You can invite them again any time.
          </>
        }
        confirmLabel={`Remove ${pendingRemoval?.email ?? ""}`}
        onConfirm={() => {
          if (pendingRemoval) remove(pendingRemoval);
          setPendingRemoval(null);
        }}
        onClose={() => setPendingRemoval(null)}
      />
    </SettingsPanel>
  );
}

function TeamMemberRow({
  row,
  canEdit,
  onPagesChange,
  onResend,
  onCancelInvite,
  onConfirmRemove,
}: {
  row: TeamRow;
  canEdit: boolean;
  onPagesChange: (row: TeamRow, next: AdminPageKey[]) => void;
  onResend: (row: TeamRow) => void;
  onCancelInvite: (row: TeamRow) => void;
  onConfirmRemove: (row: TeamRow) => void;
}) {
  const displayName = row.name.trim() || row.email;
  const isOptimistic = row.id.startsWith("temp-");

  return (
    <SettingsRow>
      <TableCell className="font-medium">
        {displayName}
        {row.isMe ? <span className="ml-2 text-muted-foreground/50">(you)</span> : null}
      </TableCell>

      <TableCell className="text-muted-foreground">{row.email}</TableCell>

      <TableCell>
        {row.status === "invited" ? (
          <SettingsChip tone="amber">Pending</SettingsChip>
        ) : (
          <span className="text-muted-foreground/50">{row.isSeed ? "Seed admin" : "Active"}</span>
        )}
      </TableCell>

      <TableCell>
        {row.isSeed ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <ShieldCheckIcon className="size-4" />
            All pages
          </span>
        ) : canEdit ? (
          <PagesModal
            name={displayName}
            pages={row.pages}
            disabled={isOptimistic}
            onChange={(next) => onPagesChange(row, next)}
          />
        ) : (
          <span className="text-sm text-muted-foreground">{pagesLabel(row.pages)}</span>
        )}
      </TableCell>

      <TableCell className="text-right">
        {canEdit && !row.isSeed ? (
          <div className="flex justify-end gap-1">
            {row.status === "invited" ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={isOptimistic}
                  onClick={() => onResend(row)}
                  aria-label={`Resend invite to ${displayName}`}
                  title="Resend invite"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <RefreshCwIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={isOptimistic}
                  onClick={() => onCancelInvite(row)}
                  aria-label={`Cancel invite to ${displayName}`}
                  title="Cancel invite"
                  className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                >
                  <XIcon />
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onConfirmRemove(row)}
                aria-label={`Remove ${displayName}`}
                title={`Remove ${displayName}`}
                className="text-muted-foreground hover:text-destructive disabled:opacity-30"
              >
                <Trash2Icon />
              </Button>
            )}
          </div>
        ) : null}
      </TableCell>
    </SettingsRow>
  );
}

/** The Add admin modal: name, email, and the pages they may open. */
function AddAdminModal({
  open,
  onClose,
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  onInvite: (name: string, email: string, pages: AdminPageKey[]) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pages, setPages] = useState<AdminPageKey[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Reset when the modal (re)opens, in render like the other dialogs.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setEmail("");
      setPages([]);
      setError(null);
    }
  }

  // The invitee gets nothing until at least one page is granted.
  const granted = cleanPages(pages);
  const canInvite = Boolean(email.trim()) && granted.length > 0;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canInvite) return;
    setError(null);
    startTransition(async () => {
      try {
        await onInvite(name, email, granted);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to invite.");
      }
    });
  }

  return (
    <SwipeUpModal open={open} onClose={onClose} title="Add admin" className="max-w-xl">
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          <SettingsField label="Name">
            <Input
              className={MODAL_CONTROL}
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
            />
          </SettingsField>
          <SettingsField label="Email">
            <Input
              type="email"
              className={MODAL_CONTROL}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@wildcatiq.ai"
            />
          </SettingsField>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Pages</span>
            <PagesModal
              name={name.trim() || email.trim() || "this teammate"}
              pages={pages}
              triggerLabel="Set pages"
              triggerSize="default"
              triggerClassName={`w-fit ${MODAL_CONTROL}`}
              onChange={setPages}
            />
            {!granted.length && (
              <p className="text-sm text-muted-foreground">Grant at least one page before inviting.</p>
            )}
          </div>
          <SettingsMessage error={error} />
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={!canInvite || pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            <UserPlusIcon />
            Invite
          </Button>
        </div>
      </form>
    </SwipeUpModal>
  );
}

type GroupState = "on" | "off" | "partial";

/**
 * The pages picker: the customer app's `MemberPermissionsModal` with pages in
 * place of capabilities. One switch per page, grouped as the sidebar groups
 * them, with a switch per group that sets or clears the whole group, and
 * "All pages" at the top.
 */
function PagesModal({
  name,
  pages,
  disabled,
  triggerLabel,
  triggerSize = "sm",
  triggerClassName,
  onChange,
}: {
  name: string;
  pages: AdminPageKey[];
  disabled?: boolean;
  /** Override the trigger text (defaults to a summary of what's granted). */
  triggerLabel?: string;
  /** Match the trigger height to a sibling (e.g. "default" beside Invite). */
  triggerSize?: "sm" | "default";
  triggerClassName?: string;
  onChange: (next: AdminPageKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const granted = new Set(pages);
  const allOn = ADMIN_PAGE_KEYS.every((k) => granted.has(k));

  function toggle(key: AdminPageKey, checked: boolean) {
    const next = new Set(granted);
    if (checked) next.add(key);
    else next.delete(key);
    onChange(cleanPages([...next]));
  }

  function toggleMany(keys: AdminPageKey[], turnOn: boolean) {
    const next = new Set(granted);
    for (const key of keys) {
      if (turnOn) next.add(key);
      else next.delete(key);
    }
    onChange(cleanPages([...next]));
  }

  function groupState(keys: AdminPageKey[]): GroupState {
    const on = keys.filter((k) => granted.has(k)).length;
    if (on === 0) return "off";
    if (on === keys.length) return "on";
    return "partial";
  }

  const grouped = groupedAdminPages();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={triggerSize}
        className={cn("gap-1.5", triggerClassName)}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontalIcon className="size-3.5 opacity-70" />
        {triggerLabel ?? pagesLabel(pages)}
      </Button>

      <SwipeUpModal
        open={open}
        onClose={() => setOpen(false)}
        title="Pages"
        description={`Choose which pages ${name} can open.`}
        className="max-h-[80vh] max-w-xl"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
          <label className="flex items-start justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-sm font-medium">All pages</span>
              <span className="text-xs text-muted-foreground">Every page on the admin side, now and as more are added.</span>
            </span>
            <Switch
              checked={allOn}
              onCheckedChange={(on) => toggleMany([...ADMIN_PAGE_KEYS], on)}
              className="mt-0.5 shrink-0"
            />
          </label>

          {grouped.map(({ group, pages: defs }) => {
            const keys = defs.map((d) => d.key);
            const state = groupState(keys);
            return (
              <PageGroupBlock
                key={group}
                group={group}
                state={state}
                onToggle={(on) => toggleMany(keys, on)}
              >
                {defs.map((def) => (
                  <label key={def.key} className="flex items-start justify-between gap-3">
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{def.label}</span>
                      <span className="text-xs text-muted-foreground">{def.description}</span>
                    </span>
                    <Switch
                      checked={granted.has(def.key)}
                      onCheckedChange={(on) => toggle(def.key, on)}
                      className="mt-0.5 shrink-0"
                    />
                  </label>
                ))}
              </PageGroupBlock>
            );
          })}
        </div>

        <div className="flex justify-end border-t px-5 py-4">
          <Button type="button" size="lg" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </SwipeUpModal>
    </>
  );
}

function PageGroupBlock({
  group,
  state,
  onToggle,
  children,
}: {
  group: AdminPageGroup;
  state: GroupState;
  onToggle: (turnOn: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {group}
          {state === "partial" && <SettingsChip tone="amber">Partial</SettingsChip>}
        </span>
        <Switch checked={state !== "off"} onCheckedChange={onToggle} className="shrink-0" />
      </label>
      <div className="flex flex-col gap-3 border-l pl-4">{children}</div>
    </div>
  );
}
