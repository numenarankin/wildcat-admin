"use client";

import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { OrbState } from "thinking-orbs";
import { Button } from "@/components/ui/button";
import { WeightedOrb } from "@/components/ai/weighted-orb";
import type {
  VoiceStatus,
  VoiceTurn,
} from "@/lib/ai/use-voice-conversation";
import type { PendingApproval } from "@/components/ai/tool-approval";
import { voiceStatusLabel } from "@/components/ai/voice-chat-ui";
import { OrionChart } from "@/components/ai/orion-chart";
import { ApprovalCard } from "@/components/ai/tool-approval";
import { cn } from "@/lib/utils";

/**
 * Full-screen hands-free Orion.
 *
 * Voice is a different posture from the typed drawer: the user is usually not
 * looking at a keyboard, often not close to the screen, and the screen's whole
 * job is to show what was just said. So this takes over the viewport, blurs
 * whatever was behind it, and reduces to two things — a large orb and the words,
 * set at subtitle size so they read from arm's length.
 *
 * Orb state carries the turn, so the user knows whether Orion is listening or
 * working without reading a label:
 *   - `connecting` while thinking (a request is in flight);
 *   - `composing` at rest, while listening, and while speaking.
 */

/** The tuned 64 preset, rasterized large. See WeightedOrb#displaySize. */
const ORB_DISPLAY_SIZE = 128;
/** House weight, matching /orion and the drawer indicator. */
const ORB_WEIGHT = 1.55;

/** How long the dissolve runs; must match the CSS animation duration. */
const ORB_FADE_MS = 450;

function orbStateFor(status: VoiceStatus): OrbState {
  switch (status) {
    case "thinking":
      return "solving";
    case "speaking":
      return "connecting";
    // listening, and idle as its resting form
    default:
      return "working";
  }
}

/**
 * Cross-dissolves between orb designs on a state change.
 *
 * Each `OrbState` is a different mode with its own geometry, so swapping the
 * prop snaps hard. Instead the outgoing design is kept mounted for one animation
 * and both layers are stacked: old fades out and expands slightly, new fades in
 * from slightly small, which reads as one orb changing rather than two swapping.
 */
function CrossfadeOrb({
  state,
  label,
}: {
  state: OrbState;
  label: string;
}) {
  const [shown, setShown] = useState(state);
  const [outgoing, setOutgoing] = useState<OrbState | null>(null);

  // Adjusted during render, not in an effect: this is derived-from-props state,
  // and setting it in an effect would render the new orb once un-animated before
  // the crossfade started (as well as tripping the cascading-render rule).
  if (shown !== state) {
    setOutgoing(shown);
    setShown(state);
  }

  // Retiring the outgoing layer IS a timer side effect, so it belongs here. The
  // setState runs in the timeout callback, not synchronously in the effect body.
  useEffect(() => {
    if (!outgoing) return;
    const t = setTimeout(() => setOutgoing(null), ORB_FADE_MS);
    return () => clearTimeout(t);
  }, [outgoing]);

  const common = {
    size: 64 as const,
    displaySize: ORB_DISPLAY_SIZE,
    weight: ORB_WEIGHT,
  };

  return (
    // Opacity lives on the wrapper so the layer animations can run 0 -> 1
    // without fighting it.
    <div
      className="relative opacity-60"
      style={{ width: ORB_DISPLAY_SIZE, height: ORB_DISPLAY_SIZE }}
    >
      {outgoing && (
        <WeightedOrb
          key={`out-${outgoing}`}
          {...common}
          state={outgoing}
          className="absolute inset-0 animate-orb-out"
          ariaLabel=""
        />
      )}
      <WeightedOrb
        key={`in-${shown}`}
        {...common}
        state={shown}
        className="absolute inset-0 animate-orb-in"
        ariaLabel={label}
      />
    </div>
  );
}

/**
 * PRESENTATIONAL ONLY — it does not run `useVoiceConversation`.
 *
 * Three surfaces can host voice (the app-shell controller, the Orion drawer, and
 * the /orion page) and exactly one may run the mic loop at a time. If this
 * component owned the hook, whichever host mounted it would start a second loop
 * alongside its own. So the host runs the loop and passes the state down.
 */
export interface VoiceOverlayProps {
  status: VoiceStatus;
  error?: string | null;
  lastUser?: string;
  liveReply?: string;
  liveActive?: boolean;
  turns?: VoiceTurn[];
  pendingApprovals?: PendingApproval[];
  respondToApproval?: (id: string, approved: boolean) => void;
  onClose?: () => void;
}

