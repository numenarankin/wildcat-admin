import type { ReactNode } from "react";
import { MovePair } from "@/components/analytics/move-pair";
import type { Moves } from "@/lib/admin/metrics";

/**
 * The headline row of the admin dashboard: the four numbers the people
 * running Wildcat steer by. Same card as the customer dashboard's
 * `SummaryStats`, different questions, and the same two moves beside each
 * figure: against 7 days ago and against 30 days ago (`MovePair`, with its
 * hover text saying so). Presentational only; every figure is passed in.
 */

const HINTS = {
  day: "Against 7 days ago: the same figure, computed at that instant. A dash means it was zero or unknown then.",
  month: "Against 30 days ago: the same figure, computed at that instant. A dash means it was zero or unknown then.",
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const percent = (n: number) => `${(n * 100).toFixed(1).replace("-", "−")}%`;

const ratio = (n: number) => n.toFixed(2);

const count = (n: number) => n.toLocaleString("en-US");

export function Stat({ label, value, moves }: { label: string; value: ReactNode; moves?: Moves }) {
  return (
    <div className="flex flex-col gap-1 rounded-[0.15rem] border px-4 py-3">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        {moves ? (
          <MovePair day={moves.week} month={moves.month} hints={HINTS} showEmpty className="text-xs" />
        ) : null}
      </span>
    </div>
  );
}

export function AdminSummaryStats({
  payingUsers,
  arrUsd,
  acvUsd,
  arrGrowth,
  referralCoefficient,
  newCustomers30d,
  moves,
}: {
  /** Customers with a live subscription (card on file, trial included). */
  payingUsers: number;
  /** Annual recurring revenue, or null until wired. */
  arrUsd: number | null;
  /** Annual contract value: ARR per paying customer, or null until wired. */
  acvUsd: number | null;
  /** ARR growth over the trailing 30 days as a fraction (0.12 = up 12%), or null until wired. */
  arrGrowth: number | null;
  /** Referrals per customer, or null until wired. */
  referralCoefficient: number | null;
  /** Orgs that signed up in the last 30 days. */
  newCustomers30d: number;
  /** Each figure's moves against 7 and 30 days ago; a missing key shows none. */
  moves: Partial<Record<"payingUsers" | "arrUsd" | "acvUsd" | "referralCoefficient" | "newCustomers30d", Moves>>;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Paying users" value={count(payingUsers)} moves={moves.payingUsers} />
      <Stat label="ARR" value={arrUsd == null ? "—" : money(arrUsd)} moves={moves.arrUsd} />
      <Stat label="ACV" value={acvUsd == null ? "—" : money(acvUsd)} moves={moves.acvUsd} />
      {/* Already a rate: a move on a growth rate would be a change of a change. */}
      <Stat label="ARR growth (30d)" value={arrGrowth == null ? "—" : percent(arrGrowth)} />
      <Stat
        label="Referral coefficient"
        value={referralCoefficient == null ? "—" : ratio(referralCoefficient)}
        moves={moves.referralCoefficient}
      />
      <Stat label="New customers (30d)" value={count(newCustomers30d)} moves={moves.newCustomers30d} />
    </div>
  );
}
