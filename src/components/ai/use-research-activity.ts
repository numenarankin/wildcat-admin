"use client";

import { useCallback, useState } from "react";

/**
 * What the researchers are doing, for the thinking line.
 *
 * The thinking line is built from the tool-call parts on the assistant message,
 * which works because Orion's own tools run inside the stream. The gather stages
 * do not: they run BEFORE the answering model is called, in their own model
 * loops, and their tool calls are never on the wire. So a turn that dispatched
 * researchers showed a spinning orb and nothing else for as long as they took —
 * up to thirty seconds — and then jumped straight to Orion's own lookups. Silence
 * that long reads as a stalled app, not as work.
 *
 * The route announces them on a transient `data-research` part instead, and this
 * holds the labels until they land.
 *
 * ## Why it clears on `status`, not only on the done part
 *
 * A turn can end without ever sending `phase: "done"` — the user stops it, the
 * connection drops, the stage throws past its own guard. The labels would then
 * sit under the orb for the rest of the session, describing work that is not
 * happening. `status` settling is the backstop, and it cannot be missed.
 */
export interface ResearchActivity {
  /** Present-tense labels for the researchers currently running. */
  activities: string[];
  /** Feed every `onData` part through this. Ignores anything else. */
  onData: (part: { type: string; data?: unknown }) => void;
  /**
   * Drop the labels. The caller wires this to its own turn status.
   *
   * Stable across renders and a no-op when there is nothing to clear, so it is
   * safe as an effect dependency and cannot loop.
   */
  clear: () => void;
}

interface ResearchWire {
  phase: "start" | "done";
  turnId: string;
  activities?: string[];
}

function isWire(data: unknown): data is ResearchWire {
  if (typeof data !== "object" || data === null) return false;
  const phase = (data as { phase?: unknown }).phase;
  return phase === "start" || phase === "done";
}

export function useResearchActivity(): ResearchActivity {
  const [activities, setActivities] = useState<string[]>([]);

  const onData = useCallback((part: { type: string; data?: unknown }) => {
    if (part.type !== "data-research" || !isWire(part.data)) return;
    setActivities(part.data.phase === "start" ? (part.data.activities ?? []) : []);
  }, []);

  // Guarded so an already-empty list is not "set" to a new empty array every
  // time the caller's effect runs. An unconditional setState here would be a
  // render loop, which is the exact bug that killed long threads once already.
  const clear = useCallback(() => {
    setActivities((prev) => (prev.length === 0 ? prev : []));
  }, []);

  return { activities, onData, clear };
}
