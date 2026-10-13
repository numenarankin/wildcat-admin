"use client";

import { useMemo } from "react";
import type { UIMessage } from "ai";
import { useVoiceMode } from "@/lib/ai/use-voice-mode";
import { VoiceOverlay } from "@/components/ai/voice-overlay";
import {
  useVoiceConversation,
  type VoiceTurn,
} from "@/lib/ai/use-voice-conversation";
import type { Conversation } from "@/lib/ai/conversations";

/** Concatenate the text parts of a UIMessage. */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Project a stored conversation down to plain text turns for the voice loop. */
function toVoiceTurns(messages: UIMessage[]): VoiceTurn[] {
  const turns: VoiceTurn[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = messageText(m).trim();
    if (text) turns.push({ role: m.role, text });
  }
  return turns;
}

/** Back to UIMessages so the voice exchange persists into the open thread. */
function toMessages(turns: VoiceTurn[]): UIMessage[] {
  return turns.map((t, i) => ({
    id: `voice-${i}-${t.role}`,
    role: t.role,
    parts: [{ type: "text", text: t.text }],
  }));
}

interface OrionVoiceChatProps {
  conversation: Conversation;
  /** Persist the live message list back to the conversation store. */
  onMessagesChange: (messages: UIMessage[]) => void;
}

/**
 * Full-page Orion chat in voice mode: the same chat surface as {@link OrionChat}
 * but driven by the hands-free voice loop. The user can speak or type; Orion's
 * reply is both printed and spoken aloud. Seeds from and persists back into the
 * open conversation so the thread is continuous when voice is toggled on/off.
 */
export function OrionVoiceChat({
  conversation,
  onMessagesChange,
}: OrionVoiceChatProps) {
  const setEnabled = useVoiceMode((s) => s.setEnabled);
  // Snapshot the thread once, when voice mode mounts, as the loop's seed.
  const seedTurns = useMemo(
    () => toVoiceTurns(conversation.messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const {
    status,
    error,
    lastUser,
    liveReply,
    liveActive,
    turns,
    pendingApprovals,
    respondToApproval,
  } = useVoiceConversation({
    enabled: true,
    initialTurns: seedTurns,
    onCommit: (next) => onMessagesChange(toMessages(next)),
    onEnd: () => setEnabled(false),
  });

  // Presentation is the shared full-screen overlay, same as every other page.
  // This component still exists (rather than deferring to VoiceController) for
  // one reason: it seeds the loop from the open conversation and persists each
  // committed turn back into it, so toggling voice on and off keeps one
  // continuous thread on /orion.
  return (
    <VoiceOverlay
      status={status}
      error={error}
      lastUser={lastUser}
      liveReply={liveReply}
      liveActive={liveActive}
      turns={turns}
      pendingApprovals={pendingApprovals}
      respondToApproval={respondToApproval}
      onClose={() => setEnabled(false)}
    />
  );
}
