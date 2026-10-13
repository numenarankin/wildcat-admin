"use client";

import { useCallback, useRef, useState } from "react";
import { ArrowUpIcon, FileTextIcon, PaperclipIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Shared shell for every Orion composer — the /orion landing box, the in-chat
 * composer, and the drawer's. One definition so the three can't drift.
 *
 * The composer is a PILL at rest and a rounded rectangle once the text wraps
 * past one line. `useComposerShape` owns the radius and the vertical padding: it
 * animates both off the same value as the height, so the corners unroll and the
 * box breathes at exactly the rate it grows. `rounded-full` and the `py` here
 * are the resting shape, which that hook reads and then opens from.
 *
 * The side padding is deliberately ONE value for both states. It sets the
 * textarea's width, so changing it changes where the text wraps — which is the
 * very thing deciding whether to change it. It also slid the text sideways at
 * the moment the box grew, which read as the words shifting under the cursor.
 */
export const COMPOSER_SHELL =
  "w-full rounded-full border border-foreground/20 bg-background px-3 py-2 " +
  "focus-within:ring-1 focus-within:ring-ring";

/**
 * The drawer's shell: same pill, tighter. It's a ~384px column docked beside the
 * app, so the page's generous padding eats real estate there.
 */
/**
 * A ring rather than a drop shadow, for the composers that sit low on their
 * surface with the conversation right above them: a shadow that only falls
 * downward leaves the top edge sitting on the background with nothing
 * separating the two. The 1px hairline closes the whole outline, the ambient
 * blur lifts it off, and dark mode gets its own values because a dark shadow on
 * a dark panel is invisible.
 */
export const COMPOSER_RING =
  "shadow-[0_0_0_1px_rgb(0_0_0/0.07),0_0_10px_2px_rgb(0_0_0/0.07)] " +
  "dark:shadow-[0_0_0_1px_rgb(255_255_255/0.12),0_0_12px_2px_rgb(0_0_0/0.5)]";

export const COMPOSER_SHELL_DENSE =
  "w-full rounded-full bg-background px-2.5 py-1 " + COMPOSER_RING;

/**
 * `COMPOSER_SHELL`'s sizing with the ring in place of the border — what both
 * Orion composers use. `COMPOSER_SHELL` itself stays bordered for the surfaces
 * that still want an outline (support, messages).
 */
export const COMPOSER_SHELL_RING =
  "w-full rounded-full bg-background px-3 py-2 " + COMPOSER_RING;

/**
 * Input + controls row. Centered while it's a pill; bottom-aligned once the box
 * grows, so the buttons sit beside the last line rather than floating mid-draft.
 */
export const COMPOSER_ROW = "flex items-center gap-1 in-data-[expanded=true]:items-end";

// 17px/1.6 rather than the app's 16px body: the composer is the one control the
// user types into all day, and the larger type is also what gives the pill its
// height. `min-h` matches one line at this size so an empty pill isn't squat.
export const COMPOSER_TEXTAREA =
  "text-[1.0625rem]/[1.6] max-h-60 min-h-[1.7rem] flex-1 resize-none self-center " +
  "bg-transparent px-2 py-1.5 text-primary-text outline-none " +
  "placeholder:text-tertiary-text in-data-[expanded=true]:self-end";

/**
 * The drawer's input: 14px against the page's 17px, with the padding and
 * one-line `min-h` pulled in to match, so the pill sits noticeably shorter.
 * `max-h` drops too — a 240px draft would swallow a narrow panel.
 */
export const COMPOSER_TEXTAREA_DENSE =
  "text-sm/[1.55] max-h-44 min-h-[1.3rem] flex-1 resize-none self-center " +
  "bg-transparent px-1.5 py-1 text-primary-text outline-none " +
  "placeholder:text-tertiary-text in-data-[expanded=true]:self-end";

/**
 * Send control: a circle with an up arrow, the conventional chat affordance.
 * 40px with a 20px glyph — sized to sit as the visual anchor of the taller pill,
 * and comfortably past the ~44px touch target once its padding is counted.
 * `rounded-full` deliberately overrides the app's default button radius, because
 * this one reads as a control *inside* the input rather than a page button.
 *
 * `children` overrides the arrow for states that aren't "send" (the drawer swaps
 * in a sparkle when the caller is out of AI credits).
 */
export function SendButton({
  onClick,
  disabled,
  label = "Send",
  dense = false,
  className,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label?: string;
  /** Drawer sizing: 32px, since the circle sets the pill's floor height. */
  dense?: boolean;
  /**
   * Fill override, for a composer whose surface has its own accent — Messages
   * sends in the same blue as its outgoing bubbles. Size and shape stay fixed
   * so the control is the same object everywhere it appears.
   */
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        dense
          ? "size-8 shrink-0 rounded-full [&_svg:not([class*='size-'])]:size-4"
          : "size-10 shrink-0 rounded-full [&_svg:not([class*='size-'])]:size-5",
        className
      )}
    >
      {children ?? <ArrowUpIcon />}
    </Button>
  );
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

/** A file staged on a composer, waiting to go out with the next message. */
export interface StagedFile {
  key: string;
  file: File;
}

