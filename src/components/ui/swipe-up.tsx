"use client";

import { motion } from "framer-motion";

/**
 * The app's one arrival animation for a screen of content: it rises into place
 * as it fades in, and leaves upward.
 *
 * Every signed-out and onboarding hand-off uses it, so the whole path reads as
 * one continuous movement rather than a series of cuts — sign-up to the
 * verification wall, step to step through onboarding, the recovery panel turning
 * into its "link sent" answer. Keep the numbers here rather than re-typing them
 * per screen; two screens moving 24px and 32px look like a bug nobody can name.
 *
 * `direction="left"` is the same motion turned sideways, for a step WITHIN a
 * screen that is a move forward rather than a new arrival: the answer to a
 * search slides in from the right as the form slides out to the left.
 *
 * Give it a `key` that changes when the content does (the step name, the pane)
 * — that remount is what replays the entrance. Wrap it in `<AnimatePresence
 * mode="wait">` where the outgoing content should leave first.
 */
const DISTANCE = 28;

const TRANSITION = { duration: 0.34, ease: [0.22, 1, 0.36, 1] } as const;

export type SwipeDirection = "up" | "left";

const VARIANTS: Record<
  SwipeDirection,
  { initial: Record<string, number>; animate: Record<string, number>; exit: Record<string, number> }
> = {
  up: {
    initial: { y: DISTANCE, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: -DISTANCE, opacity: 0 },
  },
  left: {
    initial: { x: DISTANCE, opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: -DISTANCE, opacity: 0 },
  },
};

/** The upward variant's values, for a component animating without this wrapper. */
export const SWIPE_UP = { ...VARIANTS.up, transition: TRANSITION } as const;

export function SwipeUp({
  children,
  className,
  direction = "up",
}: {
  children: React.ReactNode;
  className?: string;
  direction?: SwipeDirection;
}) {
  const variant = VARIANTS[direction];
  return (
    <motion.div
      initial={variant.initial}
      animate={variant.animate}
      exit={variant.exit}
      transition={TRANSITION}
      className={className}
    >
      {children}
    </motion.div>
  );
}
