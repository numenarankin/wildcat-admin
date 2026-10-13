"use client";

import { useState } from "react";
import type { Completion } from "@/lib/admin/google/gmail/suggest";

/**
 * A one-line input with an inline completion: what the user typed in the
 * normal colour, the suggested tail in grey after it, Tab to accept. The
 * tail is painted in a layer under the input, in the same font, so it sits
 * exactly where the typed text ends. Escape hides the tail until the text
 * changes; any other key just keeps typing.
 */
export function GhostInput({
  value,
  onChange,
  complete,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** The completion for the current value, or null. */
  complete: (value: string) => Completion | null;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestion = value && dismissed !== value ? complete(value) : null;

  return (
    <span className="relative flex h-full min-w-0 flex-1 items-center">
      {suggestion && (
        <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre">
          <span className="invisible">{value}</span>
          <span className="text-muted-foreground/60">{suggestion.tail}</span>
        </span>
      )}
      <input
        {...rest}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (suggestion && (e.key === "Tab" || e.key === "ArrowRight") && e.currentTarget.selectionStart === value.length) {
            e.preventDefault();
            onChange(suggestion.value);
          } else if (suggestion && e.key === "Escape") {
            e.preventDefault();
            setDismissed(value);
          }
          rest.onKeyDown?.(e);
        }}
        autoComplete="off"
        spellCheck={false}
        className={`relative h-full w-full bg-transparent outline-none placeholder:text-muted-foreground ${className ?? ""}`}
      />
    </span>
  );
}
