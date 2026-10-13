/**
 * The accounting app's table look, set once so every full-page table under an
 * `AccountingToolbar` matches: no frame, a plain muted header, short rows with
 * light dividers, and the outer cells padded to the toolbar's px-4 so the
 * first column lines up with the tabs.
 */

/** On the `Table`. */
export const ACCOUNTING_TABLE_CLASS =
  "text-sm [&_tr]:border-border/60 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4";

/** On the `TableHeader`. */
export const ACCOUNTING_HEADER_CLASS =
  "[&_th]:h-9 [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted-foreground";

/** On the header's `TableRow`: no hover band on the header. */
export const ACCOUNTING_HEADER_ROW_CLASS = "hover:bg-transparent";

/** On each body row; `group` drives the hover-only row actions. */
export const ACCOUNTING_ROW_CLASS = "group [&>td]:py-1.5";

/** The scroller that holds the table and fills the page under the toolbar. */
export const ACCOUNTING_TABLE_SCROLL_CLASS = "min-h-0 flex-1 overflow-y-auto";

/**
 * The same look at Layer's scale, for Finance's pages on the taller toolbar
 * (`AccountingToolbar size="default"`): the outer cells on the page's 24px
 * gutter, a taller header, roomier rows. Matches the custom Transactions table.
 */
export const ROOMY_TABLE_CLASS =
  "text-sm [&_tr]:border-border/60 [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6";
export const ROOMY_HEADER_CLASS =
  "[&_th]:h-11 [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted-foreground";
export const ROOMY_ROW_CLASS = "group [&>td]:py-3";
