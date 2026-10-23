"use client";

import { useState, type ReactNode } from "react";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ConfirmModal,
  SettingsCard,
  SettingsField,
  SettingsMessage,
  SettingsSection,
} from "@/components/settings/panel";
import { Stat } from "@/components/admin/admin-summary-stats";
import {
  applyDiscount,
  cancelNow,
  changeBand,
  extendTrial,
  adjustPlatformCredit,
  pauseCollection,
  refundInvoice,
  removeDiscounts,
  resumeCollection,
  setCancelAtPeriodEnd,
  setWellCap,
  switchCustomerToAnnual,
  type DiscountDuration,
} from "@/lib/admin/customer-actions";
import { TIERS, UNLIMITED_WELLS, billableQuantity, priceUsdForWells, tierByKey } from "@/lib/billing/tiers";
import type {
  ActionResult,
  CustomerBillingData,
  CustomerPanelData,
  PanelInvoice,
} from "@/lib/admin/customer-panel-types";
import {
  TABLE_HEAD_CLASS,
  count,
  fmtDate,
  statusLabel,
  usd,
  usdCents,
  type RunAction,
} from "@/components/admin/customer-panel/panel-ui";

interface Pending {
  title: string;
  description: string;
  body: ReactNode;
  confirmLabel: string;
  requireText?: string;
  action: () => Promise<ActionResult>;
  done: string;
}

const DURATIONS: { id: DiscountDuration; label: string }[] = [
  { id: "once", label: "Next invoice" },
  { id: "repeating", label: "Months" },
  { id: "forever", label: "Forever" },
];

