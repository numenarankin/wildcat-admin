"use client";

import React, { useMemo, type JSX } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Text with a highlight sweeping through it — used for transient "working on it"
 * labels (Orion's thinking state).
 *
 * Dropped in from the shadcn-style snippet with two changes:
 *
 * 1. `motion` comes from `framer-motion` (v12) rather than the newer
 *    `motion/react` package, since framer-motion is what the app already bundles.
 * 2. The motion component is read off framer-motion's cached tag proxy
 *    (`motion.span`) instead of being built with `motion.create(Component)` in
 *    the render body. `create` returns a NEW component type on every render, so
 *    React unmounts and remounts the element each time — restarting the shimmer
 *    and dropping any state below it. It's also what `react-hooks/static-components`
 *    flags. The proxy hands back a stable, cached type per tag.
 *
 * Consequence of (2): `as` must be an intrinsic tag (`span`, `p`, `div`, …), not
 * a custom component. That's all this is used for.
 */
/** Intrinsic tags only — see the note on the cached motion proxy above. */
type MotionTag = keyof JSX.IntrinsicElements;

export type TextShimmerProps = {
  children: string;
  as?: MotionTag;
  className?: string;
  duration?: number;
  spread?: number;
  baseColor?: string;
  shimmerColor?: string;
  style?: React.CSSProperties;
};

function TextShimmerComponent({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
  baseColor,
  shimmerColor,
  style,
}: TextShimmerProps) {
  const MotionComponent = (motion as unknown as Record<
    MotionTag,
    React.ElementType
  >)[Component];

  const dynamicSpread = useMemo(() => {
    return children.length * spread;
  }, [children, spread]);

  return (
    <MotionComponent
      className={cn(
        "relative inline-block bg-size-[250%_100%,auto] bg-clip-text",
        "[-webkit-text-fill-color:transparent]",
        "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      animate={{ backgroundPosition: "0% center" }}
      transition={{
        repeat: Infinity,
        duration,
        ease: "linear",
      }}
      style={
        {
          ...style,
          "--spread": `${dynamicSpread}px`,
          "--base-color":
            baseColor ?? "color-mix(in oklab, currentColor 55%, transparent)",
          "--base-gradient-color": shimmerColor ?? "currentColor",
          backgroundImage: `var(--bg), linear-gradient(var(--base-color), var(--base-color))`,
        } as React.CSSProperties
      }
    >
      {children}
    </MotionComponent>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
