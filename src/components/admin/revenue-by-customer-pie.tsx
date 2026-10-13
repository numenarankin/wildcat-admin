"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CustomerRow } from "@/lib/admin/customer-rows";

/**
 * Each customer's share of recurring revenue. The customer dashboard's
 * production pie with one metric and one breakdown: the slices are the table's
 * revenue column, so a slice is a share of the row beneath it.
 */

const COLORS = [
  "#059669", "#800000", "#4169e1", "#d97706", "#7c3aed",
  "#db2777", "#0891b2", "#65a30d", "#dc2626", "#475569",
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

interface Slice {
  name: string;
  value: number;
  color: string;
}

export function RevenueByCustomerPie({
  customers,
  className,
}: {
  customers: CustomerRow[];
  className?: string;
}) {
  const slices: Slice[] = customers
    .filter((c) => c.revenueUsd > 0)
    .sort((a, b) => b.revenueUsd - a.revenueUsd)
    .map((c, index) => ({ name: c.name, value: c.revenueUsd, color: COLORS[index % COLORS.length] }));
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  return (
    <Card className={cn("flex h-full flex-col rounded-[0.15rem]", className)}>
      <CardHeader>
        <CardTitle>Revenue by customer</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        {slices.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No recurring revenue to display.
          </p>
        ) : (
          <div className="min-h-[240px] w-full flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  cursor={false}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const slice = payload[0].payload as Slice;
                    return (
                      <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md">
                        <div className="flex items-center gap-2 font-medium">
                          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
                          {slice.name}
                        </div>
                        <div className="mt-0.5 pl-4.5 tabular-nums text-muted-foreground">
                          {usd.format(slice.value)}
                          {total > 0 && (
                            <span className="ml-1.5">({Math.round((slice.value / total) * 100)}%)</span>
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
                <Pie data={slices} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={1} strokeWidth={1}>
                  {slices.map((slice) => (
                    <Cell key={slice.name} fill={slice.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
