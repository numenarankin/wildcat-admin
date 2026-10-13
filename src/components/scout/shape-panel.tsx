"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Shape } from "@/lib/scout/geo-shapes";
import type { DrawTool } from "@/lib/scout/shape-layer";
import { cn } from "@/lib/utils";

/**
 * The drawn area, listed: every shape visible, every shape removable.
 *
 * A shape on a map is otherwise unaccountable — it narrows the answer and the
 * only handle on it is the geometry itself, so a ring dropped by a stray click
 * off the edge of the viewport is a filter nobody can find. Listing them makes
 * the area a thing with parts.
 *
 * The WELL COUNT is here rather than in the filter bar because it is the answer
 * to what the area did: the bar's "Showing a sample" warning is about the query,
 * and this is about the selection the shapes made (`wellsInShapes`).
 *
 * Bottom-LEFT, the corner `PermitLegend` uses in the other mode, so it never
 * sits under the tool buttons that create it.
 */
export function ShapePanel({
  raised = false,
  shapes,
  selected,
  tool,
  ringMiles,
  onRingMiles,
  onRemove,
  onClear,
}: {
  /** Sit a row higher, clearing the permit legend in the corner below. */
  raised?: boolean;
  shapes: Shape[];
  /**
   * How many wells the shapes hold, or null when the map cannot say — the
   * statewide tile layer is a picture, not a list, and permits and operators
   * are not wells at all.
   */
  selected: number | null;
  tool: DrawTool;
  ringMiles: number;
  onRingMiles: (miles: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute left-3 z-10 flex w-60 flex-col gap-1.5 rounded-lg border",
        "bg-background/95 p-2.5 text-xs shadow-lg backdrop-blur",
        raised ? "bottom-24" : "bottom-8"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Area</span>
        {selected != null && shapes.length > 0 && (
          <span className="tabular-nums text-muted-foreground">
            {selected.toLocaleString()} wells
          </span>
        )}
        {shapes.length > 0 && (
          <Button size="xs" variant="ghost" onClick={onClear}>
            Clear all
          </Button>
        )}
      </div>

      {shapes.map((s, i) => (
        // Index as key: the rows are positional and unnamed, and a removal
        // renumbers everything after it either way — the same call the OR
        // groups' rows make.
        <div key={i} className="flex items-center justify-between gap-2">
          <span className="truncate text-muted-foreground">{label(s)}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${label(s)}`}
            onClick={() => onRemove(i)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ))}

      {/* Only while the ring tool is armed: it is the radius the next well
          click uses, and it means nothing when no click is coming. */}
      {tool === "ring" && (
        <div className="flex items-center gap-1">
          {[1, 2, 5, 10].map((mi) => (
            <Button
              key={mi}
              size="xs"
              variant={mi === ringMiles ? "secondary" : "ghost"}
              className={cn(mi === ringMiles && "font-medium")}
              aria-pressed={mi === ringMiles}
              onClick={() => onRingMiles(mi)}
            >
              {mi} mi
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What each shape is, in the terms it was made in.
 *
 * A circle says its radius because that is the statement the model kept ("5
 * miles from this well"), not the 64 vertices it draws as. A four-cornered
 * polygon is a box; anything else is a lasso, counted by the vertices that
 * survived simplification — which is also the honest measure of how rough it is.
 */
function label(s: Shape): string {
  if (s.kind === "circle") return `Ring · ${s.miles} mi`;
  if (s.ring.length === 4) return "Box · 4 corners";
  return `Shape · ${s.ring.length} points`;
}
