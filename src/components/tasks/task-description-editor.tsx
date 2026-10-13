"use client";

import { useEffect, useRef } from "react";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-list";
import { EditorToolbar } from "@/components/kb/editor-toolbar";
import { CheckboxTaskItem } from "@/components/kb/task-list-item";

interface TaskDescriptionEditorProps {
  onChange: (html: string) => void;
  /** Seed content (HTML). Only read on mount — remount via `key` to reset. */
  initialContent?: string;
  placeholder?: string;
}

/**
 * Rich-text description editor for the Add Task modal. Unlike the project
 * editor's `embedded` mode (dark, content boxed to a centered max-width), this
 * one matches the modal's theme and lets text flow free across the full pane.
 * It's uncontrolled — remount it (via `key`) to reset.
 */
export function TaskDescriptionEditor({
  onChange,
  initialContent = "",
  placeholder = "Add details, acceptance criteria, links…",
}: TaskDescriptionEditorProps) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
        link: false,
      }),
      Placeholder.configure({ placeholder }),
      // A task's description is where its steps live, so they can be ticked
      // off in place rather than split into tasks of their own.
      TaskList,
      CheckboxTaskItem.configure({ nested: true }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
    ],
    content: initialContent,
    onUpdate: ({ editor }) => onChangeRef.current(editor.getHTML()),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "tiptap min-h-full w-full text-sm leading-relaxed text-foreground outline-none",
      },
    },
  });

  if (!editor) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading editor…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sticky top-0 z-10 bg-card">
        <EditorToolbar editor={editor} />
      </div>
      <div
        className="min-h-0 flex-1 cursor-text overflow-y-auto py-3"
        onClick={() => editor.chain().focus().run()}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
