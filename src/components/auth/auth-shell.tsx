"use client";

import Image from "next/image";
import { AnimatePresence } from "framer-motion";
import { Particles } from "@/components/ui/particles";
import { SwipeUp } from "@/components/ui/swipe-up";


/**
 * The signed-out page frame: particle field, logo, heading, and a single
 * centered column.
 *
 * Extracted from `auth-page` when the password-reset screens arrived, so that
 * every signed-out page is the same page with different contents rather than
 * three near-copies of the same markup drifting apart. `/auth/*` is a bare route
 * in `app-shell`, so nothing else wraps these.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  pane,
  brand = true,
  banner,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  /**
   * Answer to something the user just did elsewhere — today, "Email confirmed"
   * after a verification link. Rendered ABOVE the wordmark on purpose: it is
   * the reason they are looking at this screen, so it reads before the
   * branding rather than after the form.
   */
  banner?: React.ReactNode;
  /**
   * Show the logo and wordmark. Off for a pane that lasts a moment (the reset
   * link being checked), where branding a spinner makes a page out of a pause.
   */
  brand?: boolean;
  /**
   * Which panel this is. Changing it replays the arrival animation, for the
   * views that swap in place instead of navigating (sign in ↔ sign up ↔
   * recovery). Omit where the screen only ever shows one thing.
   */
  pane?: string;
}) {
  return (
    <div className="relative w-full md:h-screen md:overflow-hidden">
      <Particles
        className="absolute inset-0"
        color="#666666"
        ease={20}
        quantity={120}
      />
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-8">
        <AnimatePresence mode="wait">
          <SwipeUp key={pane} className="mx-auto space-y-6 sm:w-sm">
            {banner}
            {brand && (
              <div className="flex items-center gap-2.5">
                <Image
                  src="/slim_normal.png"
                  alt="WildcatIQ logo"
                  width={32}
                  height={32}
                  className="size-8"
                />
                <span className="text-3xl font-bold tracking-tight text-foreground">
                  WildcatIQ
                </span>
              </div>
            )}
            <div className="flex flex-col space-y-1">
              <h1 className="font-bold text-2xl tracking-wide">{title}</h1>
              <p className="text-base text-muted-foreground">{subtitle}</p>
            </div>
            {children}
          </SwipeUp>
        </AnimatePresence>
      </div>
    </div>
  );
}
