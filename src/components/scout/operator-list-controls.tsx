"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getOperatorsLast12, getOperatorsP5Status } from "@/lib/scout/queries";
import { perMonth, P5_STATUS } from "@/lib/scout/format";
import { FALLBACK_PRICES, monthlyRevenue } from "@/lib/scout/revenue";
import type { CommodityPrices } from "@/lib/analytics/types";

/**
 * The sort + activity controls shared by every operator list on /scout — the
 * cluster panel and the principal panel's affiliations.
 *
 * Shared rather than duplicated because the two lists answer the same question
 * about the same rows. Two copies drifted once already: the cluster list could
 * sort by production and the affiliation list could not, so "the biggest
 * operator this person is on" was a question the page could only answer in one
 * of the two places it listed operators.
 */

export type OperatorSortKey = "wells" | "revenue" | "oil" | "gas" | "name";

export const OPERATOR_SORTS: { value: OperatorSortKey; label: string }[] = [
  { value: "wells", label: "Well count" },
  { value: "revenue", label: "Revenue (per mo)" },
  { value: "oil", label: "Oil (per mo)" },
  { value: "gas", label: "Gas (per mo)" },
  { value: "name", label: "Name (A–Z)" },
];

/**
 * Activity = the operator's P-5 standing, which is the RRC's own answer to "is
 * this company still operating": Active, Delinquent, Revoked, and so on. It is
 * a property of the OPERATOR, unlike the producing/idle/plugged buckets in the
 * operator dossier, which are properties of a wellbore and say nothing about
 * the company.
 *
 * Only the statuses worth filtering on are offered as their own entry; the rest
 * are reachable through "Any". The letters are `format.ts`'s `P5_STATUS` keys.
 */
export const ACTIVITY_OPTIONS: { value: string; label: string }[] = [
  { value: "any", label: "Any activity" },
  { value: "A", label: "Active" },
  { value: "X", label: "Active (extension)" },
  { value: "H", label: "Active (hearing)" },
  { value: "I", label: "Inactive" },
  { value: "D", label: "Delinquent" },
  { value: "R", label: "Revoked" },
];

/** The minimum an operator row needs to be sorted and filtered by these. */
export interface SortableOperator {
  /** Operator number. */
  n: number;
  /** Operator name. */
  nm: string | null;
  /** Well count to sort on. */
  w: number;
}

export interface OperatorListState<T extends SortableOperator> {
  sort: OperatorSortKey;
  setSort: (v: OperatorSortKey) => void;
  activity: string;
  setActivity: (v: string) => void;
  /** Filtered, then sorted. What the list should render. */
  visible: T[];
  /**
   * Trailing-window production by operator number, for the row's detail line.
   * Still the SUM, with `months` as the divisor the rows apply at render — see
   * `perMonth` in `lib/scout/format.ts`.
   */
  production: Map<number, { oil: number; gas: number; months: number }>;
  /** P-5 status letter by operator number; absent while the lookup is in flight. */
  status: Map<number, string>;
  /** The revenue sort's figure for a row, per month, at the hook's prices. */
  revenueOf: (operatorNumber: number) => number;
}

/**
 * Loads the production and status a list needs, and applies its sort + filter.
 *
 * Both lookups are batched over the whole list and keyed on its membership, so
 * changing the sort or the filter re-orders what is already loaded rather than
 * re-fetching it.
 */
