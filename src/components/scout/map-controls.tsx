"use client";

import {
  Brush01,
  Circle,
  CursorBox,
  Globe05,
  Map01,
  Minus,
  Plus,
} from "@untitledui/icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DrawTool } from "@/lib/scout/shape-layer";
import { cn } from "@/lib/utils";

/** The two basemaps Scout offers. */
export type Basemap = "map" | "satellite";

const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";
const MAP_STYLE = {
  light: "mapbox://styles/mapbox/light-v11",
  dark: "mapbox://styles/mapbox/dark-v11",
} as const;

/**
 * The style behind a basemap. The drawn map follows the admin theme (Mapbox's
 * dark style in dark mode, the customer app's light one in light mode);
 * satellite is the same imagery in both.
 */
export function basemapStyle(basemap: Basemap, darkTheme: boolean): string {
  if (basemap === "satellite") return SATELLITE_STYLE;
  return darkTheme ? MAP_STYLE.dark : MAP_STYLE.light;
}

/**
 * Whether the ground under the overlays is dark, which picks their bright
 * palettes (survey grid, pipelines, drawn shapes). Imagery always is; the
 * drawn map is when the theme is.
 */
export function isDarkGround(basemap: Basemap, darkTheme: boolean): boolean {
  return basemap === "satellite" || darkTheme;
}

/**
 * The basemap Scout opens on.
 *
 * Admin opens on the drawn map, in the admin theme.
 * Recon itself opens on satellite, because this is a prospecting map: what is on the ground next to a
 * well — pads, roads, tank batteries, a river — is the context the dots are read
 * against, and the light style has none of it. The survey layer already carries
 * a satellite palette (`survey-layer.ts`), so the property grid stays legible
 * over imagery.
 *
 * Exported so the map's initial style, its `useState`, and the ref tracking what
 * is applied all read the SAME value. They are three separate places and a
 * literal in any one of them is a basemap that silently disagrees with the
 * toggle's idea of what is showing.
 */
export const DEFAULT_BASEMAP: Basemap = "map";

/**
 * Hover delay before a rail button names itself, in ms.
 *
 * Short. The sidebar's trigger waits a second because its tooltip is a reminder
 * of a shortcut nobody is waiting on; these ARE the labels, and a user sweeping
 * the rail to find the lasso should not have to hold still for one.
 */
const TIP_DELAY = 300;

/**
 * The map's own controls: a horizontal bar bottom-right, and a vertical rail on
 * the right edge.
 *
 * THE SPLIT IS BY WHAT A BUTTON DOES, not by what it looks like. Basemap and
 * zoom change how the map is DRAWN and leave its contents alone, so they stay in
 * the bar. Box, Lasso and Ring all arm a mode and then wait for the user to act
 * ON the map, and arming any one of them disarms the others, so they are one
 * group and are rendered as one: a rail, centred on the right edge, where a tool
 * palette belongs and where the eye can find the armed one without reading
 * across a row of unrelated buttons.
 *
 * The rail is VERTICAL for the same reason it is one group, and its buttons are
 * ICONS ONLY, naming themselves on hover. A palette is pointed at, not read: the
 * labels spelled out cost a column of map wide enough to hide a lease, to tell a
 * user who has already learned the three shapes something they only needed
 * once. The name is still one hover away, and still in `aria-label`, which is
 * what a screen reader was reading anyway.
 *
 * The tooltips open to the LEFT. On the right edge of the canvas there is
 * nowhere else for them to go.
 *
 * Rendered here rather than as a `mapboxgl.NavigationControl` for two reasons.
 * Mapbox stacks its control group vertically with no option to lay it out any
 * other way — turning it sideways means overriding its stylesheet's borders and
 * radii from the app's global CSS, which then applies to every Mapbox instance
 * in the product. And the basemap toggle has to live in the same bar to read as
 * one control; as a second `IControl` it would be a separate floating pill with
 * Mapbox's chrome rather than the app's buttons.
 *
 * Zoom goes through the map's own `zoomIn`/`zoomOut`, so it keeps Mapbox's
 * easing and its min/max bounds. Rotation is not offered because the page map
 * never enables it.
 */
