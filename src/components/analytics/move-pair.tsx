"use client";

import { DeltaPct } from "@/components/delta-pct";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A figure's two moves side by side: "▲2.25% / ▼1.46%" — the day-over-day
 * move, then the 30-day move — each explaining itself on hover.
 *
 * Two moves because they answer different questions. The day's move is what
 * the field did since the last gauge round; it is honest and it is noisy. The
 * 30-day move is a week's average against a week's average a month ago
 * (`thirty-day-change.ts`), which is what "are we up or down this month"
 * actually means once a haul or a missed gauge cannot swing it.
 *
 * A side with no honest percentage (nothing to compare against, or a previous
 * value of zero) shows a dash so the pair keeps its shape; the whole thing is
 * absent only when both sides are.
 */
export function MovePair({
  day,
  month,
  className,
  hints,
  showEmpty = false,
}: {
  /** Day-over-day move as a fraction (0.0125 = up 1.25%), or null. */
  day: number | null;
  /** 30-day move as a fraction, or null. */
  month: number | null;
  className?: string;
  /**
   * What each side explains on hover. Defaults to the production wording;
   * a surface whose two moves are over different spans (the admin
   * dashboard's week and month) says so here.
   */
  hints?: { day: string; month: string };
  /**
   * Keep the pair on screen as two dashes when neither side has a figure.
   * The production cards drop it (a card with no history has nothing to
   * say); the admin cards show the shape so the reader sees the indicator
   * exists and can hover it for why it is empty.
   */
  showEmpty?: boolean;
}) {
  if (day === null && month === null && !showEmpty) return null;
  return (
    <span className={cn("inline-flex items-baseline gap-1 tabular-nums", className)}>
      <Move value={day} hint={hints?.day ?? DAY_HINT} />
      <span className="text-muted-foreground">/</span>
      <Move value={month} hint={hints?.month ?? MONTH_HINT} />
    </span>
  );
}

const DAY_HINT =
  "Day over day: the last complete measured day against the measured day before it. Same wells on both sides.";
const MONTH_HINT =
  "30-day: the average of the last 7 measured days against the average of the 7 measured days ending 30 days earlier. Same wells on both sides.";

function Move({ value, hint }: { value: number | null; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="cursor-help" />}
      >
        {value === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <DeltaPct value={value} />
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-left">{hint}</TooltipContent>
    </Tooltip>
  );
}
