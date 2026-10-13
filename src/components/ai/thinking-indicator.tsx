"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowNarrowRight } from "@untitledui/icons";
import { WeightedOrb } from "@/components/ai/weighted-orb";
import { TextShimmer } from "@/components/ui/text-shimmer";

/**
 * What Orion shows between "sent" and the first streamed token: a dotted
 * thought-orb beside a shimmering "Thinking…", with what it's doing listed
 * underneath as each tool fires.
 *
 * The lines are plain English ("Pulling production numbers"), not tool names —
 * see `lib/ai/tool-activity.ts`. Callers pass finished labels; this component
 * does no name translation of its own.
 *
 * Shared by the /orion page and the drawer so the two surfaces can't drift. The
 * only difference is scale: the library ships exactly two hand-tuned orb designs
 * (64 for chat-avatar scale, 20 for inline), and this picks the surrounding
 * type + spacing to match whichever is used.
 *
 * Layout note: the orb and label sit in their own fixed-height row so the tool
 * list — which appears and grows as calls fire — can never nudge them.
 */
export function ThinkingIndicator({
  activities,
  size = 64,
  orbWeight,
}: {
  /** Plain-English lines, one per tool call, already translated. */
  activities: string[];
  /** 64 on the full page, 20 in the drawer. */
  size?: 64 | 20;
  /**
   * Dot-radius multiplier. Defaults per size rather than one global number: the
   * 20 design packs fewer, relatively larger dots, so the page's 1.55 turns the
   * small orb into a blob. 1.15 keeps it legible at drawer scale.
   */
  orbWeight?: number;
}) {
  const large = size === 64;
  const weight = orbWeight ?? (large ? 1.55 : 1.15);

  return (
    <div>
      <div className={large ? "flex h-12 items-center gap-3" : "flex items-center gap-2"}>
        {large ? (
          // The 64 design rendered into a 48px box. Scaling a canvas DOWN only
          // adds effective resolution, so it stays crisp.
          <div className="flex size-12 shrink-0 items-center justify-center">
            <WeightedOrb
              state="solving"
              size={64}
              weight={weight}
              ariaLabel="Orion is thinking"
              className="origin-center scale-75 opacity-65"
            />
          </div>
        ) : (
          <WeightedOrb
            state="solving"
            size={20}
            weight={weight}
            ariaLabel="Orion is thinking"
            className="shrink-0 opacity-65"
          />
        )}
        <TextShimmer
          as="span"
          className={large ? "text-[1.0625rem]" : "ty-body-2"}
          duration={2}
        >
          Thinking…
        </TextShimmer>
      </div>
      {activities.length > 0 && (
        // Indented to the label's left edge: orb box + gap.
        <div
          className={`mt-0.5 flex flex-col gap-0.5 ${
            large ? "pl-[3.75rem]" : "pl-7"
          }`}
        >
          <AnimatePresence initial={false}>
            {activities.map((label, i) => (
              <motion.span
                key={`${label}-${i}`}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="flex items-center gap-1.5 text-xs text-tertiary-text/80"
              >
                <ArrowNarrowRight className="size-3.5 shrink-0" />
                {label}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
