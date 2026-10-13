import "server-only";

import { z } from "zod";
import { defineTool, type CatalogTool } from "@/lib/ai/catalog-tool";
import { getSupabaseServer } from "@/lib/supabase/server";
import { variance } from "../math";

/**
 * Revenue integrity: what a purchaser settled against what we shipped.
 *
 * The tickets, the gauges and the statement are three independent measurements
 * of one barrel. Nobody reconciles them by hand every month, so a deduct that
 * drifts or a ticket that never settles goes unnoticed for a year. This is the
 * analysis that pays for itself, and its whole value is that every finding
 * carries the rows to put on the phone call.
 *
 * A variance here is NOT automatically an underpayment. Tickets and statements
 * legitimately differ on timing, on BS&W, and on which month a late haul lands
 * in. The tool reports the gap and the rows; it does not accuse.
 */

type Row = Record<string, unknown>;

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const TOOLS: CatalogTool[] = [
  defineTool(
    "settlement_audit",
    "Purchaser statements against the run tickets behind them, per statement: barrels settled, barrels shipped, and the gap. The answer to 'am I being paid for everything I sold'. Every finding carries the statement and the ticket dates so it can be raised with the purchaser.",
    {
      from: z.string().optional(),
      to: z.string().optional(),
      purchaserId: z.string().optional(),
      minVariancePct: z.number().min(0).max(1).optional(),
    },
    async ({ from, to, purchaserId, minVariancePct }) => {
      const sb = await getSupabaseServer();

      let statementQuery = sb
        .from("statements")
        .select(
          "id, purchaser_id, period_start, period_end, product, status, statement_no, total_oil_bbls, total_value, total_deducts, total_taxes"
        );
      if (purchaserId) statementQuery = statementQuery.eq("purchaser_id", purchaserId);
      if (from) statementQuery = statementQuery.gte("period_end", from);
      if (to) statementQuery = statementQuery.lte("period_start", to);
      const { data: statements, error } = await statementQuery;
      if (error) {
        return { ok: false as const, error: `settlement_audit: ${error.message}` };
      }

      const { data: purchasers } = await sb.from("purchasers").select("id, name");
      const purchaserName = new Map(
        (purchasers ?? []).map((p: Row) => [str(p.id), str(p.name)])
      );

      const { data: tickets } = await sb
        .from("run_tickets")
        .select("id, ticket_date, ticket_no, purchaser_id, net_bbls, gross_bbls, product, deleted_at");
      const live = (tickets ?? []).filter((t: Row) => !t.deleted_at);

      const rows = (statements ?? []).map((s: Row) => {
        const start = str(s.period_start);
        const end = str(s.period_end);
        const mine = live.filter(
          (t: Row) =>
            str(t.purchaser_id) === str(s.purchaser_id) &&
            str(t.ticket_date) >= start &&
            str(t.ticket_date) <= end
        );
        const shipped = mine.reduce((sum: number, t: Row) => sum + num(t.net_bbls), 0);
        const settled = num(s.total_oil_bbls);
        const gap = variance(shipped, settled);

        return {
          statement: {
            id: str(s.id),
            number: str(s.statement_no),
            purchaser: purchaserName.get(str(s.purchaser_id)) ?? str(s.purchaser_id),
            period: `${start} to ${end}`,
            status: str(s.status),
            settledBbls: settled,
            value: num(s.total_value),
            deducts: num(s.total_deducts),
            taxes: num(s.total_taxes),
          },
          shippedBbls: shipped,
          ticketCount: mine.length,
          tickets: mine.slice(0, 20).map((t: Row) => ({
            id: str(t.id),
            date: str(t.ticket_date),
            number: str(t.ticket_no),
            netBbls: num(t.net_bbls),
          })),
          variance: gap,
          /** Deducts as a share of gross value, which is the number that drifts. */
          deductRate:
            num(s.total_value) > 0 ? num(s.total_deducts) / num(s.total_value) : null,
        };
      });

      const floor = minVariancePct ?? 0.01;
      const flagged = rows.filter(
        (r) => r.variance.pct !== null && Math.abs(r.variance.pct) >= floor
      );

      return {
        window: { from: from ?? null, to: to ?? null },
        statements: rows.length,
        flagged,
        flaggedCount: flagged.length,
        all: rows,
        note:
          "A gap is not an underpayment on its own: a late haul lands in the next period, " +
          "and BS&W moves gross to net. Report the gap with the tickets behind it and let " +
          "the operator judge. Tickets are matched to a statement by purchaser and by " +
          "ticket date falling inside the statement period.",
        ...(rows.length === 0
          ? { note2: "No statements on file for this window, so nothing could be checked." }
          : {}),
      };
    }
  ),

  defineTool(
    "deduct_drift",
    "A purchaser's deduct rate over time. A rate that climbs quietly is money leaving on every statement and shows up nowhere else.",
    { purchaserId: z.string().optional(), from: z.string().optional() },
    async ({ purchaserId, from }) => {
      const sb = await getSupabaseServer();
      let q = sb
        .from("statements")
        .select("purchaser_id, period_start, total_value, total_deducts")
        .order("period_start");
      if (purchaserId) q = q.eq("purchaser_id", purchaserId);
      if (from) q = q.gte("period_start", from);
      const { data, error } = await q;
      if (error) return { ok: false as const, error: `deduct_drift: ${error.message}` };

      const { data: purchasers } = await sb.from("purchasers").select("id, name");
      const name = new Map((purchasers ?? []).map((p: Row) => [str(p.id), str(p.name)]));

      const byPurchaser = new Map<string, { period: string; rate: number }[]>();
      for (const s of data ?? []) {
        const value = num((s as Row).total_value);
        if (value <= 0) continue;
        const key = str((s as Row).purchaser_id);
        const list = byPurchaser.get(key) ?? [];
        list.push({
          period: str((s as Row).period_start).slice(0, 7),
          rate: num((s as Row).total_deducts) / value,
        });
        byPurchaser.set(key, list);
      }

      return {
        purchasers: [...byPurchaser.entries()].map(([id, series]) => ({
          purchaser: name.get(id) ?? id,
          purchaserId: id,
          series,
          first: series[0]?.rate ?? null,
          latest: series[series.length - 1]?.rate ?? null,
          change:
            series.length > 1
              ? variance(series[0].rate, series[series.length - 1].rate)
              : null,
        })),
        note: "Rate is total deducts over total value on each statement. Statements with no value are skipped rather than counted as a zero rate.",
      };
    }
  ),
];
