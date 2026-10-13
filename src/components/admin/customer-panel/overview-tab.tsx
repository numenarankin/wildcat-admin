"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { ConfirmModal, SettingsCard, SettingsSection } from "@/components/settings/panel";
import { Stat } from "@/components/admin/admin-summary-stats";
import { setAccountType } from "@/lib/admin/account-actions";
import { setSuspended } from "@/lib/admin/customer-actions";
import { ACCOUNT_TYPES, type AccountType } from "@/lib/admin/account-types";
import { annualRevenueUsd, customerStatus } from "@/lib/admin/customer-rows";
import { usageTotals } from "@/lib/admin/customer-usage";
import { tierByKey, UNLIMITED_WELLS } from "@/lib/billing/tiers";
import type { CustomerBillingData, CustomerPanelData } from "@/lib/admin/customer-panel-types";
import { Fact, count, fmtDate, fmtDateTime, statusLabel, usd, type RunAction } from "@/components/admin/customer-panel/panel-ui";

const CUSTOMER_STATUS: Record<ReturnType<typeof customerStatus>, string> = {
  paying: "Paying",
  trial: "Trial",
  paused: "Paused",
  onboarding: "Onboarding",
  canceled: "Canceled",
};

const TYPE_LABEL: Record<AccountType, string> = { customer: "Customer", demo: "Demo", test: "Test" };

/** The customer at a glance, and the two account-level switches. */
export function OverviewTab({
  panel,
  billing,
  run,
}: {
  panel: CustomerPanelData;
  billing: CustomerBillingData | null;
  run: RunAction;
}) {
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const sub = panel.subscription;
  const subInput = sub
    ? {
        status: sub.status,
        billingInterval: sub.interval,
        wellQuantity: sub.wellQuantity,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        stripeAnnualUsd: billing?.annualUsd ?? null,
        pausedNow: billing?.subscription?.pausedNow ?? false,
      }
    : null;
  const status = customerStatus(subInput, panel.onboardingCompletedAt);
  const totals = usageTotals(panel);
  const tier = sub ? tierByKey(sub.tier) : null;
  const suspended = Boolean(sub?.suspendedAt);

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Status" value={suspended ? "Suspended" : CUSTOMER_STATUS[status]} />
        <Stat label="Revenue /yr" value={billing ? usd.format(annualRevenueUsd(subInput)) : "—"} />
        <Stat
          label="Plan"
          value={tier ? `${tier.label} · ${sub?.interval === "year" ? "Annual" : "Monthly"}` : "—"}
        />
        <Stat
          label="Wells"
          value={
            sub && sub.wellCap > 0 && sub.wellCap < UNLIMITED_WELLS
              ? `${count.format(panel.billableWells)} / ${count.format(sub.wellCap)}`
              : count.format(panel.billableWells)
          }
        />
        <Stat label="Facilities" value={count.format(totals.facilities.total)} />
        <Stat label="Entries (30d)" value={count.format(totals.entriesRecent)} />
        <Stat label="People" value={count.format(totals.activeMembers)} />
        <Stat
          label="AI credits"
          value={count.format(panel.credits.freeRemaining + panel.credits.paidBalance)}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsSection title="Account">
          <SettingsCard className="py-1">
            <dl>
              <Fact label="Owner">{panel.ownerEmail ?? "—"}</Fact>
              <Fact label="Signed up">{fmtDateTime(panel.createdAt)}</Fact>
              <Fact label="Finished onboarding">{fmtDateTime(panel.onboardingCompletedAt)}</Fact>
              <Fact label="Referred by">{panel.referredBy?.name ?? "—"}</Fact>
              <Fact label="Referrals">{count.format(panel.referrals)}</Fact>
              <Fact label="Subscription">{statusLabel(billing?.subscription?.status ?? sub?.status)}</Fact>
              <Fact label="Trial ends">{fmtDate(billing?.subscription?.trialEnd ?? sub?.trialEnd)}</Fact>
              <Fact label="Period ends">
                {fmtDate(billing?.subscription?.currentPeriodEnd ?? sub?.currentPeriodEnd)}
              </Fact>
              <Fact label="Stripe customer">
                <span className="font-mono text-xs">{sub?.stripeCustomerId ?? "—"}</span>
              </Fact>
            </dl>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Controls">
          <SettingsCard className="py-1">
            <div className="flex items-center justify-between gap-4 border-b py-2.5">
              <span className="text-sm text-muted-foreground">Account type</span>
              <Select
                value={panel.accountType}
                onValueChange={(v) => {
                  const next = v as AccountType;
                  if (next === panel.accountType) return;
                  void run(async () => {
                    try {
                      await setAccountType(panel.orgId, next);
                      return { ok: true };
                    } catch (err) {
                      return { ok: false, error: err instanceof Error ? err.message : "Failed to update." };
                    }
                  }, `Marked as ${TYPE_LABEL[next].toLowerCase()}.`);
                }}
              >
                <SelectTrigger className="h-9 w-36 shrink-0">
                  <span>{TYPE_LABEL[panel.accountType]}</span>
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4 py-2.5">
              <span className="text-sm text-muted-foreground">
                {suspended ? `Suspended ${fmtDateTime(sub?.suspendedAt)}` : "Access"}
              </span>
              <Button
                type="button"
                variant={suspended ? "default" : "destructive"}
                className="w-36 shrink-0"
                disabled={!sub}
                onClick={() => setConfirmSuspend(true)}
              >
                {suspended ? "Lift suspension" : "Suspend"}
              </Button>
            </div>
          </SettingsCard>
        </SettingsSection>
      </div>

      <ConfirmModal
        open={confirmSuspend}
        elevated
        title={suspended ? `Lift ${panel.name}'s suspension?` : `Suspend ${panel.name}?`}
        description={suspended ? "Their access returns on their next page load." : "Their data is kept."}
        body={
          suspended
            ? "Everyone in this workspace can use the app and the phone again."
            : "Everyone in this workspace is shown a suspended notice in the app, the phone stops syncing, and AI calls are refused, until the suspension is lifted. Billing carries on as it is."
        }
        confirmLabel={suspended ? "Lift suspension" : "Suspend"}
        onClose={() => setConfirmSuspend(false)}
        onConfirm={() => {
          setConfirmSuspend(false);
          void run(() => setSuspended(panel.orgId, !suspended), suspended ? "Suspension lifted." : "Suspended.");
        }}
      />
    </>
  );
}
