"use client";

import { animate, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useRef, type RefObject } from "react";

/**
 * Auto-grows an Orion composer's textarea and unrolls its shell from a pill into
 * a rounded rectangle as the text wraps.
 *
 * The height is a motion value rather than a style assignment, and the corner
 * radius is DERIVED from it. That pairing is the point. Setting the height
 * directly can't be transitioned — measuring requires `height:auto` and a
 * `scrollHeight` read, and the forced recalc in between makes `auto` the
 * transition's start value — so the box used to snap to its new height while the
 * corners eased on a separate 150ms clock underneath it. Animating toward the
 * measured number instead sidesteps the measurement entirely, and taking the
 * radius off the same value means the two can't disagree: the pill is exactly as
 * unrolled as the box is tall, at every frame.
 *
 * Radius runs from half the shell's resting height (a true pill, whatever that
 * height happens to be) to `rounded-2xl`, over the first line of growth.
 *
 * `data-expanded` survives for the parts that really are binary — the row
 * bottom-aligning so the send button sits beside the last line, and the caller
 * forcing the rectangle when attachment chips are stacked above the input. It
 * stays an attribute rather than React state because it's written on every
 * keystroke, and a state hop would re-render the whole chat to move a flexbox
 * alignment.
 */

/** Matches `rounded-2xl`, the shell's expanded radius. */
const EXPANDED_RADIUS_PX = 16;

/**
 * Extra vertical padding the shell opens by, on top of whatever its class sets.
 * Both variants used to step by this much (`py-2`→`py-3`, `py-1`→`py-2`); it's a
 * constant here so the two can't drift, and so it can ride the same curve as the
 * radius instead of snapping at the wrap threshold.
 *
 * There is deliberately no horizontal equivalent. Moving the side padding
 * changes the textarea's width, which changes where the text wraps, which can
 * change whether it's expanded at all.
 */
const EXPANDED_PAD_Y_PX = 4;

/**
 * A tween, not a spring. A spring is only guaranteed not to overshoot when it
 * starts from rest, and this one rarely does: every keystroke re-aims it, so a
 * fast typist hands the next animation the previous one's velocity and the box
 * sails past the height it was measured to. On a composer docked to the bottom
 * of the screen that overshoot is the top edge bouncing.
 *
 * Long enough to read as motion rather than a jump, and heavily decelerated so
 * most of the distance is covered early and the last few pixels drift in. A
 * shorter curve on a ~27px move lands hard enough to look like a step.
 */
const SHAPE_EASE = {
  duration: 0.24,
  ease: [0.32, 0.72, 0, 1],
} as const;

type Metrics = {
  /** Height of a single-line textarea, its own padding included. */
  oneLine: number;
  /** One line of growth, in px — the distance the radius unrolls over. */
  lineHeight: number;
  /** Half the shell's height with the input at one line. */
  restRadius: number;
  /** The shell's vertical padding as its class sets it, before we open it. */
  restPadY: number;
  /** The height last aimed at, so a re-run can tell a real move from a keystroke. */
  target: number;
  /** The last forced-open value sent, for the same reason. */
  forcedTo: number;
  ready: boolean;
  /** The nodes the last pass measured, to catch a shell swap. */
  el: HTMLTextAreaElement | null;
  shell: HTMLDivElement | null;
};

