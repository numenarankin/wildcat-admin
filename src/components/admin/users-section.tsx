"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableHead } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MODAL_CONTROL,
  SettingsEmptyRow,
  SettingsField,
  SettingsMessage,
  SettingsPanel,
  SettingsRow,
  SettingsTable,
  SettingsTabs,
} from "@/components/settings/panel";
import { RowActions } from "@/components/row-actions";
import { CustomerName } from "@/components/admin/customer-panel/customer-panel";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { useServerState } from "@/hooks/use-server-state";
import { setAccountType } from "@/lib/admin/account-actions";
import type { AccountRow, AccountType } from "@/lib/admin/accounts";

type Label = Exclude<AccountType, "customer">;
type Tab = "all" | Label;

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "all", label: "All" },
  { id: "demo", label: "Demo" },
  { id: "test", label: "Test" },
];

const LABELS: ReadonlyArray<{ id: Label; label: string }> = [
  { id: "demo", label: "Mark as demo" },
  { id: "test", label: "Mark as test" },
];

const TYPE_LABEL: Record<AccountType, string> = { customer: "Customer", demo: "Demo", test: "Test" };

// Fixed zone for the same reason as the customers table: this server-renders.
const dayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });

/**
 * Which accounts are demo and which are test. An account on either list is
 * left out of every figure on the admin dashboard; removing it from the list
 * makes it a customer again. Same panel as the Members tab. The All tab is
 * every account with a hover menu to mark it demo or test; the Demo and Test
 * tabs also take an account from the customers by name.
 */
export function UsersSection({ initialAccounts }: { initialAccounts: AccountRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [accounts, setAccounts] = useServerState<AccountRow[]>(initialAccounts);
  const [tab, setTab] = useState<Tab>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listed = tab === "all" ? accounts : accounts.filter((a) => a.accountType === tab);
  const customers = accounts.filter((a) => a.accountType === "customer");

  function relabel(orgId: string, type: AccountType, onFail: () => void) {
    setAccounts((prev) => prev.map((a) => (a.orgId === orgId ? { ...a, accountType: type } : a)));
    setError(null);
    startTransition(async () => {
      try {
        await setAccountType(orgId, type);
        router.refresh();
      } catch (err) {
        onFail();
        setError(err instanceof Error ? err.message : "Failed to update.");
      }
    });
  }

  /** Rethrows so the modal can show the reason and stay open. */
  async function add(orgId: string) {
    if (tab === "all") return;
    setError(null);
    await setAccountType(orgId, tab);
    setAccounts((prev) => prev.map((a) => (a.orgId === orgId ? { ...a, accountType: tab } : a)));
    router.refresh();
  }

  function mark(row: AccountRow, type: Label) {
    const prev = accounts;
    relabel(row.orgId, type, () => setAccounts(prev));
  }

  function remove(row: AccountRow) {
    const prev = accounts;
    relabel(row.orgId, "customer", () => setAccounts(prev));
  }

  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? "";

  return (
    <SettingsPanel
      tabs={<SettingsTabs tabs={TABS} value={tab} onChange={setTab} />}
      action={
        tab === "all" ? undefined : (
          <Button size="lg" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            Add account
          </Button>
        )
      }
    >
      <SettingsMessage error={error} />

      <SettingsTable
        head={
          <>
            <TableHead>Company</TableHead>
            <TableHead>Email</TableHead>
            {tab === "all" ? <TableHead>Type</TableHead> : null}
            <TableHead>Signed up</TableHead>
            <TableHead className="text-right">Manage</TableHead>
          </>
        }
      >
        {listed.length === 0 ? (
          <SettingsEmptyRow colSpan={tab === "all" ? 5 : 4}>
            {tab === "all" ? "No accounts." : `No ${tabLabel.toLowerCase()} accounts.`}
          </SettingsEmptyRow>
        ) : (
          listed.map((row) => (
            <SettingsRow key={row.orgId} className="group">
              <TableCell>
                <CustomerName orgId={row.orgId} name={row.name} />
              </TableCell>
              <TableCell className="text-muted-foreground">{row.email ?? "—"}</TableCell>
              {tab === "all" ? (
                <TableCell className="text-muted-foreground">{TYPE_LABEL[row.accountType]}</TableCell>
              ) : null}
              <TableCell className="text-muted-foreground">
                {dayFormatter.format(new Date(row.createdAt))}
              </TableCell>
              <TableCell>
                {tab === "all" ? (
                  // Hover-revealed three-dot menu, the hauls table's treatment.
                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <button
                            type="button"
                            aria-label={`Actions for ${row.name}`}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 hover:bg-accent hover:text-foreground"
                          />
                        }
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {LABELS.filter((l) => l.id !== row.accountType).map((l) => (
                          <DropdownMenuItem
                            key={l.id}
                            className="cursor-pointer"
                            onClick={() => mark(row, l.id)}
                          >
                            {l.label}
                          </DropdownMenuItem>
                        ))}
                        {row.accountType !== "customer" ? (
                          <DropdownMenuItem className="cursor-pointer" onClick={() => remove(row)}>
                            Mark as customer
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : (
                  <RowActions
                    label={row.name}
                    deleteLabel={`Remove ${row.name} from ${tabLabel.toLowerCase()} accounts`}
                    onDelete={() => remove(row)}
                    className="justify-end"
                  />
                )}
              </TableCell>
            </SettingsRow>
          ))
        )}
      </SettingsTable>

      <AddAccountModal
        key={tab}
        open={addOpen && tab !== "all"}
        label={tabLabel}
        customers={customers}
        onClose={() => setAddOpen(false)}
        onAdd={add}
      />
    </SettingsPanel>
  );
}

function AddAccountModal({
  open,
  label,
  customers,
  onClose,
  onAdd,
}: {
  open: boolean;
  label: string;
  customers: AccountRow[];
  onClose: () => void;
  onAdd: (orgId: string) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [orgId, setOrgId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOrgId("");
      setError(null);
    }
  }

  const selected = customers.find((c) => c.orgId === orgId);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!orgId) return;
    setError(null);
    startTransition(async () => {
      try {
        await onAdd(orgId);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add.");
      }
    });
  }

  return (
    <SwipeUpModal open={open} onClose={onClose} title={`Add ${label.toLowerCase()} account`} className="max-w-xl">
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          <SettingsField label="Account">
            <Select value={orgId} onValueChange={(v) => setOrgId(v ?? "")}>
              <SelectTrigger className={`w-full ${MODAL_CONTROL}`}>
                <span className="truncate">
                  {selected ? `${selected.name}${selected.email ? ` · ${selected.email}` : ""}` : "Choose an account"}
                </span>
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.orgId} value={c.orgId}>
                    {c.name}
                    {c.email ? <span className="ml-2 text-muted-foreground">{c.email}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsField>
          <SettingsMessage error={error} />
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={!orgId || pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            <PlusIcon />
            Add
          </Button>
        </div>
      </form>
    </SwipeUpModal>
  );
}
