"use client";

import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  RemoveFormattingIcon,
  StrikethroughIcon,
  UnderlineIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { EMAIL_FONTS } from "@/lib/admin/google/gmail/email-style";

/**
 * Inline styling an email can carry: font, size and colour as a text-style
 * mark. The composer loads these too, so a signature keeps its look when it
 * lands in a message (without them the editor would drop the styles).
 */
export const EMAIL_TEXT_STYLE = [TextStyle, FontFamily, FontSize, Color];

const SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32] as const;
const DEFAULT = "default";

/** The signature editor: Gmail's signature box, font to links. */
export function SignatureEditor({
  initialHtml,
  onChange,
  fontCss,
  fontPx,
  trailer,
}: {
  initialHtml: string;
  onChange: (html: string) => void;
  /** The default font and size, so the box shows the mail as it will read. */
  fontCss: string;
  fontPx: number;
  /** Shown inside the box under the editable text, outside the editor (a fixed signature). */
  trailer?: React.ReactNode;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        link: { openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      ...EMAIL_TEXT_STYLE,
    ],
    content: initialHtml,
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getHTML()),
    immediatelyRender: false,
  });

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-input">
      {editor && <SignatureToolbar editor={editor} />}
      <div className="min-h-32 px-4 py-3" style={{ fontFamily: fontCss, fontSize: fontPx }}>
        <EditorContent editor={editor} className="[&_.ProseMirror]:min-h-24 [&_.ProseMirror]:outline-none [&_a]:text-blue-600! [&_a]:underline [&_p]:my-0" />
        {trailer}
      </div>
    </div>
  );
}

function SignatureToolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      link: e.isActive("link"),
      font: (e.getAttributes("textStyle").fontFamily as string | undefined) ?? null,
      size: (e.getAttributes("textStyle").fontSize as string | undefined) ?? null,
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
    }),
  });
  const fontLabel = EMAIL_FONTS.find((f) => f.css === state.font)?.label ?? "Default font";
  const chain = () => editor.chain().focus();

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 px-2 py-1.5">
      <Select
        value={state.font ?? DEFAULT}
        onValueChange={(v) => {
          if (!v || v === DEFAULT) chain().unsetFontFamily().run();
          else chain().setFontFamily(String(v)).run();
        }}
      >
        <SelectTrigger className="h-7 w-36 text-xs">
          <span className="truncate">{fontLabel}</span>
        </SelectTrigger>
        <SelectContent className="light">
          <SelectItem value={DEFAULT}>Default font</SelectItem>
          {EMAIL_FONTS.map((f) => (
            <SelectItem key={f.id} value={f.css} style={{ fontFamily: f.css }}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={state.size ?? DEFAULT}
        onValueChange={(v) => {
          if (!v || v === DEFAULT) chain().unsetFontSize().run();
          else chain().setFontSize(String(v)).run();
        }}
      >
        <SelectTrigger className="h-7 w-24 text-xs">
          <span>{state.size ?? "Size"}</span>
        </SelectTrigger>
        <SelectContent className="light">
          <SelectItem value={DEFAULT}>Default</SelectItem>
          {SIZES.map((px) => (
            <SelectItem key={px} value={`${px}px`}>
              {px}px
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Divider />
      <ToolButton icon={BoldIcon} label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()} />
      <ToolButton icon={ItalicIcon} label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()} />
      <ToolButton icon={UnderlineIcon} label="Underline" active={state.underline} onClick={() => chain().toggleUnderline().run()} />
      <ToolButton icon={StrikethroughIcon} label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()} />
      <label
        title="Text color"
        className="relative flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-background-hover"
      >
        <span className="text-sm font-semibold" style={{ color: state.color ?? undefined }}>
          A
        </span>
        <span className="absolute inset-x-1.5 bottom-1 h-0.5 rounded" style={{ background: state.color ?? "currentColor" }} />
        <input
          type="color"
          aria-label="Text color"
          value={state.color ?? "#000000"}
          onChange={(e) => chain().setColor(e.target.value).run()}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <Divider />
      <ToolButton
        icon={LinkIcon}
        label="Link"
        active={state.link}
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = window.prompt("Link URL", prev ?? "https://");
          if (url === null) return;
          if (url.trim() === "") {
            chain().extendMarkRange("link").unsetLink().run();
            return;
          }
          // Only web and mail links; anything else (javascript:, data:) is refused.
          const href = /^(https?:|mailto:|tel:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
          chain().extendMarkRange("link").setLink({ href }).run();
        }}
      />
      <ToolButton
        icon={RemoveFormattingIcon}
        label="Clear formatting"
        onClick={() => chain().unsetAllMarks().run()}
      />
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-tertiary-text transition-colors hover:bg-background-hover hover:text-primary-text",
        active && "bg-background-hover text-primary-text"
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
}
