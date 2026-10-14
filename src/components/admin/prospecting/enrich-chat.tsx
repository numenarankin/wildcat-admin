"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { uuid } from "@/lib/utils";
import { OrionChat } from "@/components/ai/orion-chat";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { saveAdminMessages } from "@/lib/ai/admin/conversation-actions";
import { loadEnrichConversation } from "@/lib/admin/outreach/enrich-chat-actions";
import { NEW_CHAT_TITLE, type Conversation } from "@/lib/ai/conversations";

/** The one-click opener: the prompt that runs the persona's four steps. */
const ENRICH_QUICK_ACTION = { label: "Enrich", text: "Tell me about this company." };

/**
 * One company's Enrich chat: the Orion chat surface posted to the Enrich
 * route with the target in the body, saved to the admin history tagged with
 * the target so it resumes next time. The debounced save is the Orion
 * workspace's, for a single thread.
 */
export function EnrichChat({
  targetNo,
  firstName,
  onTurn,
}: {
  targetNo: number;
  firstName: string;
  /** The message list changed: the card may have new saves to show. */
  onTurn: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extraBody = useMemo(() => ({ targetNo }), [targetNo]);

  // The parent keys this component by target, so a new company mounts fresh.
  useEffect(() => {
    let active = true;
    loadEnrichConversation(targetNo)
      .then((c) => {
        if (!active) return;
        const now = Date.now();
        setConversation(c ?? { id: uuid(), title: NEW_CHAT_TITLE, messages: [], createdAt: now, updatedAt: now });
      })
      .catch((error) => {
        console.error("Failed to load the enrich chat", error);
        const now = Date.now();
        if (active) setConversation({ id: uuid(), title: NEW_CHAT_TITLE, messages: [], createdAt: now, updatedAt: now });
      });
    return () => {
      active = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [targetNo]);

  // Keyed on the id alone and never writes `conversation`: OrionChat re-runs
  // its lift effect whenever this callback changes, so a callback that
  // replaced the object it depends on looped (max update depth).
  const conversationId = conversation?.id ?? null;
  const handleMessages = useCallback(
    (messages: UIMessage[]) => {
      onTurn();
      if (messages.length === 0 || !conversationId) return;
      const id = conversationId;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        saveAdminMessages(id, messages, undefined, targetNo).catch((error) =>
          console.error("Failed to save the enrich chat", error)
        );
      }, 800);
    },
    [conversationId, targetNo, onTurn]
  );

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoadingScreen label="Loading" />
      </div>
    );
  }
  return (
    <OrionChat
      key={conversation.id}
      conversation={conversation}
      onMessagesChange={handleMessages}
      firstName={firstName}
      api="/api/admin/enrich/chat"
      extraBody={extraBody}
      noAttachments
      quickAction={ENRICH_QUICK_ACTION}
    />
  );
}