export function useOperatorList<T extends SortableOperator>(
  operators: T[],
  /**
   * Prices behind the revenue sort (`monthlyRevenue`): the page's live quotes
   * where the caller has them, else the same fallbacks the map uses.
   */
  prices: CommodityPrices = FALLBACK_PRICES
): OperatorListState<T> {
  const [sort, setSort] = useState<OperatorSortKey>("wells");
  const [activity, setActivity] = useState("any");
  const [production, setProduction] = useState<
    Map<number, { oil: number; gas: number; months: number }>
  >(new Map());
  const [status, setStatus] = useState<Map<number, string>>(new Map());

  // Keyed on membership, not identity: the parent rebuilds this array on every
  // render, and depending on the array itself would refetch forever.
  const ids = operators.map((o) => o.n).join(",");

  useEffect(() => {
    let active = true;
    // Wrapped in an async function so no setState runs synchronously in the
    // effect body (react-hooks/set-state-in-effect).
    async function load() {
      setProduction(new Map());
      setStatus(new Map());
      const nums = ids ? ids.split(",").map(Number) : [];
      if (nums.length === 0) return;
      // Settled independently: a failed production read should not also cost
      // the list its activity filter, and vice versa. Either one missing
      // degrades to "no data" for that control rather than an empty list.
      const [prod, st] = await Promise.allSettled([
        getOperatorsLast12(nums),
        getOperatorsP5Status(nums),
      ]);
      if (!active) return;
      if (prod.status === "fulfilled") setProduction(prod.value);
      if (st.status === "fulfilled") setStatus(st.value);
    }
    void load();
    return () => {
      active = false;
    };
  }, [ids]);

  const visible = useMemo(() => {
    // Sorted on the RATE, which is what the row prints. Not on the window's sum:
    // an operator that filed nine of the twelve months is a bigger producer than
    // one that filed twelve for the same total, and ranking by the sum would put
    // it lower than the number beside it — a column out of order with its own
    // heading. See `perMonth` in `lib/scout/format.ts`.
    const oil = (n: number) =>
      perMonth(production.get(n)?.oil, production.get(n)?.months);
    const gas = (n: number) =>
      perMonth(production.get(n)?.gas, production.get(n)?.months);
    const revenue = (n: number) => monthlyRevenue(oil(n), gas(n), prices);
    // An operator whose status has not loaded (or is not on file) is NOT
    // silently dropped by a filter it cannot be tested against — it is only
    // hidden once a specific activity is asked for and its own differs.
    const list =
      activity === "any"
        ? [...operators]
        : operators.filter((o) => status.get(o.n) === activity);
    switch (sort) {
      case "name":
        return list.sort((a, b) => (a.nm || "").localeCompare(b.nm || ""));
      case "revenue":
        return list.sort((a, b) => revenue(b.n) - revenue(a.n) || b.w - a.w);
      case "oil":
        return list.sort((a, b) => oil(b.n) - oil(a.n) || b.w - a.w);
      case "gas":
        return list.sort((a, b) => gas(b.n) - gas(a.n) || b.w - a.w);
      default:
        return list.sort((a, b) => b.w - a.w);
    }
  }, [operators, sort, activity, production, status, prices]);

  const revenueOf = useCallback(
    (n: number) =>
      monthlyRevenue(
        perMonth(production.get(n)?.oil, production.get(n)?.months),
        perMonth(production.get(n)?.gas, production.get(n)?.months),
        prices
      ),
    [production, prices]
  );

  return {
    sort,
    setSort,
    activity,
    setActivity,
    visible,
    production,
    status,
    revenueOf,
  };
}

/** The paired Sort and Activity dropdowns, as both lists render them. */
export function OperatorListControls({
  sort,
  onSort,
  activity,
  onActivity,
}: {
  sort: OperatorSortKey;
  onSort: (v: OperatorSortKey) => void;
  activity: string;
  onActivity: (v: string) => void;
}) {
  const activityLabel =
    ACTIVITY_OPTIONS.find((a) => a.value === activity)?.label ?? "Any activity";
  const sortLabel =
    OPERATOR_SORTS.find((s) => s.value === sort)?.label ?? "Well count";
  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={activity}
        onValueChange={(v) => onActivity(String(v))}
      >
        <SelectTrigger size="sm" aria-label="Filter by activity" className="text-xs">
          {/* The trigger prints the raw value without a renderer, which here is
              a bare P-5 letter. */}
          <SelectValue>{() => activityLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ACTIVITY_OPTIONS.map((a) => (
            <SelectItem key={a.value} value={a.value}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={sort}
        onValueChange={(v) => onSort(v as OperatorSortKey)}
      >
        <SelectTrigger size="sm" aria-label="Sort operators" className="text-xs">
          <SelectValue>{() => sortLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {OPERATOR_SORTS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Human label for a P-5 letter, for the row's detail line. */
export function activityLabel(letter: string | undefined): string | null {
  if (!letter) return null;
  return P5_STATUS[letter] ?? letter;
}
