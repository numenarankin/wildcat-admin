import { cn } from "@/lib/utils";

/**
 * A percentage move, as a green ▲ or a red ▼ — the topbar price ticker's
 * treatment, shared so a production move and a price move read identically.
 *
 * Renders NOTHING for a null move. Null is "there is no honest percentage
 * here": nothing to compare against yet, or a previous value of zero, where the
 * change is undefined however far the figure actually rose. A 0.00% would claim
 * the opposite.
 */
export function DeltaPct({
  /** The move as a fraction: 0.0125 is up 1.25%. */
  value,
  className,
  title,
}: {
  value: number | null;
  className?: string;
  title?: string;
}) {
  if (value === null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  return (
    <span
      className={cn(
        "tabular-nums",
        up ? "text-success" : "text-destructive",
        className
      )}
      title={title}
    >
      {up ? "▲" : "▼"}
      {Math.abs(value * 100).toFixed(2)}%
    </span>
  );
}
