"use client";

import { useCallback, useState } from "react";
import { StaffConversationList } from "@/components/admin/support/staff-conversation-list";
import { SupportChat, type SupportChatActions } from "@/components/support/support-chat";
import {
  markSupportThreadReadByStaff,
  sendStaffReply,
  uploadStaffAttachments,
} from "@/lib/support/staff-actions";
import type { SupportMessage, StaffSupportThread } from "@/lib/support/types";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { supportInboxSlice, supportThreadSlice } from "@/lib/ai/admin/page-slices";

const STAFF_ACTIONS: SupportChatActions = {
  send: sendStaffReply,
  upload: uploadStaffAttachments,
  markRead: markSupportThreadReadByStaff,
};

/**
 * The staff desk: the customer Support workspace with the inbox on the left
 * and the same chat surface on the right, typing as staff. No drafts: every
 * thread here was opened by a customer.
 */
export function StaffSupportWorkspace({ initialThreads }: { initialThreads: StaffSupportThread[] }) {
  const [threads, setThreads] = useState(initialThreads);
  const [activeId, setActiveId] = useState<string | null>(initialThreads[0]?.id ?? null);

  const handleMessagesChange = useCallback((id: string, messages: SupportMessage[]) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const last = messages[messages.length - 1];
        return { ...t, messages, unread: false, lastMessageAt: last ? last.createdAt : t.lastMessageAt };
      })
    );
  }, []);

  const active = threads.find((t) => t.id === activeId) ?? null;
  const sorted = [...threads].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  usePageContextSlice("admin-support-inbox", supportInboxSlice(sorted));
  usePageContextSlice("admin-support-thread", active ? supportThreadSlice(active) : null);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <StaffConversationList threads={sorted} activeId={activeId} onSelect={setActiveId} />
      <div className="relative flex min-w-0 flex-1">
        {active ? (
          <SupportChat
            key={active.id}
            thread={active}
            firstName={active.customer.name}
            side="staff"
            actions={STAFF_ACTIONS}
            placeholder={`Reply to ${active.customer.name}…`}
            onMessagesChange={(messages) => handleMessagesChange(active.id, messages)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-background-surface text-sm text-muted-foreground">
            No support requests yet.
          </div>
        )}
      </div>
    </div>
  );
}
