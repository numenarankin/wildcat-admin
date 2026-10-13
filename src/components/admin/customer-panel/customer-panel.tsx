"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon } from "lucide-react";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { SettingsMessage } from "@/components/settings/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { loadCustomerBilling, loadCustomerPanel } from "@/lib/admin/customer-panel";
import type { CustomerBillingData, CustomerPanelData } from "@/lib/admin/customer-panel-types";
import type { RunAction } from "@/components/admin/customer-panel/panel-ui";
import { OverviewTab } from "@/components/admin/customer-panel/overview-tab";
import { BillingTab } from "@/components/admin/customer-panel/billing-tab";
import { UsageTab } from "@/components/admin/customer-panel/usage-tab";
import { MembersTab } from "@/components/admin/customer-panel/members-tab";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { customerPanelFacts, customerPanelSlice } from "@/lib/ai/admin/page-slices";

/**
 * The customer control panel: one org, opened by clicking its name in any
 * admin table (`CustomerName`). One instance lives in the /admin layout
 * (`CustomerPanelProvider`), so every table opens the same panel and none has
 * to mount its own.
 *
 * Four tabs over two reads. `loadCustomerPanel` is the database (org,
 * subscription row, credits, facilities and their entries, members);
 * `loadCustomerBilling` is Stripe, live, because pause, discounts, invoices
 * and refunds are not mirrored into our tables. Both start when the panel
 * opens, and every write reloads both, so what a tab shows after a click is
 * what the systems now say rather than what the click hoped for.
 *
 * Same frame as the flow map's `FacilityDetailModal` (SwipeUpModal, the tab
 * strip under the title), sized to most of the screen.
 */

type Tab = "overview" | "billing" | "usage" | "members";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "billing", label: "Billing" },
  { id: "usage", label: "Usage" },
  { id: "members", label: "Members" },
];

interface Target {
  orgId: string;
  name: string;
}

const OpenPanel = createContext<(target: Target) => void>(() => {});

/** Mount once, around the admin pages; renders the one panel. */
export function CustomerPanelProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const close = useCallback(() => setTarget(null), []);
  return (
    <OpenPanel.Provider value={setTarget}>
      {children}
      <CustomerPanelModal target={target} onClose={close} />
    </OpenPanel.Provider>
  );
}

/** A customer's name that opens their panel. Use it wherever a table names one. */
export function CustomerName({ orgId, name, className }: Target & { className?: string }) {
  const open = useContext(OpenPanel);
  return (
    <button
      type="button"
      onClick={() => open({ orgId, name })}
      className={cn(
        "cursor-pointer text-left font-medium underline-offset-4 transition-colors hover:underline",
        className
      )}
    >
      {name}
    </button>
  );
}

function CustomerPanelModal({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const router = useRouter();
  const orgId = target?.orgId ?? null;
  const [tab, setTab] = useState<Tab>("overview");
  const [panel, setPanel] = useState<CustomerPanelData | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [billing, setBilling] = useState<CustomerBillingData | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-seed on each open (render-time pattern, as `FacilityDetailModal` does).
  const [shownId, setShownId] = useState<string | null>(orgId);
  if (orgId !== shownId) {
    setShownId(orgId);
    setTab("overview");
    setPanel(null);
    setPanelError(null);
    setBilling(null);
    setBillingError(null);
    setNotice(null);
    setError(null);
  }

  const reload = useCallback(async (id: string) => {
    await Promise.all([
      loadCustomerPanel(id).then(
        (data) => {
          setPanel(data);
          setPanelError(null);
        },
        (err: unknown) => setPanelError(err instanceof Error ? err.message : "Could not load this customer.")
      ),
      loadCustomerBilling(id).then(
        (data) => {
          setBilling(data);
          setBillingError(null);
        },
        (err: unknown) => setBillingError(err instanceof Error ? err.message : "Could not reach Stripe.")
      ),
    ]);
  }, []);

  useEffect(() => {
    if (orgId) void reload(orgId);
  }, [orgId, reload]);

  // The open customer is what "this customer" means to the Orion drawer.
  usePageContextSlice(
    "admin-customer-panel",
    target
      ? customerPanelSlice({
          orgId: target.orgId,
          name: target.name,
          tab: TABS.find((t) => t.id === tab)?.label ?? tab,
          facts: customerPanelFacts(panel, billing),
        })
      : null
  );

  const run: RunAction = useCallback(
    async (work, done) => {
      if (!orgId) return false;
      setNotice(null);
      setError(null);
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? "That did not work.");
        return false;
      }
      setNotice(done);
      await reload(orgId);
      router.refresh();
      return true;
    },
    [orgId, reload, router]
  );

  return (
    <SwipeUpModal
      open={target != null}
      onClose={onClose}
      title={target?.name ?? "Customer"}
      headerAction={
        billing?.dashboardUrl ? (
          <a
            href={billing.dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in Stripe"
            title="Open in Stripe"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ExternalLinkIcon className="size-4" />
          </a>
        ) : null
      }
      className="h-[90vh] max-w-[min(92vw,96rem)]"
    >
      {target && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-stretch gap-1 border-b px-5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex h-12 cursor-pointer items-center border-b-2 px-3 text-base transition-colors",
                  tab === t.id
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
            <div className="ml-auto flex items-center">
              <SettingsMessage error={error} notice={notice} />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
            {panelError ? (
              <SettingsMessage error={panelError} />
            ) : !panel ? (
              <PanelSkeleton />
            ) : tab === "overview" ? (
              <OverviewTab panel={panel} billing={billing} run={run} />
            ) : tab === "billing" ? (
              <BillingTab panel={panel} billing={billing} billingError={billingError} run={run} />
            ) : tab === "usage" ? (
              <UsageTab panel={panel} run={run} />
            ) : (
              <MembersTab panel={panel} run={run} />
            )}
          </div>
        </div>
      )}
    </SwipeUpModal>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[4.5rem] rounded-[0.15rem]" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-[0.15rem]" />
    </div>
  );
}
