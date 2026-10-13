"use client";

/**
 * The shared vocabulary every Settings tab is built from.
 *
 * Before this existed each tab hand-rolled the same four things and drifted:
 * four different heading treatments, four border radii, three input heights,
 * five ways of saying "saved", and the table header class string copy-pasted
 * into five files (with a sixth file using a slightly different one, so its
 * header row was a different height). The rules are now written down once, here,
 * and every tab imports them.
 *
 * The rules:
 *
 * - **The tab label IS the page title.** `SettingsWorkspace` renders the nav at
 *   `font-heading text-2xl`, so a tab that also printed "Members" above its own
 *   table said the same word twice in two sizes. Tabs open with a description,
 *   not a heading. `SettingsSection` is for genuine sub-sections *within* a tab
 *   (the RRC records tab has three), and it sits a step below at `text-lg`.
 * - **One radius**, `SETTINGS_RADIUS`, on every bordered surface.
 * - **One control height per surface.** `SETTINGS_CONTROL` (h-9) on the page,
 *   `MODAL_CONTROL` (h-11) inside a `SwipeUpModal`, which is a touch target on
 *   a tablet in a truck and is deliberately bigger. Buttons match their inputs:
 *   `size="lg"` is the 36px variant, so it lines up with h-9.
 * - **One table**, `SettingsTable`, which owns the header styling.
 * - **One way to confirm something irreversible-feeling**, `ConfirmModal`.
 */

import { useState, type ReactNode } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { cn } from "@/lib/utils";

/** The one radius for every bordered surface in Settings. */
export const SETTINGS_RADIUS = "rounded-[0.15rem]";

/** Input and button height on a Settings page. `size="lg"` buttons match it. */
export const SETTINGS_CONTROL = "h-9";

/** Input and button height inside a modal, where the target is a fingertip. */
export const MODAL_CONTROL = "h-11";

/** Header cells for every Settings table. Applied by `SettingsTable`. */
const TABLE_HEAD =
  "[&_th]:h-12 [&_th]:font-mono [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground";

/**
 * A whole tab. Opens with its description (the nav already carries the title)
 * or its `SettingsTabs` strip, and an optional top-right action.
 */
