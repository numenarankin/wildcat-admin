import { Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The per-row delete control for a table's "Actions" column, shared by the
 * People, Revenue statements, and Production tables so they look and behave
 * identically. A trash icon that turns destructive-red on hover and stops its
 * click/keydown from bubbling to a clickable or linked row.
 */
export function RowDeleteButton({
  label,
  onDelete,
  compact = false,
  className,
}: {
  /** Accessible label naming the row, e.g. `Delete Acme Oilfield Services`. */
  label: string;
  onDelete: () => void;
  /**
   * Shrink to fit a single-line chip (the calendar's event pills) instead of a
   * table row, where the full-size hit area would grow the row.
   */
  compact?: boolean;
  /** Extra classes, e.g. the reveal-on-hover treatment used by the cards. */
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      // Stop the click/key from bubbling to the row's own click or link nav.
      onClick={(event) => {
        event.stopPropagation();
        onDelete();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive",
        compact ? "size-4" : "size-7",
        className
      )}
    >
      <Trash2Icon className={compact ? "size-3" : "size-4"} />
    </button>
  );
}
