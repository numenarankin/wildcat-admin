"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChatPanel } from "@/components/ai/chat-panel";
import { useAiDrawer } from "@/lib/ai/use-ai-drawer";
import { useProjectScope } from "@/lib/ai/use-project-scope";
import { saveAdminMessages } from "@/lib/ai/admin/conversation-actions";

/** The admin drawer's save: the admin history, never a workspace's. */
const saveAdmin = (id: string, messages: Parameters<typeof saveAdminMessages>[1]) =>
  saveAdminMessages(id, messages);

/**
 * Global Orion chat drawer. Rendered as a flex sibling of the main content in
 * the app shell, so opening it animates its width and horizontally compresses
 * the page rather than overlaying it. Pinned to the viewport while the page
 * scrolls, and resizable by dragging its left edge.
 */
export function AiDrawer({
  admin = false,
}: {
  /**
   * The admin side's drawer: the same panel posting to the admin route and
   * saving to the admin history, with no project scope (there are no
   * projects there). The customer route and history are never touched.
   */
  admin?: boolean;
}) {
  const open = useAiDrawer((s) => s.open);
  const setOpen = useAiDrawer((s) => s.setOpen);
  const width = useAiDrawer((s) => s.width);
  const setWidth = useAiDrawer((s) => s.setWidth);
  // When inside a project, scope the drawer's chat to it (folder retrieval +
  // project memory + task/budget) — the project's existing AI, via the drawer.
  const scope = useProjectScope((s) => s.scope);
  const projectScope = admin ? null : scope;
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!resizing) return;

    function onMove(event: PointerEvent) {
      // Drawer is anchored to the right edge, so width grows as the pointer
      // moves left.
      setWidth(window.innerWidth - event.clientX);
    }
    function onUp() {
      setResizing(false);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [resizing, setWidth]);

  return (
    <aside
      aria-hidden={!open}
      aria-label="Orion assistant"
      style={{ width: open ? width : 0 }}
      className={cn(
        "sticky top-0 h-svh shrink-0 self-start overflow-hidden",
        open && "border-l border-border",
        // Animate open/close, but not while actively dragging the handle.
        !resizing && "transition-[width] duration-300 ease-in-out"
      )}
    >
      {open && (
        <div
          onPointerDown={(e) => {
            e.preventDefault();
            setResizing(true);
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Orion drawer"
          className={cn(
            "absolute top-0 left-0 z-10 h-full w-1.5 cursor-col-resize transition-colors hover:bg-data-accent/40",
            resizing && "bg-data-accent/60"
          )}
        />
      )}
      {/* Fixed inner width so the chat doesn't reflow during the width
          animation. Voice is no longer a variant of this panel: VoiceController
          renders a full-screen overlay that covers the drawer, so there is one
          voice host app-wide rather than one per surface. */}
      <div className="h-full" style={{ width }}>
        <ChatPanel
          // Remount when the project scope changes so the chat re-grounds.
          key={admin ? "admin" : (projectScope?.folderId ?? "global")}
          onClose={() => setOpen(false)}
          folderId={projectScope?.folderId}
          projectName={projectScope?.projectName}
          api={admin ? "/api/admin/chat" : undefined}
          save={admin ? saveAdmin : undefined}
          greeting={
            admin ? (
              <>
                Hi, I&apos;m <span className="font-medium text-primary-text">Orion</span>. Ask me
                about customers, revenue, or the support inbox.
              </>
            ) : undefined
          }
        />
      </div>
    </aside>
  );
}