export function SettingsPanel({
  description,
  tabs,
  action,
  className,
  children,
}: {
  description?: ReactNode;
  /** A `SettingsTabs` strip, on the action's line rather than above it. */
  tabs?: ReactNode;
  /** Top-right button, e.g. "Add member". */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex w-full flex-col gap-4", className)}>
      {(description || tabs || action) && (
        // Tabs sit centred against the button beside them; a description is
        // top-aligned, because it can wrap to several lines.
        <div
          className={cn(
            "flex flex-wrap justify-between gap-3",
            tabs ? "items-center" : "items-start"
          )}
        >
          {tabs ? (
            tabs
          ) : description ? (
            <p className="text-sm text-muted-foreground">
              {description}
            </p>
          ) : (
            <span />
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** A sub-section within a tab. One step below the tab label in the hierarchy. */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The tab strip *inside* a Settings tab (Organization -> Members / Well Info).
 * The Settings nav's own treatment one size down — no underline, quiet label
 * for the tabs you aren't on. Pass it to `SettingsPanel`'s `tabs` prop so it
 * sits on the same line as that tab's action button.
 */
export function SettingsTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex flex-wrap items-center gap-x-6 gap-y-1"
    >
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "cursor-pointer font-heading text-lg font-semibold tracking-tight transition-colors",
            value === id
              ? "text-foreground"
              : "text-muted-foreground/50 hover:text-muted-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A bordered block: a balance, a toggle, a form. The non-table surface. */
export function SettingsCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("border p-4", SETTINGS_RADIUS, className)}>
      {children}
    </div>
  );
}

/**
 * Every table in Settings. Owns the border, the radius, the body text size and
 * the header treatment, so no tab has to remember them.
 *
 * `bordered={false}` for a table already inside a bordered surface (the
 * collapsed Removed members drawer), which would otherwise double its edge.
 *
 * Omit `head` for a single-column list where the heading would only name the
 * one thing every row obviously is (the well info field list).
 */
export function SettingsTable({
  head,
  bordered = true,
  children,
}: {
  head?: ReactNode;
  bordered?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("overflow-hidden", bordered && `border ${SETTINGS_RADIUS}`)}
    >
      <Table className="text-[0.95rem]">
        {head && (
          <TableHeader className={TABLE_HEAD}>
            <TableRow className="bg-muted/50 hover:bg-muted/50">{head}</TableRow>
          </TableHeader>
        )}
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/** A body row, at the one row height. */
export function SettingsRow({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TableRow>) {
  return (
    <TableRow className={cn("[&>td]:py-4", className)} {...props}>
      {children}
    </TableRow>
  );
}

/** The "nothing here yet" row, at the one empty-state height. */
export function SettingsEmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={colSpan}
        className="h-20 text-center text-muted-foreground"
      >
        {children}
      </TableCell>
    </TableRow>
  );
}

/** A labelled form field. `hint` sits under the control, quieter. */
export function SettingsField({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A status pill: Pending, Primary, Custom. One shape, three tones. */
export function SettingsChip({
  tone = "muted",
  children,
}: {
  tone?: "amber" | "primary" | "muted";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "amber" &&
          "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        tone === "primary" && "bg-primary/10 text-primary",
        tone === "muted" && "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

/**
 * A setting that is just on or off, with the explanation beside it. Used for
 * the org's document scanning and its state production history, which were the
 * same block written twice in two files.
 */
export function SettingsToggleRow({
  title,
  description,
  checked,
  onCheckedChange,
  pending,
  disabled,
}: {
  title: string;
  description: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Shows a spinner beside the title while the write is in flight. */
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    // Capped rather than full-bleed: this is one switch and a sentence, and
    // stretched to a wide table's width the switch ends up a screen away from
    // the text it belongs to. Matches the AI tab, whose column is already this
    // wide, so every toggle in Settings is the same size.
    <SettingsCard className="flex max-w-2xl items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-base font-semibold">
          {title}
          {pending && (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled ?? pending}
        aria-label={title}
      />
    </SettingsCard>
  );
}

/**
 * The one way a Settings tab reports what just happened. An error outranks a
 * notice, because a failure is the more urgent of the two.
 */
export function SettingsMessage({
  error,
  notice,
}: {
  error?: string | null;
  notice?: string | null;
}) {
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (notice) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        {notice}
      </p>
    );
  }
  return null;
}

/**
 * The Saving / Saved line for auto-saving forms. Keeps its height whether or
 * not it has anything to say, so the fields below it never jump.
 */
export function SaveState({
  pending,
  saved,
  savedLabel = "Saved",
}: {
  pending: boolean;
  saved: boolean;
  savedLabel?: string;
}) {
  return (
    <div className="h-5 text-sm text-muted-foreground" aria-live="polite">
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2Icon className="size-4 animate-spin" />
          Saving
        </span>
      ) : saved ? (
        <span className="inline-flex items-center gap-1.5">
          <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
          {savedLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The pause before something that takes access away or throws work out.
 *
 * Every such action in Settings goes through this, so removing a teammate,
 * dropping an operator number and deleting a scheduled email all ask the same
 * way. The confirm button is large and says what it will do by name; Cancel is
 * quiet, because backing out should be the easy path.
 */
export function ConfirmModal({
  open,
  title,
  description,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  elevated = false,
  requireText,
}: {
  open: boolean;
  title: string;
  /** The one-line reassurance under the title. */
  description: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  /** Raise above the modal that asked (see `SwipeUpModal`). */
  elevated?: boolean;
  /**
   * For what cannot be undone: the confirm stays disabled until this exact
   * text (a company name) is typed.
   */
  requireText?: string;
}) {
  const [typed, setTyped] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTyped("");
  }
  const locked = requireText !== undefined && typed.trim() !== requireText.trim();
  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      className="max-w-md"
      elevated={elevated}
    >
      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="text-[0.95rem] leading-relaxed text-muted-foreground">
          {body}
        </p>

        {requireText !== undefined && (
          <SettingsField label={`Type ${requireText} to confirm`}>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={MODAL_CONTROL}
              autoComplete="off"
            />
          </SettingsField>
        )}

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="lg"
            className="h-12 w-full text-base"
            disabled={locked}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className={cn("w-full", MODAL_CONTROL)}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    </SwipeUpModal>
  );
}