/** A `file` part in the shape `sendMessage({ files })` takes. */
export interface ComposerFilePart {
  type: "file";
  mediaType: string;
  filename: string;
  url: string;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Media types Claude reads as an attachment. Everything else goes in as text. */
function isNativeAttachment(file: File): boolean {
  return file.type.startsWith("image/") || file.type === "application/pdf";
}

/** Enough of a spreadsheet or log to answer questions about it, not so much it blows the turn. */
const INLINE_TEXT_LIMIT = 100_000;

/** Decoded bytes that clearly aren't text — a .xlsx, a .zip, an image with no media type. */
function looksBinary(text: string): boolean {
  return text.includes("\u0000") || /\uFFFD/.test(text.slice(0, 4000));
}

/**
 * A staged file that isn't an image or a PDF, as text in the prompt.
 *
 * The model only takes images and PDFs as attachments; handing it a CSV as a
 * file part fails the whole turn with a provider error. Reading it inline is
 * what "attach the file" means for the formats this business actually drags in
 * — run sheets, exports, logs — and a binary that can't be read says so rather
 * than arriving as silent noise.
 */
async function inlineText(file: File): Promise<string> {
  let body: string;
  try {
    body = await file.text();
  } catch {
    return `[Attached file: ${file.name} — could not be read]`;
  }
  if (looksBinary(body)) {
    return `[Attached file: ${file.name} — not a readable text file, so its contents are not included]`;
  }
  const clipped = body.length > INLINE_TEXT_LIMIT;
  const shown = clipped ? body.slice(0, INLINE_TEXT_LIMIT) : body;
  return (
    `[Attached file: ${file.name}${clipped ? " — truncated" : ""}]\n` +
    "```\n" +
    shown +
    "\n```"
  );
}

/**
 * What the user typed plus their staged files, in the shape `sendMessage` takes:
 * images and PDFs as file parts, everything else inlined into the text.
 */
export async function buildSendPayload(
  text: string,
  staged: StagedFile[]
): Promise<{ text: string; files?: ComposerFilePart[] }> {
  const native = staged.filter((s) => isNativeAttachment(s.file));
  const textual = staged.filter((s) => !isNativeAttachment(s.file));
  const files = native.length > 0 ? await toFileParts(native) : undefined;
  const blocks = await Promise.all(textual.map((s) => inlineText(s.file)));
  return { text: [text, ...blocks].filter(Boolean).join("\n\n"), files };
}

/**
 * Staged files → the `files` argument of `sendMessage`. Data URLs, not uploads:
 * the bytes ride along with the turn and the model sees them directly, which is
 * what makes a pasted screenshot work without a storage round-trip.
 */
export function toFileParts(staged: StagedFile[]): Promise<ComposerFilePart[]> {
  return Promise.all(
    staged.map(async (s) => ({
      type: "file" as const,
      mediaType: s.file.type || "application/octet-stream",
      filename: s.file.name,
      url: await fileToDataUrl(s.file),
    }))
  );
}

/**
 * Files staged on a composer, plus the two gestures that put them there: drag
 * and drop onto the surface, and paste.
 *
 * Spread `dropProps` on whatever region should accept the gesture (the whole
 * chat panel, not just the input — a user dragging a screenshot aims at the
 * conversation). `dragging` is true only while a *file* drag is overhead, so
 * dragging selected text across the panel doesn't flash the overlay.
 *
 * Paste is only intercepted when the clipboard carries files and no plain text.
 * Copying a cell out of a spreadsheet puts BOTH an image and its text on the
 * clipboard, and silently swallowing the text there would be maddening.
 */
export function useStagedFiles() {
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const idRef = useRef(0);
  // dragenter/dragleave fire per child element, so a plain boolean flickers off
  // the moment the pointer crosses from the scroller onto a message bubble.
  const depthRef = useRef(0);

  const add = useCallback((files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setStaged((prev) => [
      ...prev,
      ...list.map((file) => ({ key: `f-${idRef.current++}`, file })),
    ]);
  }, []);

  const remove = useCallback((key: string) => {
    setStaged((prev) => prev.filter((s) => s.key !== key));
  }, []);

  const clear = useCallback(() => setStaged([]), []);

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depthRef.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      // Without this the browser navigates to the dropped file.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depthRef.current -= 1;
      if (depthRef.current <= 0) {
        depthRef.current = 0;
        setDragging(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      depthRef.current = 0;
      setDragging(false);
      add(e.dataTransfer.files);
    },
    onPaste: (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      if (e.clipboardData.getData("text/plain").trim()) return;
      e.preventDefault();
      add(files);
    },
  };

  return { staged, add, remove, clear, dragging, dropProps };
}

/** One staged item, whatever it came from: a disk file or a KB document. */
export interface ChipItem {
  key: string;
  name: string;
  kind: "kb" | "disk";
}

/** The row of chips that sits above a composer's input while files are staged. */
export function AttachmentChips({
  items,
  onRemove,
  className,
}: {
  items: ChipItem[];
  onRemove: (key: string) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={cn("mb-2 flex flex-wrap gap-1.5", className)}>
      {items.map((item) => (
        <span
          key={item.key}
          className="ty-caption flex items-center gap-1 rounded-md bg-background-subtle py-1 pl-2 pr-1 text-primary-text"
        >
          {item.kind === "kb" ? (
            <FileTextIcon className="size-3.5 text-tertiary-text" />
          ) : (
            <PaperclipIcon className="size-3.5 text-tertiary-text" />
          )}
          <span className="max-w-[180px] truncate">{item.name}</span>
          <button
            type="button"
            aria-label="Remove attachment"
            onClick={() => onRemove(item.key)}
            className="rounded p-0.5 text-tertiary-text hover:bg-background-hover hover:text-primary-text"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Shown over the drop region while a file drag is overhead. */
export function DropOverlay({ label = "Drop to attach" }: { label?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-3">
      <div className="ty-body-2 flex w-full items-center justify-center rounded-xl border-2 border-dashed border-data-accent px-4 py-6 text-center font-medium text-primary-text">
        {label}
      </div>
    </div>
  );
}
