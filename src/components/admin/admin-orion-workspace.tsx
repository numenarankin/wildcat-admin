"use client";

import { OrionWorkspace, type ConversationPersistence } from "@/components/ai/orion-workspace";
import { deleteAdminConversation, saveAdminMessages } from "@/lib/ai/admin/conversation-actions";
import type { Conversation } from "@/lib/ai/conversations";

const ADMIN_PERSISTENCE: ConversationPersistence = {
  save: (id, messages) => saveAdminMessages(id, messages),
  remove: deleteAdminConversation,
};

/**
 * The customer Orion page's workspace, pointed at the admin route and the
 * admin history, with the voice loop off (it would post to the customer
 * route). The surface is the same by design: same composer, same history
 * panel, a different assistant behind it.
 */
export function AdminOrionWorkspace({
  initialConversations,
  firstName,
}: {
  initialConversations: Conversation[];
  firstName: string;
}) {
  return (
    <OrionWorkspace
      initialConversations={initialConversations}
      firstName={firstName}
      api="/api/admin/chat"
      persistence={ADMIN_PERSISTENCE}
      allowVoice={false}
    />
  );
}
