import { MorningBrief } from "@/components/analytics/morning-brief";
import { AdminSummaryStats } from "@/components/admin/admin-summary-stats";
import { AdminMetricsChart } from "@/components/admin/admin-metrics-chart";
import { RevenueByCustomerPie } from "@/components/admin/revenue-by-customer-pie";
import { CustomersTable } from "@/components/admin/customers-table";
import { PageContextSlice } from "@/components/ai/page-context-slice";
import { dashboardStatsSlice } from "@/lib/ai/admin/page-slices";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { listCustomers, listNonCustomerStripeSubscriptionIds } from "@/lib/admin/customers";
import { listRecurringSubscriptions } from "@/lib/admin/stripe-subscriptions";
import { countSince, monthlyCounts, weeklyCounts } from "@/lib/admin/growth-series";
import {
  acvAt,
  arrAt,
  countBetween,
  dailySeries,
  datedBySignup,
  monthlyGrowthAt,
  movesFor,
  payingAt,
  referralCoefficientAt,
} from "@/lib/admin/metrics";

export const metadata = { title: "Dashboard" };

const ACQUIRED_WINDOW_DAYS = 30;

/**
 * The dashboard for the people running Wildcat: the business, not a field.
 * Same shape as the customer dashboard (brief, headline row, chart beside a
 * pie, table). Revenue figures come from Stripe's subscription history
 * (`stripe-subscriptions.ts`), sign-up figures from the customer list; the
 * definitions are in `lib/admin/metrics.ts`. Demo and test orgs are out of
 * all of it.
 */
export default async function AdminDashboardPage() {
  await requireAdminPage("dashboard");
  const [customers, excluded] = await Promise.all([
    listCustomers(),
    listNonCustomerStripeSubscriptionIds(),
  ]);
  // A customer counts as paying from the day they signed up, not from when
  // Stripe started billing them; the cards and the chart both use this.
  const subs = datedBySignup(await listRecurringSubscriptions(excluded), customers);

  const now = new Date();
  const nowMs = now.getTime();
  const signups = customers.map((c) => c.signedUpAt);
  // A referral happens when the referred org signs up, so it is dated by that
  // org's own sign-up.
  const referrals = customers.filter((c) => c.referredByOrg).map((c) => c.signedUpAt);
  // One point per day from the first sign-up. Customers acquired is a weekly
  // total and referrals a monthly one: per day they would only ever be 0 or 1.
  const firstSignup = Math.min(nowMs, ...signups.map((d) => Date.parse(d)).filter((t) => !Number.isNaN(t)));
  const daily = dailySeries(subs, customers, firstSignup, nowMs);
  const byDay = (points: { day: string; value: number }[]) =>
    points.map((p) => ({ date: p.day, value: p.value }));
  const byMonth = (points: { month: string; value: number }[]) =>
    points.map((p) => ({ date: p.month, value: p.value }));

  // One set of figures for the cards and for the Orion drawer's copy of them.
  const stats = {
    payingUsers: payingAt(subs, nowMs),
    arrUsd: arrAt(subs, nowMs),
    acvUsd: acvAt(subs, nowMs),
    arrGrowth: monthlyGrowthAt(subs, nowMs),
    referralCoefficient: referralCoefficientAt(customers, nowMs),
    newCustomers30d: countSince(signups, ACQUIRED_WINDOW_DAYS, now),
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      {/* One summary sentence, not the customer brief's report: no reserved height. */}
      <MorningBrief className="min-h-0" />

      <PageContextSlice sliceKey="admin-dashboard-stats" slice={dashboardStatsSlice(stats)} />
      <AdminSummaryStats
        {...stats}
        moves={{
          payingUsers: movesFor((at) => payingAt(subs, at), nowMs),
          arrUsd: movesFor((at) => arrAt(subs, at), nowMs),
          acvUsd: movesFor((at) => acvAt(subs, at), nowMs),
          referralCoefficient: movesFor((at) => referralCoefficientAt(customers, at), nowMs),
          newCustomers30d: movesFor((at) => countBetween(signups, ACQUIRED_WINDOW_DAYS, at), nowMs),
        }}
      />

      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-3">
        <AdminMetricsChart
          className="lg:col-span-2"
          nowMs={nowMs}
          series={{
            paying: byDay(daily.paying),
            arr: byDay(daily.arr),
            acv: byDay(daily.acv),
            arrGrowth: byDay(daily.arrGrowth),
            referral: byDay(daily.referral),
            customersAcquired: weeklyCounts(signups, now).map((p) => ({ date: p.week, value: p.value })),
            referrals: byMonth(monthlyCounts(referrals, now)),
          }}
        />
        <RevenueByCustomerPie customers={customers} />
      </div>

      {/* Newest sign-ups first: on the dashboard the question is who just
          arrived. Clients sorts by revenue instead. */}
      <CustomersTable rows={customers} defaultSort="signedUpAt" />
    </div>
  );
}
