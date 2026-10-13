"use client";

import { TaskItem } from "@tiptap/extension-list";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * One checklist line: a real {@link Checkbox}, then the text.
 *
 * Tiptap's stock task item renders a bare `<input type="checkbox">`, which is
 * the operating system's control — a different shape on every machine, and the
 * only unstyled box left in a product whose every other checkbox is this one.
 * A node view is what lets a React component stand in for the node.
 *
 * The checkbox sits in a `contentEditable={false}` island. Without it the
 * caret can land inside the control and typing would try to write into it.
 */
function TaskItemView({ node, updateAttributes, editor }: NodeViewProps) {
  const checked = node.attrs.checked === true;

  return (
    <NodeViewWrapper
      as="li"
      data-checked={checked}
      className="flex items-start"
    >
      {/*
        The marker column, sized to put the box where a reader expects a marker:

        WIDE enough to hold the box (1rem) and leave it room to breathe before
        the text (1.5rem in all). That is a quarter of a rem past where bullet
        and numbered text start — the box is a wider marker than a disc, and
        crowding the text against it to save 4px reads worse than the offset.

        TALL as exactly one line (`1lh`, which follows whatever line-height the
        text inherits), with the box centred in it — so it centres on the FIRST
        line of a wrapping item, and stays right at any font size. A fixed nudge
        in px is only correct at one.

        Then lifted 0.125em. Centred on the line box the box is mathematically
        level with the text, but a line box is taller than the letters in it and
        hangs its slack under the baseline: measured, the box cleared the
        ascenders by 2.2px while dropping 3.8px below the baseline. Almost no
        lowercase word descends, so the eye reads the baseline as the floor and
        the box as sitting low. The lift puts it back on the letters.
      */}
      <span
        contentEditable={false}
        // Inline rather than utilities: `1lh` is not a unit Tailwind is
        // guaranteed to pass through, and a silently dropped class here means
        // the box sits at the top of the line instead of centred on it.
        style={{ height: "1lh", position: "relative", top: "-0.125em" }}
        className="flex w-6 shrink-0 items-center"
      >
        <Checkbox
          checked={checked}
          disabled={!editor.isEditable}
          aria-label={checked ? "Mark as not done" : "Mark as done"}
          onCheckedChange={(next) => updateAttributes({ checked: next })}
          // Everything around it is editable text, so the caret is the default
          // cursor here; the one thing on the line you click rather than type
          // into has to say so. The component's own `disabled:cursor-not-allowed`
          // still wins when the editor is read-only.
          className="cursor-pointer"
        />
      </span>
      {/*
        Struck through and dimmed once it is done, which is the whole point of
        ticking it: the line stays readable as a record, but reads as finished
        rather than as work still waiting.
      */}
      <NodeViewContent
        className={cn(
          "min-w-0 flex-1",
          checked && "text-muted-foreground line-through"
        )}
      />
    </NodeViewWrapper>
  );
}

/** `TaskItem` drawn with our own checkbox. Pair with tiptap's `TaskList`. */
export const CheckboxTaskItem = TaskItem.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskItemView);
  },
});
