"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useVoiceMode } from "@/lib/ai/use-voice-mode";
import {
  useVoiceConversation,
  type VoiceStatus,
} from "@/lib/ai/use-voice-conversation";
import {
  useRealtimeVoice,
  type RealtimeStatus,
} from "@/lib/ai/use-realtime-voice";
import { VoiceOverlay } from "@/components/ai/voice-overlay";
import { useCredits } from "@/components/billing/credits-context";
import { useAiCreditsBlocked } from "@/components/billing/credits-notice";

// Re-exported for existing importers (e.g. the topbar toggle).
export { isVoiceInputSupported } from "@/lib/ai/use-voice-conversation";

/** Routes that own the voice UI themselves (full-page), so the overlay yields. */
function ownsVoiceInline(pathname: string): boolean {
  return pathname === "/orion" || pathname.startsWith("/orion/");
}

/**
 * Hands-free Orion for the whole app. Mounted once in the app shell; runs the
 * shared voice loop as the fallback host and renders the full-screen
 * {@link VoiceOverlay}. This is the surface you get from the topbar mic on any
 * ordinary page.
 *
 * It yields (no mic loop, no overlay) to any surface that renders voice inline:
 * the open Orion drawer, or the full-page /orion chat. Exactly one host runs the
 * loop at a time, which is why the overlay is presentational and takes its state
 * from whichever host is active.
 */
/**
 * Which voice engine runs. Build-time constant, default OFF: the Anthropic
 * cascade is the shipping loop, and the OpenAI Realtime path is experimental —
 * a different model with read-only tools and no approval gate. Set
 * NEXT_PUBLIC_REALTIME_VOICE=true (plus OPEN_AI_KEY server-side) to try it.
 */
const USE_REALTIME = process.env.NEXT_PUBLIC_REALTIME_VOICE === "true";

/**
 * The raw value, captured separately so a diagnostic can tell three different
 * failures apart. `undefined` means the variable was never inlined — the bundle
 * predates the env change, or the build didn't see it — which looks identical
 * to "switched off" once it has been coerced to a boolean. Anything else means
 * the flag arrived and the value itself is the problem.
 */
const REALTIME_FLAG_RAW = process.env.NEXT_PUBLIC_REALTIME_VOICE;

/**
 * One line, on mount, naming which engine this bundle will actually run.
 *
 * Module scope on purpose: it prints when the chunk is evaluated, so a stale
 * compiled bundle says so before any component decides anything. If this line
 * is missing from the console entirely, the browser is running old code and no
 * amount of reading component state will show it.
 */
if (typeof window !== "undefined") {
  console.log("[voice-engine]", {
    engine: USE_REALTIME ? "openai-realtime" : "anthropic-cascade",
    flagRaw: REALTIME_FLAG_RAW ?? "(not inlined — stale bundle or unset at build)",
    builtAt: new Date().toISOString(),
  });
}

/** Realtime's connection states, mapped onto the overlay's vocabulary. */
function overlayStatus(status: RealtimeStatus): VoiceStatus {
  if (status === "connecting") return "thinking";
  if (status === "error") return "idle";
  return status;
}

export function VoiceController() {
  const enabled = useVoiceMode((s) => s.enabled);
  const setEnabled = useVoiceMode((s) => s.setEnabled);
  const pathname = usePathname();
  // Only /orion still owns voice inline (it has its own full-page treatment).
  // The drawer no longer hosts a voice variant: this overlay is full-screen and
  // covers it, so having two hosts would just mean two mic loops.
  const deferred = ownsVoiceInline(pathname);

  // Both hooks are called unconditionally — hooks can't be branched — and each
  // one's own `enabled` decides which engine actually opens a microphone. Only
  // one is ever live, for the same reason the drawer no longer hosts voice.
  const active = enabled && !deferred;

  // Why nothing happened, in one line, every time voice is toggled. `deferred`
  // is the trap worth naming: on /orion this component renders null and that
  // page's own host runs the cascade, so the flag has no effect there no matter
  // how it is set.
  useEffect(() => {
    console.log("[voice-engine] toggle", {
      enabled,
      pathname,
      deferred,
      engine: USE_REALTIME ? "openai-realtime" : "anthropic-cascade",
      running: active
        ? USE_REALTIME
          ? "realtime"
          : "cascade"
        : deferred
          ? "none (this route hosts voice itself)"
          : "none (voice off)",
    });
  }, [enabled, pathname, deferred, active]);

  const { markExhausted, openBuyCredits } = useCredits();
  const creditsBlocked = useAiCreditsBlocked();

  /**
   * Out of credits: end the call, latch the state every other AI surface reads,
   * and put the top-up in front of them. Voice is the surface where a silent
   * refusal is indistinguishable from a broken mic, so it says so and offers
   * the one thing that fixes it.
   */
  const outOfCredits = () => {
    markExhausted();
    setEnabled(false);
    openBuyCredits();
  };

  // Turning voice on with an empty balance: end it before the mic opens and put
  // the top-up in front of them, which is what chat does with the same refusal.
  useEffect(() => {
    if (!enabled || deferred || !creditsBlocked) return;
    setEnabled(false);
    openBuyCredits();
  }, [enabled, deferred, creditsBlocked, setEnabled, openBuyCredits]);

  const cascade = useVoiceConversation({
    // A call that cannot be answered never starts. The balance is already known
    // here, so refusing costs no round trip and no dead overlay.
    enabled: active && !USE_REALTIME && !creditsBlocked,
    onEnd: () => setEnabled(false),
    onOutOfCredits: outOfCredits,
  });
  const realtime = useRealtimeVoice({
    enabled: active && USE_REALTIME && !creditsBlocked,
    onEnd: () => setEnabled(false),
  });

  // The effect above is turning voice off and opening the buy modal; an overlay
  // over a call that is not happening would be a second window on top of it.
  if (!enabled || deferred || creditsBlocked) return null;

  if (USE_REALTIME) {
    return (
      <VoiceOverlay
        status={overlayStatus(realtime.status)}
        error={realtime.error}
        // The far side transcribes a user turn only once it is complete, so
        // there is no partial utterance to show mid-sentence the way the
        // cascade has one; committed turns carry the whole conversation.
        lastUser=""
        liveReply={realtime.liveReply}
        liveActive={realtime.liveReply !== ""}
        turns={realtime.turns}
        // No write tools on this path, so nothing can be pending.
        pendingApprovals={[]}
        respondToApproval={() => {}}
        onClose={() => setEnabled(false)}
      />
    );
  }

  return (
    <VoiceOverlay
      status={cascade.status}
      error={cascade.error}
      lastUser={cascade.lastUser}
      liveReply={cascade.liveReply}
      liveActive={cascade.liveActive}
      turns={cascade.turns}
      pendingApprovals={cascade.pendingApprovals}
      respondToApproval={cascade.respondToApproval}
      onClose={() => setEnabled(false)}
    />
  );
}