/** A label on the left, its control on the right: one line of a control card. */
function ControlRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function BillingTab({
  panel,
  billing,
  billingError,
  run,
}: {
  panel: CustomerPanelData;
  billing: CustomerBillingData | null;
  billingError: string | null;
  run: RunAction;
}) {
  const orgId = panel.orgId;
  const sub = panel.subscription;
  const live = billing?.subscription ?? null;
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const [trialEnd, setTrialEnd] = useState<Date | null>(null);
  const [band, setBand] = useState<string>(sub?.tier ?? "tier_1");
  const [cap, setCap] = useState<string>(sub && sub.wellCap < UNLIMITED_WELLS ? String(sub.wellCap) : "");
  const [percent, setPercent] = useState("");
  const [duration, setDuration] = useState<DiscountDuration>("once");
  const [months, setMonths] = useState("3");
  const [creditUsd, setCreditUsd] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [refunding, setRefunding] = useState<PanelInvoice | null>(null);
  const [refundUsd, setRefundUsd] = useState("");

  async function go(action: () => Promise<ActionResult>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      return await run(action, done);
    } finally {
      setBusy(false);
    }
  }

  function ask(p: Pending) {
    setPending(p);
  }

  const interval = sub?.interval ?? "month";
  const per = interval === "year" ? "/yr" : "/mo";
  const bandTier = tierByKey(band);
  const bandQuantity = billableQuantity(panel.billableWells, bandTier.key);
  const pricing = billing?.pricing ?? null;
  /** A quote from the Stripe prices, or nothing when they could not be read. */
  const quote = (wells: number, on: "month" | "year") =>
    pricing ? `${usd.format(priceUsdForWells(wells, on, pricing))}${on === "year" ? "/yr" : "/mo"}` : null;
  const stripeReady = billing !== null;
  const hasStripeSub = Boolean(live);

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Subscription" value={statusLabel(live?.status ?? sub?.status)} />
        <Stat label="Charging" value={!live ? "—" : live.paused ? "Paused" : "On"} />
        <Stat
          label="Price"
          value={live ? `${usd.format(interval === "year" ? billing!.annualUsd : billing!.annualUsd / 12)}${per}` : "—"}
        />
        <Stat
          label="Card"
          value={
            billing?.card
              ? `${billing.card.brand.toUpperCase()} ${billing.card.last4} · ${String(billing.card.expMonth).padStart(2, "0")}/${String(billing.card.expYear).slice(-2)}`
              : "—"
          }
        />
        <Stat label="Discount" value={live?.discounts.map((d) => d.label).join(", ") || "—"} />
        <Stat label="Platform credit" value={usdCents.format(panel.credits.platformCents / 100)} />
      </div>

      {billingError && <SettingsMessage error={`Stripe: ${billingError}`} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsSection title="Subscription">
          <SettingsCard className="py-1">
            {!stripeReady && !billingError ? (
              <Skeleton className="my-3 h-24" />
            ) : !hasStripeSub ? (
              <ControlRow label="Stripe">No Stripe subscription</ControlRow>
            ) : (
              <>
                <ControlRow label={live!.paused ? "Charging is paused" : "Charging"}>
                  {live!.paused ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        ask({
                          title: `Resume charging ${panel.name}?`,
                          description: "Their next invoice is charged as normal.",
                          body: "Stripe starts charging their card again from the next invoice. Invoices voided while paused stay voided.",
                          confirmLabel: "Resume charging",
                          action: () => resumeCollection(orgId),
                          done: "Charging resumed.",
                        })
                      }
                    >
                      Resume charging
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        ask({
                          title: `Pause charging ${panel.name}?`,
                          description: "They keep full access.",
                          body: "Stripe keeps raising their invoices and voids each one, so nothing is charged until you resume. Their subscription stays active and the app keeps working.",
                          confirmLabel: "Pause charging",
                          action: () => pauseCollection(orgId),
                          done: "Charging paused.",
                        })
                      }
                    >
                      Pause charging
                    </Button>
                  )}
                </ControlRow>

                <ControlRow
                  label={
                    live!.cancelAtPeriodEnd
                      ? `Ends ${fmtDate(live!.currentPeriodEnd)}`
                      : "Cancellation"
                  }
                >
                  {live!.cancelAtPeriodEnd ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void go(() => setCancelAtPeriodEnd(orgId, false), "Cancellation withdrawn.")}
                    >
                      Keep subscription
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || live!.status === "canceled"}
                      onClick={() =>
                        ask({
                          title: `Cancel ${panel.name} at period end?`,
                          description: `Access continues until ${fmtDate(live!.currentPeriodEnd)}.`,
                          body: "Their subscription ends when the current period does, and they are not charged again. You can withdraw this until then.",
                          confirmLabel: "Cancel at period end",
                          action: () => setCancelAtPeriodEnd(orgId, true),
                          done: "Set to cancel at period end.",
                        })
                      }
                    >
                      Cancel at period end
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy || live!.status === "canceled"}
                    onClick={() =>
                      ask({
                        title: `Cancel ${panel.name} now?`,
                        description: "This cannot be undone.",
                        body: "The subscription ends immediately and the workspace locks. Their platform credit is forfeited, and an unvested referral reward is taken back. To return they start a new subscription.",
                        confirmLabel: "Cancel now",
                        requireText: panel.name,
                        action: () => cancelNow(orgId),
                        done: "Subscription canceled.",
                      })
                    }
                  >
                    Cancel now
                  </Button>
                </ControlRow>

                {live!.status === "trialing" && (
                  <ControlRow label={`Trial ends ${fmtDate(live!.trialEnd)}`}>
                    <DatePicker
                      value={trialEnd}
                      onChange={setTrialEnd}
                      placeholder="New end"
                      className="h-9"
                      disabled={(d) => d.getTime() <= Date.now()}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || !trialEnd}
                      onClick={() => {
                        if (!trialEnd) return;
                        const day = `${trialEnd.getFullYear()}-${String(trialEnd.getMonth() + 1).padStart(2, "0")}-${String(trialEnd.getDate()).padStart(2, "0")}`;
                        void go(() => extendTrial(orgId, day), "Trial extended.").then((ok) => ok && setTrialEnd(null));
                      }}
                    >
                      Extend trial
                    </Button>
                  </ControlRow>
                )}
              </>
            )}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Plan">
          <SettingsCard className="py-1">
            <ControlRow label="Band">
              <Select value={band} onValueChange={(v) => setBand(v ?? band)}>
                <SelectTrigger className="h-9 w-44">
                  <span>{bandTier.label}</span>
                </SelectTrigger>
                <SelectContent>
                  {TIERS.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.label}
                      <span className="ml-2 text-muted-foreground">
                        {t.maxWells === null ? `${t.minWells}+ wells` : `${t.minWells}–${t.maxWells} wells`}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !sub || band === sub.tier}
                onClick={() =>
                  ask({
                    title: `Move ${panel.name} to ${bandTier.label}?`,
                    description: [quote(bandQuantity, interval), `${count.format(bandQuantity)} billed wells`]
                      .filter(Boolean)
                      .join(" at "),
                    body:
                      bandTier.minWells > tierByKey(sub?.tier).minWells
                        ? "The well cap and monthly AI credits change now. The price difference is prorated onto their next invoice."
                        : "The well cap and monthly AI credits change now. The lower price starts on their next invoice; nothing is credited for this period.",
                    confirmLabel: `Move to ${bandTier.label}`,
                    action: () => changeBand(orgId, band),
                    done: `Moved to ${bandTier.label}.`,
                  })
                }
              >
                Change band
              </Button>
            </ControlRow>

            <ControlRow label="Billing">
              {interval === "year" ? (
                <span className="text-sm font-medium">Annual</span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !sub?.stripeSubscriptionId}
                  onClick={() =>
                    ask({
                      title: `Switch ${panel.name} to annual?`,
                      description: quote(sub?.wellQuantity ?? 1, "year") ?? "Billed yearly.",
                      body:
                        live?.status === "trialing"
                          ? "The trial is left alone; the first invoice at trial end is the annual one."
                          : "The annual term starts today. They are invoiced now for the year, less the unused part of this month.",
                      confirmLabel: "Switch to annual",
                      action: () => switchCustomerToAnnual(orgId),
                      done: "Switched to annual.",
                    })
                  }
                >
                  Switch to annual
                </Button>
              )}
            </ControlRow>

            <ControlRow label="Well cap">
              <Input
                type="number"
                min={1}
                value={cap}
                placeholder={sub && sub.wellCap >= UNLIMITED_WELLS ? "Unlimited" : undefined}
                onChange={(e) => setCap(e.target.value)}
                className="h-9 w-28"
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || !sub || !cap || Number(cap) === sub.wellCap}
                onClick={() => void go(() => setWellCap(orgId, Number(cap)), "Well cap saved.")}
              >
                Save
              </Button>
            </ControlRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Discount">
          <SettingsCard className="py-1">
            {live?.discounts.length ? (
              <ControlRow label={live.discounts.map((d) => d.label).join(", ")}>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    ask({
                      title: `Remove ${panel.name}'s discount?`,
                      description: "Their next invoice is at full price.",
                      body: "The discount comes off the subscription now. Invoices already raised keep it.",
                      confirmLabel: "Remove discount",
                      action: () => removeDiscounts(orgId),
                      done: "Discount removed.",
                    })
                  }
                >
                  Remove
                </Button>
              </ControlRow>
            ) : null}
            <div className="flex flex-wrap items-end gap-3 py-3">
              <SettingsField label="Percent off">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  className="h-9 w-28"
                />
              </SettingsField>
              <SettingsField label="For">
                <Select value={duration} onValueChange={(v) => setDuration((v as DiscountDuration) ?? "once")}>
                  <SelectTrigger className="h-9 w-36">
                    <span>{DURATIONS.find((d) => d.id === duration)?.label}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
              {duration === "repeating" && (
                <SettingsField label="Months">
                  <Input
                    type="number"
                    min={1}
                    value={months}
                    onChange={(e) => setMonths(e.target.value)}
                    className="h-9 w-24"
                  />
                </SettingsField>
              )}
              <Button
                type="button"
                variant="outline"
                className="ml-auto"
                disabled={busy || !hasStripeSub || !percent}
                onClick={() =>
                  void go(
                    () => applyDiscount(orgId, Number(percent), duration, duration === "repeating" ? Number(months) : undefined),
                    "Discount applied."
                  ).then((ok) => ok && setPercent(""))
                }
              >
                {live?.discounts.length ? "Replace discount" : "Apply discount"}
              </Button>
            </div>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Platform credit">
          <SettingsCard className="py-1">
            <div className="flex flex-wrap items-end gap-3 py-3">
              <SettingsField label="Amount (USD)">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={creditUsd}
                  onChange={(e) => setCreditUsd(e.target.value)}
                  className="h-9 w-32"
                />
              </SettingsField>
              <SettingsField label="Reason" className="min-w-48 flex-1">
                <Input value={creditReason} onChange={(e) => setCreditReason(e.target.value)} className="h-9" />
              </SettingsField>
              {([1, -1] as const).map((sign) => (
                <Button
                  key={sign}
                  type="button"
                  variant="outline"
                  disabled={busy || !(Number(creditUsd) > 0) || !creditReason.trim()}
                  onClick={() =>
                    void go(
                      () => adjustPlatformCredit(orgId, sign * Number(creditUsd), creditReason),
                      `${usdCents.format(Number(creditUsd))} credit ${sign > 0 ? "added" : "removed"}.`
                    ).then((ok) => {
                      if (ok) {
                        setCreditUsd("");
                        setCreditReason("");
                      }
                    })
                  }
                >
                  {sign > 0 ? "Add credit" : "Remove credit"}
                </Button>
              ))}
            </div>
          </SettingsCard>
        </SettingsSection>
      </div>

      <SettingsSection title="Invoices">
        <div className="rounded-[0.15rem] border">
          <Table className="text-[0.95rem]">
            <TableHeader className={TABLE_HEAD_CLASS}>
              <TableRow className="hover:bg-muted">
                <TableHead>Date</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>For</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Refunded</TableHead>
                <TableHead className="text-right">Manage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!stripeReady && !billingError ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-20 text-center text-muted-foreground">
                    <Loader2Icon className="mx-auto size-4 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : !billing?.invoices.length ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-20 text-center text-muted-foreground">
                    No invoices.
                  </TableCell>
                </TableRow>
              ) : (
                billing.invoices.map((inv) => {
                  const refundable = inv.amountPaidCents - inv.amountRefundedCents;
                  return (
                    <TableRow key={inv.id} className="[&>td]:py-3">
                      <TableCell>{fmtDate(inv.createdAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{inv.number ?? "—"}</TableCell>
                      <TableCell>{inv.topUp ? "AI credits" : "Subscription"}</TableCell>
                      <TableCell>{inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usdCents.format(inv.totalCents / 100)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usdCents.format(inv.amountPaidCents / 100)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {inv.amountRefundedCents ? usdCents.format(inv.amountRefundedCents / 100) : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {inv.hostedUrl && (
                            <a
                              href={inv.hostedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Open invoice"
                              className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                            >
                              <ExternalLinkIcon className="size-4" />
                            </a>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy || refundable <= 0}
                            onClick={() => {
                              setRefundUsd((refundable / 100).toFixed(2));
                              setRefunding(inv);
                            }}
                          >
                            Refund
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </SettingsSection>

      <ConfirmModal
        open={pending !== null}
        elevated
        title={pending?.title ?? ""}
        description={pending?.description ?? ""}
        body={pending?.body ?? ""}
        confirmLabel={pending?.confirmLabel ?? "Confirm"}
        requireText={pending?.requireText}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const p = pending;
          setPending(null);
          if (p) void go(p.action, p.done);
        }}
      />

      <ConfirmModal
        open={refunding !== null}
        elevated
        title={`Refund invoice ${refunding?.number ?? ""}?`}
        description="This cannot be undone."
        body={
          <span className="flex flex-col gap-3">
            <span>The money goes back to the card it was paid with. Stripe takes 5 to 10 days to show it.</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={refundUsd}
              onChange={(e) => setRefundUsd(e.target.value)}
              aria-label="Refund amount (USD)"
              className="h-11"
            />
          </span>
        }
        confirmLabel={`Refund ${usdCents.format(Number(refundUsd) || 0)}`}
        requireText={panel.name}
        onClose={() => setRefunding(null)}
        onConfirm={() => {
          const inv = refunding;
          setRefunding(null);
          if (!inv) return;
          const cents = Math.round(Number(refundUsd) * 100);
          const full = inv.amountPaidCents - inv.amountRefundedCents;
          void go(
            () => refundInvoice(orgId, inv.id, cents === full ? undefined : cents),
            `${usdCents.format(cents / 100)} refunded.`
          );
        }}
      />
    </>
  );
}