export function VoiceOverlay({
  status,
  error,
  lastUser = "",
  liveReply = "",
  liveActive = false,
  turns = [],
  pendingApprovals = [],
  respondToApproval,
  onClose,
}: VoiceOverlayProps) {
  const captionRef = useRef<HTMLDivElement>(null);

  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const lastAssistantCharts = lastAssistant?.charts;

  // `liveActive` is set the moment the user's transcript lands and stays true
  // until the turn commits, so it — NOT `status` — is the right gate for "a turn
  // is in flight". Gating on `status === "listening"` was wrong: transcription
  // finishes as status flips to `thinking`, so the user's own words vanished
  // exactly when there was nothing else to show and the PREVIOUS answer took
  // their place.
  const userLine = liveActive ? lastUser : "";
  // Their words stay on screen through thinking and while the reply streams in
  // beneath, so the exchange reads as a pair rather than swapping under them.
  const replyLine = liveActive ? liveReply : (lastAssistant?.text ?? "");
  const showPlaceholder = !userLine && !replyLine;

  // Keep the newest words in view as they stream in.
  useEffect(() => {
    const el = captionRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [userLine, replyLine]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Orion voice mode"
      className={cn(
        "fixed inset-0 z-50 flex flex-col",
        // The blur is the point: whatever the user was looking at stays legible
        // as context but recedes, so the orb and the words own the screen.
        "bg-background/70 backdrop-blur-2xl"
      )}
    >
      <header className="flex h-14 shrink-0 items-center justify-end px-4">
        {onClose && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Exit voice mode"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-10 px-6 pb-4">
        <div className="flex shrink-0 flex-col items-center gap-4">
          {/* Dimmed: the orb signals state, the words carry the content. At
              full strength it competes with the subtitles for attention. */}
          <CrossfadeOrb
            state={orbStateFor(status)}
            label={`Orion is ${voiceStatusLabel(status).toLowerCase()}`}
          />
          <span
            aria-live="polite"
            className="ty-caption font-medium tracking-wide text-tertiary-text uppercase"
          >
            {voiceStatusLabel(status)}
          </span>
        </div>

        {/* Subtitles. Large and medium-weight so they read at a distance, capped
            in width so long answers wrap into readable lines rather than
            stretching across a wide monitor. */}
        <div
          ref={captionRef}
          className="flex w-full max-w-3xl flex-col gap-4 text-center"
        >
          {/* The user's own words, shown as soon as they are transcribed and
              held through thinking and the reply. Smaller and dimmer than the
              answer so the pair reads as question-then-answer at a glance. */}
          {userLine && (
            // Keyed on the utterance so it animates once when the turn starts,
            // not on every streamed token.
            <p
              key={`user-${userLine}`}
              className={cn(
                "animate-caption-in text-[1.25rem] leading-[1.875rem] font-medium text-balance transition-colors",
                status === "listening" ? "text-data-accent" : "text-tertiary-text"
              )}
            >
              {userLine}
            </p>
          )}

          {replyLine && (
            // Keyed on the TURN (via the user's utterance), not the reply text —
            // keying on the text would re-run the animation on every token and
            // strobe while streaming.
            <p
              key={`reply-${userLine}`}
              className="animate-caption-in text-[1.75rem] leading-[2.5rem] font-medium text-balance text-primary-text"
            >
              {replyLine}
            </p>
          )}

          {showPlaceholder && (
            <p className="text-[1.75rem] leading-[2.5rem] font-medium text-balance text-tertiary-text">
              Start talking. Talk over me to interrupt.
            </p>
          )}
        </div>

        {lastAssistantCharts && lastAssistantCharts.length > 0 && (
          <div className="w-full max-w-3xl shrink-0">
            {/* Spoken replies never describe a chart, so anything Orion drew has
                to be visible here or it is lost in hands-free mode. */}
            {lastAssistantCharts.map((spec, i) => (
              <OrionChart key={`chart-${i}`} spec={spec} surface="voice" />
            ))}
          </div>
        )}

        {pendingApprovals.length > 0 && (
          <div className="flex w-full max-w-xl shrink-0 flex-col gap-2">
            {pendingApprovals.map((req) => (
              <ApprovalCard
                key={req.id}
                request={req}
                onApprove={() => respondToApproval?.(req.id, true)}
                onDeny={() => respondToApproval?.(req.id, false)}
              />
            ))}
          </div>
        )}

        {error && (
          <div className="ty-body-1 max-w-xl shrink-0 rounded-lg bg-error/10 px-4 py-2 text-center text-error">
            {error}
          </div>
        )}
      </div>

    </div>
  );
}