export function MapControls({
  basemap,
  onBasemap,
  onZoomIn,
  onZoomOut,
  drawTool = "off",
  onDrawTool,
  rightInset = 0,
}: {
  basemap: Basemap;
  onBasemap: (b: Basemap) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /**
   * Which area tool is armed, and how to arm one.
   *
   * Absent in the modes where a drawn area cannot filter anything — only the
   * focus query answers a polygon, and only wells mode runs it. The shapes
   * themselves stay on the map in every mode; it is the DRAWING that is wells
   * mode's.
   */
  drawTool?: DrawTool;
  onDrawTool?: (tool: DrawTool) => void;
  /**
   * Pixels of canvas covered on the right — the width of the open side panels.
   *
   * The panels are opaque and sit at the same z as this bar, so a selected
   * permit used to bury the zoom and basemap buttons under it. Sliding rather
   * than hiding: the controls are still the map's, and a map you cannot zoom
   * while reading a permit is the wrong trade.
   */
  rightInset?: number;
}) {
  const satellite = basemap === "satellite";
  /*
   * Both surfaces slide by the same inset, so they stay in one vertical line
   * down the right edge as a panel opens. Read once here rather than written
   * twice: two `calc()`s that could drift is two controls that stop lining up.
   */
  const right = `calc(0.75rem + ${rightInset}px)`;
  const tools = Boolean(onDrawTool);
  return (
    <>
      {/* THE TOOL RAIL. Centred on the edge rather than pinned to a corner:
          this is the palette, and it is reached for repeatedly while the bar
          below is set once and forgotten. Hidden entirely in a mode with no
          tools, because an empty rail is a control that looks broken. */}
      {tools && (
        <div
          className="absolute top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5 transition-[right] duration-200"
          style={{ right }}
        >
          {/* ARMED, not bound to a bare map click. Every existing click handler
              on this map is layer-scoped, so clicking empty canvas does nothing
              today, and quietly making it drop a pin would fire on every
              misjudged click at a cluster. A mode the user turns on is the
              honest version. */}
          {/* The AREA tools, in one group because they are three ways to make
              the same thing: a box you drag, a shape you draw freehand, and a
              ring around a well you click. Armed like the pin above them, and
              clicking the armed one puts it away. Unlike the pin, what they
              make FILTERS the map; the pin answers what is near a point and
              leaves the map alone. */}
          {onDrawTool && (
            <div className="flex flex-col overflow-hidden rounded-md border bg-background shadow-sm">
              {(
                [
                  { tool: "box", label: "Box", Icon: CursorBox },
                  { tool: "lasso", label: "Lasso", Icon: Brush01 },
                  { tool: "ring", label: "Ring", Icon: Circle },
                ] as const
              ).map(({ tool, label, Icon }, i) => (
                <div key={tool} className="flex flex-col">
                  {/* The divider runs the other way now, and full width: a
                      1px column between stacked buttons would be invisible. */}
                  {i > 0 && <div aria-hidden className="h-px w-full bg-border" />}
                  <Tooltip>
                    <TooltipTrigger
                      delay={TIP_DELAY}
                      render={
                        <Button
                          type="button"
                          size="icon-sm"
                          variant={drawTool === tool ? "secondary" : "ghost"}
                          className="h-8 w-8 rounded-none"
                          aria-label={label}
                          aria-pressed={drawTool === tool}
                          onClick={() => onDrawTool(drawTool === tool ? "off" : tool)}
                        >
                          <Icon className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipContent className="px-2 py-1" side="left">
                      {label}
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Above the map canvas but BELOW the modals (z-100+) and the filter bar's
          dropdowns (z-20), so an open dossier covers it like everything else.
          `bottom-8`, not `bottom-3`: Mapbox pins its required attribution line
          to the bottom-right of the canvas, and at 3 the bar sat on top of it. */}
      <div
        className="absolute bottom-8 z-10 flex items-center gap-1.5 transition-[right] duration-200"
        style={{ right }}
      >
        <div className="flex items-center overflow-hidden rounded-md border bg-background shadow-sm">
          {/* Icon AND label on both. The icons follow the Google Maps
              convention — a folded map for the drawn basemap, the earth for the
              imagery one — but they support the words rather than replace them:
              which basemap is active has to be readable at a glance, and over
              satellite imagery an unlabelled icon button is the one thing you
              cannot reliably see. Untitled UI has no satellite icon; `Globe05`
              (a globe with landmasses) is the closest it carries. */}
          <Button
            type="button"
            size="sm"
            variant={satellite ? "ghost" : "secondary"}
            className={cn("h-8 gap-1.5 rounded-none px-2.5", !satellite && "font-medium")}
            aria-pressed={!satellite}
            onClick={() => onBasemap("map")}
          >
            <Map01 className="size-3.5" />
            Map
          </Button>
          <div aria-hidden className="h-5 w-px bg-border" />
          <Button
            type="button"
            size="sm"
            variant={satellite ? "secondary" : "ghost"}
            className={cn(
              "h-8 gap-1.5 rounded-none px-2.5",
              satellite && "font-medium"
            )}
            aria-pressed={satellite}
            onClick={() => onBasemap("satellite")}
          >
            <Globe05 className="size-3.5" />
            Satellite
          </Button>
        </div>

        <div className="flex items-center overflow-hidden rounded-md border bg-background shadow-sm">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="h-8 w-8 rounded-none"
            aria-label="Zoom out"
            onClick={onZoomOut}
          >
            <Minus className="size-4" />
          </Button>
          <div aria-hidden className="h-5 w-px bg-border" />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="h-8 w-8 rounded-none"
            aria-label="Zoom in"
            onClick={onZoomIn}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>
    </>
  );
}
