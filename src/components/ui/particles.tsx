"use client";

import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface ParticlesProps {
  className?: string;
  /** Number of particles. */
  quantity?: number;
  /** How strongly particles resist the cursor (higher = stiffer). */
  staticity?: number;
  /** Cursor follow easing (higher = slower catch-up). */
  ease?: number;
  /** Particle radius scale. */
  size?: number;
  /** Hex color, e.g. "#666666". */
  color?: string;
}

interface Circle {
  x: number;
  y: number;
  translateX: number;
  translateY: number;
  size: number;
  alpha: number;
  targetAlpha: number;
  dx: number;
  dy: number;
  magnetism: number;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Animated particle field on a canvas, drifting and parallaxing toward the
 * cursor. Self-contained (no external deps) — used as the backdrop on the auth
 * page. Reproduces the magicui Particles look from the @efferd/auth-1 block.
 */
export function Particles({
  className,
  quantity = 100,
  staticity = 50,
  ease = 50,
  size = 0.5,
  color = "#666666",
}: ParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const circlesRef = useRef<Circle[]>([]);
  const mouseRef = useRef({ x: 0, y: 0 });
  const canvasSizeRef = useRef({ w: 0, h: 0 });
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const rgb = hexToRgb(color);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = contextRef.current;
    if (!canvas || !container || !ctx) return;
    const w = container.offsetWidth;
    const h = container.offsetHeight;
    canvasSizeRef.current = { w, h };
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);
  }, [dpr]);

  const newCircle = useCallback((): Circle => {
    const { w, h } = canvasSizeRef.current;
    return {
      x: Math.floor(Math.random() * w),
      y: Math.floor(Math.random() * h),
      translateX: 0,
      translateY: 0,
      size: Math.floor(Math.random() * 2) + size,
      alpha: 0,
      targetAlpha: parseFloat((Math.random() * 0.6 + 0.2).toFixed(1)),
      // Continuous drift so the field visibly animates at rest (not just on
      // cursor movement).
      dx: (Math.random() - 0.5) * 0.6,
      dy: (Math.random() - 0.5) * 0.6,
      magnetism: 0.1 + Math.random() * 4,
    };
  }, [size]);

  const drawCircle = useCallback(
    (circle: Circle) => {
      const ctx = contextRef.current;
      if (!ctx) return;
      const { x, y, translateX, translateY, size: s, alpha } = circle;
      ctx.translate(translateX, translateY);
      ctx.beginPath();
      ctx.arc(x, y, s, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
      ctx.fill();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    [dpr, rgb]
  );

  const initCanvas = useCallback(() => {
    resizeCanvas();
    circlesRef.current = Array.from({ length: quantity }, () => newCircle());
  }, [resizeCanvas, quantity, newCircle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    contextRef.current = canvas.getContext("2d");
    initCanvas();

    let raf = 0;
    const animate = () => {
      const ctx = contextRef.current;
      const { w, h } = canvasSizeRef.current;
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      circlesRef.current.forEach((circle) => {
        // Fade in to target alpha.
        circle.alpha = Math.min(circle.alpha + 0.02, circle.targetAlpha);
        circle.x += circle.dx;
        circle.y += circle.dy;
        // Parallax toward the cursor.
        circle.translateX +=
          (mouseRef.current.x / (staticity / circle.magnetism) -
            circle.translateX) /
          ease;
        circle.translateY +=
          (mouseRef.current.y / (staticity / circle.magnetism) -
            circle.translateY) /
          ease;

        // Wrap around the edges.
        if (circle.x < -circle.size) circle.x = w + circle.size;
        if (circle.x > w + circle.size) circle.x = -circle.size;
        if (circle.y < -circle.size) circle.y = h + circle.size;
        if (circle.y > h + circle.size) circle.y = -circle.size;

        drawCircle(circle);
      });

      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => initCanvas();
    window.addEventListener("resize", onResize);

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const { w, h } = canvasSizeRef.current;
      const x = e.clientX - rect.left - w / 2;
      const y = e.clientY - rect.top - h / 2;
      mouseRef.current = { x, y };
    };
    window.addEventListener("mousemove", onMouseMove);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, [initCanvas, drawCircle, staticity, ease]);

  return (
    <div ref={containerRef} className={cn("pointer-events-none", className)} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  );
}
