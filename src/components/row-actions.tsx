"use client";

import { SettingsIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The per-row settings/delete buttons, revealed on hover.
 *
 * One component rather than the same twenty lines in every table: six of them
 * carried a byte-identical copy, and the copies had already drifted on
 * alignment. The visibility rule in particular is easy to get subtly wrong, so
 * it lives in exactly one place.
 *
 * ## Two things the caller has to do
 *
 *  1. Put `group` on the row (`<WellRow className="group ...">`). That is what
 *     `group-hover` reads.
 *  2. Leave the column's header EMPTY. A permanent "Actions" heading sits over
 *     a blank column whenever no row is hovered, which is most of the time.
 *     Keep the header cell itself, though — dropping it collapses the column
 *     and the layout shifts the moment a row lights up.
 *
 * ## Why not `hidden` or `invisible`
 *
 * `opacity-0` keeps the buttons laid out, so nothing reflows when they appear.
 * The cost is that they stay focusable while invisible, which strands a
 * keyboard user on a control they cannot see — hence `group-focus-within`,
 * which brings them back the moment either button takes focus.
 */
export function RowActions({
  label,
  onSettings,
  onDelete,
  deleteLabel,
  className,
}: {
  /** The row's subject, for the buttons' accessible names ("Roach settings"). */
  label: string;
  onSettings?: () => void;
  onDelete?: () => void;
  /**
   * Override the delete button's accessible name. Some tables unlink rather
   * than delete (a well leaving a battery is still a well), and the button
   * should say what the click actually does.
   */
  deleteLabel?: string;
  className?: string;
}) {
  if (!onSettings && !onDelete) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-1 opacity-0 transition-opacity",
        "group-hover:opacity-100 group-focus-within:opacity-100",
        className
      )}
    >
      {onSettings ? (
        <button
          type="button"
          aria-label={`${label} settings`}
          // Stop the click/key from bubbling to the row's link navigation.
          onClick={(event) => {
            event.stopPropagation();
            onSettings();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SettingsIcon className="size-4" />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          aria-label={deleteLabel ?? `Delete ${label}`}
          // Stop the click/key from bubbling to the row's link navigation.
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <Trash2Icon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The header cell that holds {@link RowActions}. Empty on purpose; the width
 * keeps the column from collapsing when nothing is hovered.
 */
export function RowActionsHead() {
  return (
    <th className="w-20">
      <span className="sr-only">Row actions</span>
    </th>
  );
}