export function useComposerShape({
  textareaRef,
  shellRef,
  value,
  maxHeight,
  forceExpanded = false,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  shellRef: RefObject<HTMLDivElement | null>;
  /** The current input text — the trigger to re-measure. */
  value: string;
  /** Cap on the textarea's grown height, in px. */
  maxHeight: number;
  /** Force the rectangle regardless of line count (e.g. attachments present). */
  forceExpanded?: boolean;
}): void {
  const height = useMotionValue(0);
  /** 0 while the line count owns the shape, 1 once the caller forces it open. */
  const forced = useMotionValue(0);
  const metrics = useRef<Metrics>({
    oneLine: 0,
    lineHeight: 0,
    restRadius: 9999,
    restPadY: 0,
    target: 0,
    forcedTo: 0,
    ready: false,
    el: null,
    shell: null,
  });
  /** Bumped per measuring pass, so a settled animation can tell it isn't stale. */
  const passRef = useRef(0);

  /**
   * 0 pill, 1 rectangle, continuous in between: how far into its first line of
   * growth the box is, or 1 outright once the caller forces it open. Everything
   * that changes shape hangs off this one number so nothing can run on its own
   * clock and slide against the rest.
   */
  const progress = useTransform<number, number>([height, forced], ([h, f]) => {
    const m = metrics.current;
    if (!m.ready) return f;
    const grown = m.lineHeight > 0 ? (h - m.oneLine) / m.lineHeight : 0;
    return Math.min(1, Math.max(f, Math.max(0, grown)));
  });

  const radius = useTransform(
    progress,
    (t) =>
      metrics.current.restRadius +
      (EXPANDED_RADIUS_PX - metrics.current.restRadius) * t
  );

  const padY = useTransform(
    progress,
    (t) => metrics.current.restPadY + EXPANDED_PAD_Y_PX * t
  );

  // Subscribe first, so the measuring pass below can't emit into a void. The
  // nodes are read inside the callbacks, never captured: two of the three
  // composers swap the landing shell for the docked one on the first message,
  // and a captured element would leave every frame after that painting into a
  // node that is no longer on the page.
  useEffect(() => {
    const stopHeight = height.on("change", (v) => {
      const el = textareaRef.current;
      if (el) el.style.height = `${v}px`;
    });
    const stopRadius = radius.on("change", (v) => {
      const shell = shellRef.current;
      if (shell) shell.style.borderRadius = `${v}px`;
    });
    const stopPad = padY.on("change", (v) => {
      const shell = shellRef.current;
      if (!shell) return;
      shell.style.paddingTop = `${v}px`;
      shell.style.paddingBottom = `${v}px`;
    });
    return () => {
      stopHeight();
      stopRadius();
      stopPad();
    };
  }, [textareaRef, shellRef, height, radius, padY]);

  useEffect(() => {
    const el = textareaRef.current;
    const shell = shellRef.current;
    if (!el || !shell) return;

    const cs = getComputedStyle(el);
    const lineHeight = Number.parseFloat(cs.lineHeight) || 20;
    const padding =
      (Number.parseFloat(cs.paddingTop) || 0) +
      (Number.parseFloat(cs.paddingBottom) || 0);
    const oneLine = lineHeight + padding;

    // Measuring by blanking the height to `auto` and reading `scrollHeight` back
    // forces a synchronous layout on the very element being animated, once per
    // keystroke, mid-flight. That is a dropped frame every character, which is
    // most of what the growth felt like.
    //
    // It's usually unnecessary. `scrollHeight` already reports the full content
    // height whenever the content overflows its box, and a box part-way through
    // growing always overflows. Only when it does NOT overflow does scrollHeight
    // collapse to the box's own height and stop being able to tell us the text
    // shrank — so that is the only case that has to pay for the reflow.
    let natural = el.scrollHeight;
    if (natural <= el.clientHeight + 0.5) {
      const held = el.style.height;
      el.style.height = "auto";
      natural = el.scrollHeight;
      el.style.height = held;
    }

    const target = Math.min(natural, maxHeight);

    // The shell's resting height, recovered by subtracting whatever the textarea
    // has grown past one line. Doing it by subtraction rather than by waiting for
    // a settled frame means it's correct mid-animation, and correct on mount even
    // when a draft is restored into an already-wrapped input.
    // ...and by subtracting the padding it has already opened by, since that is
    // now animated too and would otherwise inflate the pill radius mid-move.
    const grownBy = Math.max(0, el.offsetHeight - oneLine);
    const openedBy = 2 * Math.max(0, padY.get() - metrics.current.restPadY);
    const restRadius = Math.max(
      0,
      (shell.offsetHeight - grownBy - openedBy) / 2
    );

    const m = metrics.current;
    // A swapped shell is a fresh mount as far as the shape goes: the new node
    // carries none of the old one's inline height or radius, so animating into
    // it would start from a value it never had.
    const first = !m.ready || m.el !== el || m.shell !== shell;
    m.oneLine = oneLine;
    m.lineHeight = lineHeight;
    m.restRadius = restRadius;
    // Only readable while the node is untouched — every pass after this writes
    // the padding inline, and reading it back would compound.
    if (first) {
      m.restPadY =
        Number.parseFloat(getComputedStyle(shell).paddingTop) || 0;
    }
    m.ready = true;
    m.el = el;
    m.shell = shell;

    // A box part-way through growing is, by definition, shorter than the text it
    // holds, and that is exactly the condition a textarea paints a scrollbar for.
    // So overflow is hidden for the duration of the move and handed back only if
    // the content genuinely outruns the cap, where the scrollbar is real.
    //
    // Only while it MOVES, though. Once the box is pinned at the cap every
    // keystroke re-runs this, and toggling overflow off and on again there would
    // reset scrollTop and yank the view off the caret mid-sentence.
    // Compared against the height last AIMED at, not the height right now. Every
    // keystroke re-runs this, and while an animation is in flight the current
    // height is always some way short of its destination, so testing against it
    // would restart the animation on every character, resetting the ease curve
    // from wherever it had reached and reading as a stutter.
    const capped = natural > maxHeight;
    const retarget = Math.abs(target - m.target) > 0.5;
    const pass = ++passRef.current;

    if (first) {
      // Land on the resting shape rather than animating up to it on mount.
      el.style.overflowY = capped ? "auto" : "hidden";
      height.jump(target);
      el.style.height = `${target}px`;
      // The resting values are written straight, NOT read off `radius`/`padY`.
      // A derived motion value only recomputes when a source changes, and the
      // sources are already sitting at their resting numbers here — so the cached
      // values are the ones from before this pass measured anything, and reading
      // `padY` would paint the shell's padding as the 0 it was initialised with.
      shell.style.borderRadius = `${restRadius}px`;
      shell.style.paddingTop = `${m.restPadY}px`;
      shell.style.paddingBottom = `${m.restPadY}px`;
    } else if (retarget) {
      el.style.overflowY = "hidden";
      // While the box was still short its content overflowed, and the browser
      // may have scrolled to keep the caret in view. Hiding overflow freezes that
      // offset in place, which clips the first line for as long as the growth
      // takes. Anything not headed for the cap settles at 0, so put it there now.
      if (!capped) el.scrollTop = 0;
      animate(height, target, {
        ...SHAPE_EASE,
        onComplete: () => {
          if (passRef.current !== pass || metrics.current.el !== el) return;
          if (!capped) return;
          el.style.overflowY = "auto";
          // Hiding overflow parked scrollTop at 0. The box only reaches its cap
          // by being typed into, so the bottom is where the caret is.
          el.scrollTop = el.scrollHeight;
        },
      });
    } else if (capped) {
      el.style.overflowY = "auto";
    }

    // Half a line of slack so sub-pixel line-height rounding can't flip the
    // binary parts while the user is still on line one.
    const wrapped = natural > lineHeight * 1.5 + padding;
    const open = wrapped || forceExpanded;

    const wantForced = forceExpanded ? 1 : 0;
    if (first) forced.jump(wantForced);
    else if (wantForced !== m.forcedTo) animate(forced, wantForced, SHAPE_EASE);

    m.target = target;
    m.forcedTo = wantForced;

    shell.dataset.expanded = String(open);
  }, [
    textareaRef,
    shellRef,
    value,
    maxHeight,
    forceExpanded,
    height,
    forced,
    radius,
    padY,
  ]);
}
