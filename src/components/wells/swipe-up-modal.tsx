"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeftIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAiDrawer } from "@/lib/ai/use-ai-drawer";

/*
 * ---------------------------------------------------------------------------
 * WHICH MODAL IS ON TOP — a registry of the open instances, in opening order.
 * ---------------------------------------------------------------------------
 *
 * Each modal paints its own dim + blur, and those COMPOUND. Two stacked make
 * the page 75% black instead of 50%, three make it 87.5% and blur the blur; on
 * Scout, where a well opens a lease opens an operator, the map disappears.
 *
 * So exactly one backdrop is painted at a time: the topmost open one. The rest
 * stay in the DOM (they still animate, and they still hold their card up) but
 * render transparent, and they are fully covered by the top one anyway.
 *
 * It is a module-level stack rather than a context because these modals do not
 * nest in the tree — Scout renders its three as siblings and lets state decide
 * which are open — so there is no provider that could see all of them.
 *
 * The same stack answers Escape. Every open modal binds its own key handler, so
 * without this one keypress closed the whole pile instead of peeling one layer.
 */
const openModals: symbol[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}
function pushModal(id: symbol) {
  if (openModals.includes(id)) return;
  openModals.push(id);
  notify();
}
function dropModal(id: symbol) {
  const i = openModals.indexOf(id);
  if (i === -1) return;
  openModals.splice(i, 1);
  notify();
}
function subscribeModals(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
/** Identity, not index: it is compared against this instance's own id. */
function topModal(): symbol | null {
  return openModals[openModals.length - 1] ?? null;
}

/*
 * ---------------------------------------------------------------------------
 * THE MOTION — the same curve the GSAP version drew, in framer-motion terms.
 * ---------------------------------------------------------------------------
 *
 * These beziers are the GSAP eases this replaced, so the modal moves exactly as
 * it always has: the card rises on a quart-out over half a second and drops back
 * on a faster quart-in, while the backdrop fades on a cubic-out under it. Both
 * tweens start together, which is what makes the dim read as the card's own
 * shadow arriving rather than a separate curtain.
 *
 * The card's variant names are driven from its parent layer, so one
 * `AnimatePresence` decides mount and unmount for the pair.
 */
const EASE_OUT_QUART = [0.165, 0.84, 0.44, 1] as const;
const EASE_IN_QUART = [0.895, 0.03, 0.685, 0.22] as const;
const EASE_OUT_CUBIC = [0.215, 0.61, 0.355, 1] as const;
const EASE_OUT_QUAD = [0.25, 0.46, 0.45, 0.94] as const;

const BACKDROP_VARIANTS = {
  hidden: { opacity: 0, transition: { duration: 0.25, ease: EASE_OUT_QUAD } },
  visible: { opacity: 1, transition: { duration: 0.3, ease: EASE_OUT_CUBIC } },
};

const CARD_VARIANTS = {
  hidden: {
    y: "100%",
    opacity: 0,
    transition: { duration: 0.35, ease: EASE_IN_QUART },
  },
  visible: {
    y: "0%",
    opacity: 1,
    transition: { duration: 0.5, ease: EASE_OUT_QUART },
  },
};

/**
 * A bottom-anchored card that swipes up into a vertically-centered position,
 * over a darkened + blurred backdrop. Rendered via a portal so the fixed
 * overlay escapes the page's query-container.
 *
 * Safe to stack: see the registry above for what the second and third one do.
 */
export function SwipeUpModal({
  open,
  onClose,
  title,
  description,
  className,
  headerAction,
  onBack,
  elevated = false,
  inline = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  className?: string;
  /** Optional control rendered in the header, left of the close button. */
  headerAction?: React.ReactNode;
  /**
   * A step back, for modals that stack (Recon's dossiers). When set, a Back
   * button sits at the header's left, and Escape and a backdrop click go back
   * one step instead of calling `onClose`, which then means "close them all".
   */
  onBack?: () => void;
  /** Raise above another SwipeUpModal (for a stacked/nested modal) so its
   * backdrop dims + blurs the modal beneath it. */
  elevated?: boolean;
  /**
   * Render the content in place — no portal, backdrop, or title bar.
   *
   * This is what lets a form that IS a modal everywhere else (tank settings,
   * well info) be a TAB inside another surface without a second copy of the
   * form existing. The host supplies the frame and the heading; the form keeps
   * its fields, its draft state, and its submit row.
   */
  inline?: boolean;
  children: React.ReactNode;
}) {
  // Held true from the moment it opens until the exit animation has finished,
  // so the portal exists for the whole closing tween and nothing is in the DOM
  // outside it. Starting false is also what keeps the portal off the server.
  const [mounted, setMounted] = useState(false);
  // One identity per instance, for as long as it lives. State rather than a
  // ref because it is read during render, to compare against the stack's top.
  const [id] = useState(() => Symbol("swipe-up-modal"));

  // Registered on `open`, not on `mounted`: a modal playing its closing
  // animation is on the way out and must hand the backdrop over immediately.
  useEffect(() => {
    if (open && !inline) pushModal(id);
    else dropModal(id);
    return () => dropModal(id);
  }, [open, inline, id]);

  const isTop =
    useSyncExternalStore(subscribeModals, topModal, () => null) === id;

  /*
   * SCOUT KEEPS ORION USABLE. Everywhere else a modal is the whole task, so the
   * backdrop covers the viewport and the drawer dims with the rest of the page.
   * On Scout the modal IS the task — a permit, a lease, an operator dossier —
   * and Orion is the copilot you read it with, so the backdrop stops at the
   * drawer's left edge instead of blurring the thing you are typing into.
   *
   * An inset, not a z-index: `backdrop-filter` blurs whatever is behind the
   * element's own BOX, so the only way to leave the drawer sharp is to not
   * cover it. That also leaves it clickable, and keeps a click on it from
   * hitting the backdrop's dismiss handler.
   */
  const pathname = usePathname();
  const drawerOpen = useAiDrawer((s) => s.open);
  const drawerWidth = useAiDrawer((s) => s.width);
  const rightInset =
    drawerOpen && pathname?.startsWith("/prospecting") ? drawerWidth : 0;

  useEffect(() => {
    if (open) {
      setMounted(true);
    }
  }, [open]);

  useEffect(() => {
    // Only the top of the stack answers Escape, so one press peels one layer
    // instead of dismissing every modal underneath it too.
    if (!open || !isTop) {
      return;
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        (onBack ?? onClose)();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, isTop, onClose, onBack]);

  // Inline: no portal, no mount/exit animation, and not on the modal stack —
  // the host owns the frame, the backdrop, and Escape.
  if (inline) {
    return open ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : null;
  }

  if (!mounted) {
    return null;
  }

  return createPortal(
    // One presence for the pair, so the portal is torn down once — on
    // `onExitComplete` — after BOTH the card and its backdrop have left.
    // The two are siblings rather than a wrapped pair because AnimatePresence
    // tracks its DIRECT children by key; a fragment around them would be one
    // unkeyed child and neither would ever play its exit.
    <AnimatePresence
      onExitComplete={() => {
        // Re-checked because a modal reopened mid-close must survive the
        // finishing tween's callback rather than be torn out from under it.
        if (!open) setMounted(false);
      }}
    >
      {/* Tinted only while this is the top modal. The transition matters: the
          outgoing tint fades out over the same 300ms the incoming one fades
          in, so the two cross rather than leaving a bright gap. Crossing peaks
          at ~0.44 combined alpha against a steady 0.5, so the page never gets
          darker than a single backdrop — which is the whole point. */}
      {open ? (
        <motion.div
          key="backdrop"
          variants={BACKDROP_VARIANTS}
          initial="hidden"
          animate="visible"
          exit="hidden"
          onClick={onBack ?? onClose}
          style={{ right: rightInset }}
          className={cn(
            "fixed inset-0 transition-colors duration-300",
            isTop ? "bg-black/50 backdrop-blur-sm" : "bg-transparent",
            elevated ? "z-[110]" : "z-[100]"
          )}
        />
      ) : null}
      {open ? (
        <motion.div
          key="card"
          initial="hidden"
          animate="visible"
          exit="hidden"
          // Centred in what is LEFT of the viewport: a card centred on the
          // whole of it would sit half under the drawer it just made usable.
          style={{ right: rightInset }}
          className={cn(
            "pointer-events-none fixed inset-0 flex items-center justify-center p-4",
            elevated ? "z-[111]" : "z-[101]"
          )}
        >
          {/* This layer is only a position; the card is what moves, so its
              100% is its own height rather than the viewport's. It takes the
              variant NAMES from the layer above, which is how one presence
              drives a child that is not its direct subject. */}
          <motion.div
            variants={CARD_VARIANTS}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn(
              "pointer-events-auto flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-md bg-card text-card-foreground shadow-2xl ring-1 ring-foreground/10",
              className
            )}
          >
            <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
              {onBack ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back"
                  className="-ml-2 shrink-0"
                  onClick={onBack}
                >
                  <ChevronLeftIcon />
                </Button>
              ) : null}
              <div className="mr-auto flex flex-col gap-0.5">
                <h2 className="font-heading text-lg font-semibold tracking-tight">
                  {title}
                </h2>
                {description ? (
                  <p className="text-sm text-muted-foreground">{description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {headerAction}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  onClick={onClose}
                >
                  <XIcon />
                </Button>
              </div>
            </div>
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}
