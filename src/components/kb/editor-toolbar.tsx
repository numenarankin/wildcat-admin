"use client";

import type { Editor } from "@tiptap/react";
import {
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListChecksIcon,
  ListOrderedIcon,
  QuoteIcon,
  LinkIcon,
  Undo2Icon,
  Redo2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface EditorToolbarProps {
  editor: Editor;
}

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  isActive,
  disabled,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={isActive}
      title={label}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-tertiary-text transition-colors",
        "hover:bg-background-hover hover:text-primary-text",
        "disabled:pointer-events-none disabled:opacity-40",
        isActive && "bg-background-hover text-primary-text"
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

export function EditorToolbar({ editor }: EditorToolbarProps) {
  // This toolbar is shared with the project editor, which does not register
  // the checklist extensions. Offering a button there would be offering one
  // that does nothing, so it appears only where the node actually exists.
  const hasChecklist = editor.extensionManager.extensions.some(
    (extension) => extension.name === "taskList"
  );

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-3 py-1.5">
      <ToolButton
        icon={Undo2Icon}
        label="Undo"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      />
      <ToolButton
        icon={Redo2Icon}
        label="Redo"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      />
      <Divider />
      <ToolButton
        icon={BoldIcon}
        label="Bold"
        onClick={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive("bold")}
      />
      <ToolButton
        icon={ItalicIcon}
        label="Italic"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive("italic")}
      />
      <ToolButton
        icon={StrikethroughIcon}
        label="Strikethrough"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive("strike")}
      />
      <Divider />
      <ToolButton
        icon={Heading1Icon}
        label="Heading 1"
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        isActive={editor.isActive("heading", { level: 1 })}
      />
      <ToolButton
        icon={Heading2Icon}
        label="Heading 2"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        isActive={editor.isActive("heading", { level: 2 })}
      />
      <ToolButton
        icon={Heading3Icon}
        label="Heading 3"
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        isActive={editor.isActive("heading", { level: 3 })}
      />
      <Divider />
      {hasChecklist && (
        <ToolButton
          icon={ListChecksIcon}
          label="Checklist"
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          isActive={editor.isActive("taskList")}
        />
      )}
      <ToolButton
        icon={ListIcon}
        label="Bullet list"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        isActive={editor.isActive("bulletList")}
      />
      <ToolButton
        icon={ListOrderedIcon}
        label="Numbered list"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        isActive={editor.isActive("orderedList")}
      />
      <ToolButton
        icon={QuoteIcon}
        label="Blockquote"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        isActive={editor.isActive("blockquote")}
      />
      <Divider />
      <ToolButton
        icon={LinkIcon}
        label="Link"
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = window.prompt("Link URL", prev ?? "https://");
          if (url === null) return;
          if (url === "") {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            return;
          }
          editor
            .chain()
            .focus()
            .extendMarkRange("link")
            .setLink({ href: url })
            .run();
        }}
        isActive={editor.isActive("link")}
      />
    </div>
  );
}
