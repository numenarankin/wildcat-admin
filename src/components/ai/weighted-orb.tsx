"use client";

import { useEffect, useRef } from "react";
import {
  MODE_DRAWS,
  resolvePreset,
  type OrbSize,
  type OrbState,
} from "thinking-orbs";

/**
 * `<ThinkingOrb>` with a heavier stroke.
 *
 * The shipped component has no dot-weight prop — the two sizes (64 / 20) are
 * hand-tuned designs, not knobs. But the library also exports its internals:
 * `resolvePreset(state, size)` hands back the mode + fully-scaled draw options,
 * and `MODE_DRAWS[mode]` is the frame painter. Every mode derives a dot's radius
 * as `(rBase + rDepth * depth + rActive * active) * sizeScale`, so scaling those
 * three (and the `rMin` floor) thickens the ink without touching the geometry,
 * the dot count, or the timing.
 *
 * What this re-implements — and therefore what it gives up versus the stock
 * component: the shared cross-instance clock, `IntersectionObserver` pausing
 * offscreen, and the live theme `MutationObserver`. Theme is resolved per frame
 * from the `.dark` class instead (cheap, and it tracks a theme switch), and
 * reduced-motion still paints a single static frame. That's an acceptable trade
 * for an indicator that only exists while a request is in flight; if the weight
 * stops being worth it, drop this and go back to `<ThinkingOrb>`.
 */
export function WeightedOrb({
  state,
  size,
  displaySize,
  weight = 1,
  speed = 1,
  className,
  ariaLabel,
}: {
  state: OrbState;
  /** Only 64 and 20 exist as tuned presets. */
  size: OrbSize;
  /**
   * Render the tuned `size` design at this CSS pixel size instead.
   *
   * Scaling a canvas DOWN with a CSS transform only adds effective resolution,
   * which is why `/orion` can put the 64 design in a 48px box and stay crisp.
   * Scaling UP that way does the opposite — it magnifies a 64px raster and goes
   * soft, which is very visible on a 200px+ orb. So instead of transforming the
   * element, this raises the backing store to `displaySize * dpr` and scales the
   * drawing context to match, painting the same 64-unit geometry at full device
   * resolution. Dot count, spacing, weights and timing are untouched: it is the
   * same tuned design, rasterized larger.
   */
  displaySize?: number;
  /** Multiplier on every dot radius. 1 = the stock look. */
  weight?: number;
  /** Multiplier on the preset's baked speed. */
  speed?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cssSize = displaySize ?? size;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const preset = resolvePreset(state, size);
    const draw = MODE_DRAWS[preset.mode];
    const opts = {
      ...preset.opts,
      rBase: (preset.opts.rBase ?? 0.6) * weight,
      rDepth: (preset.opts.rDepth ?? 1.7) * weight,
      rActive: (preset.opts.rActive ?? 0.3) * weight,
      rMin: (preset.opts.rMin ?? 0.3) * weight,
    };

    // Match the library: device-pixel-ratio capped at 2, draw in CSS pixels.
    // `scale` carries the preset's coordinate space up to the display size so
    // the raster is generated at full resolution rather than magnified.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = cssSize / size;
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);

    const isDark = () =>
      document.documentElement.classList.contains("dark") ||
      canvas.closest(".dark") !== null;

    const paint = (t: number) => {
      // Cleared in the transformed space, so still the preset's own units.
      ctx.clearRect(0, 0, size, size);
      draw(ctx, size, t, isDark(), opts);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // A single representative frame, no animation — same contract as the
      // library's reduced-motion path.
      paint(0.5);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      paint(((now - start) / 1000) * preset.speed * speed);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state, size, cssSize, weight, speed]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ width: cssSize, height: cssSize }}
    />
  );
}
