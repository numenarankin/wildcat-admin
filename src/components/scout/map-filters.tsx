"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, ChevronDown, Settings, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { searchOperators } from "@/lib/scout/queries";
import { searchPeople } from "@/lib/scout/rrc-people";
import type { OperatorMatch } from "@/lib/scout/types";
import type { PersonMatch } from "@/lib/scout/rrc-types";
import { COUNTY_OPTIONS } from "@/lib/scout/counties";
import { chosen } from "@/lib/scout/focus-where";
import { carryAcrossMode } from "@/lib/scout/filter-focus";
import type { Shape } from "@/lib/scout/geo-shapes";
import type { PurposeOption } from "@/lib/scout/permit-filter";
import type { WellActivity } from "@/lib/scout/well-activity";
import { RangeHistogram } from "@/components/scout/range-histogram";
import { DatePicker } from "@/components/ui/date-picker";
import type { CommodityPrices } from "@/lib/analytics/types";
import { partyName } from "@/lib/scout/format";

export type MapMode = "wells" | "permits" | "operators";

/**
 * The whole filter bar: an AND of everything set here.
 *
 * FOUR OF THE WELL-MODE FIELDS ACCEPT THREE SHAPES: `"all"` (or `null`) for no
 * filter, one value, or a list. The bar writes a list; Orion writes a bare
 * value, and has since before multi-select existed (`normalizeScoutView`
 * answers "Andrews" with `3`). `chosen()` in `@/lib/scout/focus-where` is the
 * one place the three collapse, and every consumer goes through it. A field
 * holding several values is a union: two counties means either county.
 */
export interface Filters {
  mode: MapMode;
  oilGas: "all" | "O" | "G";
  /**
   * The well's activity bucket(s), or "all". THREE buckets, not two: "Active"
   * used to mean nothing but "no plug date", which drew every shut-in and
   * abandoned hole in Texas under it and left the ~270k wells that have stopped
   * without a bucket of their own. `@/lib/scout/well-activity` defines each one.
   */
  status: "all" | WellActivity | WellActivity[];
  district: "all" | number | number[];
  county: "all" | number | number[];
  /**
   * wells mode: the RRC's `well_type_name`, verbatim, or null for any type.
   * Like depth and the completion years, it is not in the tiles, so it runs
   * through the focus layer.
   */
  wellType: string | string[] | null;
  /**
   * wells mode: total depth in feet (null = unbounded).
   *
   * Not in the vector tiles — those carry only api/og/plug/dist — so bounding
   * either end switches the map to the query-backed focus layer, exactly as the
   * county and operator fields do. Same for the completion years below.
   */
  minDepth: number | null;
  maxDepth: number | null;
  /** wells mode: completion YEARS, inclusive. Excludes wells with no date on
   *  file; see `FocusOpts.minCompletionYear`. */
  minCompletionYear: number | null;
  maxCompletionYear: number | null;
  /**
   * wells mode: the WELL's own production per month, oil in bbl and gas in MCF
   * (null = unbounded). The same units and the same question operator mode's
   * `minOil12` pair asks, one grain down.
   *
   * The rate comes from `wildcat.well_rate` in the mirror and is what the map's
   * hover label already shows for a dot: allocated production averaged over the
   * last 12 filed months (`FocusOpts.minOilRate`). A well with no rate on file
   * is excluded once either end is set, because unfiled is not zero.
   */
  minOilRate: number | null;
  maxOilRate: number | null;
  minGasRate: number | null;
  maxGasRate: number | null;
  /**
   * permits mode: filing purposes to draw, by the `purpose` string the payload
   * carries (see `@/lib/scout/permit-filter`). EMPTY means every purpose.
   *
   * A list rather than one value because the question people ask is "new drill
   * or reenter", not "new drill". Applied by rebuilding the permit sources, not
   * with `setFilter`: they are clustered, and a layer filter would leave the
   * bubbles counting permits it had already hidden.
   */
  permitPurpose: string[];
  /**
   * permits mode: the permit's date, inclusive, `YYYY-MM-DD` (null =
   * unbounded). The date each dot already carries: FILED for a pending
   * application, ISSUED for an approved or drilled one. Sent to the server as
   * well as applied to the drawn sets, because the approved history is fetched
   * newest-first under a cap, and an older range cut from that sample would be
   * a fraction of the answer.
   */
  permitSince: string | null;
  permitUntil: string | null;
  /**
   * The drawn area: rings around wells, dragged boxes and freehand lassos, all
   * UNIONED (`@/lib/scout/geo-shapes`). Empty means the whole state.
   *
   * A FILTER, not a side panel. Anything in here narrows the focus query the
   * same way a county does, which is what separates it from the radius pin
   * beside it: that one answers "what disposal is near this point" and puts a
   * LIST on screen without touching the map.
   *
   * An area is where you are looking rather than one of the things you are
   * asking (see `FocusOpts.shapes`), so it survives a mode switch for the same
   * reason the gear-menu settings do.
   */
  shapes: Shape[];
  operator: OperatorMatch | null;
  /**
   * A principal/officer, by their RRC name — people are attached to operating
   * companies, so this filters to EVERY operator they are listed on (a P-5
   * officer, filing agent or resident agent). Set in every mode: it narrows the
   * well map the same way it narrows the operator map.
   */
  person: string | null;
  // operator mode: well-count range (null = unbounded)
  minWells: number | null;
  maxWells: number | null;
  // operator mode: production range PER MONTH, oil in bbl and gas in MCF (null
  // = unbounded). The operator's OWN reported production (RRC
  // `operator_production_monthly`), not the whole-lease footprint this used to
  // show, so an operator that reported nothing counts as 0 and any `min` above
  // 0 drops them. The names keep the `12` because the stored aggregate is still
  // the 12-month sum; the map divides by 12 before comparing.
  minOil12: number | null;
  maxOil12: number | null;
  minGas12: number | null;
  maxGas12: number | null;
  // operator mode: estimated revenue per month in USD — that same 12-month
  // production valued at the topbar's live prices and divided by 12. A rough
  // prospecting sort, not revenue; see `@/lib/scout/revenue`.
  minRevenue: number | null;
  maxRevenue: number | null;
  // Global setting (applies across all modes): when true, plugged wells are
  // hidden from the map and dropped from well counts and well-count filters.
  excludePlugged: boolean;
  /**
   * Draw survey/abstract tracts — the property lines — over the map.
   *
   * Only has an effect once zoomed in past `SURVEY_MIN_ZOOM` (see
   * `scout-map.tsx`): there are 311,158 tracts in Texas and the whole grid at
   * low zoom is a solid smear. ON by default — the zoom gate is what keeps it
   * from being a mess, so nobody should have to find a switch to see the land
   * under the wells. The toggle is for turning it off.
   */
  showSurveys: boolean;
  /** Draw the midstream pipeline network. */
  showPipelines: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  mode: "wells",
  oilGas: "all",
  status: "all",
  district: "all",
  county: "all",
  wellType: null,
  minDepth: null,
  maxDepth: null,
  minCompletionYear: null,
  maxCompletionYear: null,
  minOilRate: null,
  maxOilRate: null,
  minGasRate: null,
  maxGasRate: null,
  permitPurpose: [],
  permitSince: null,
  permitUntil: null,
  shapes: [],
  operator: null,
  person: null,
  minWells: null,
  maxWells: null,
  minOil12: null,
  maxOil12: null,
  minGas12: null,
  maxGas12: null,
  minRevenue: null,
  maxRevenue: null,
  excludePlugged: false,
  showSurveys: true,
  // OFF by default: the midstream network is context for a question about
  // gathering, not for the map's opening view, and statewide it draws a web
  // over every well the page is actually about.
  showPipelines: false,
};

const DISTRICTS = Array.from({ length: 14 }, (_, i) => i + 1);

/**
 * The RRC's own well-type vocabulary, as `rrc.wellbore.well_type_name` spells
 * it. `value` must stay byte-identical to the column — it is compared to it
 * directly — while `label` is only what the dropdown shows, since a list of
 * shouted constants is hard to read.
 *
 * EVERY type is listed rather than a curated few, so nothing in the data is
 * unreachable from the UI. The order is how common each one is (counts taken
 * over on-schedule rows, PRODUCING 267k down to SEALED 1), which puts the
 * handful anyone actually filters on at the top and the long tail below.
 */
const WELL_TYPES: { value: string; label: string }[] = [
  { value: "PRODUCING", label: "Producing" },
  { value: "SHUT IN", label: "Shut in" },
  { value: "TEMP ABANDONED", label: "Temporarily abandoned" },
  { value: "INJECTION", label: "Injection" },
  { value: "NO PRODUCTION", label: "No production" },
  { value: "SWR-10-WELL", label: "SWR-10 well" },
  { value: "PARTIAL PLUG", label: "Partial plug" },
  { value: "WATER SUPPLY", label: "Water supply" },
  { value: "NOT ELIGIBLE FOR ALLOWABLE", label: "Not eligible for allowable" },
  { value: "OBSERVATION", label: "Observation" },
  { value: "SHUT IN-MULTI-COMPL", label: "Shut in (multi-completion)" },
  { value: "LPG STORAGE", label: "LPG storage" },
  { value: "GAS STRG-INJECTION", label: "Gas storage (injection)" },
  { value: "DOMESTIC USE WELL", label: "Domestic use" },
  { value: "PROD FACTOR WELL", label: "Production factor" },
  { value: "GAS STRG-WITHDRAWAL", label: "Gas storage (withdrawal)" },
  { value: "BRINE MINING", label: "Brine mining" },
  { value: "ABANDONED", label: "Abandoned" },
  { value: "GAS STRG-SALT FORMATION", label: "Gas storage (salt formation)" },
  { value: "OTHER TYPE SERVICE", label: "Other service" },
  { value: "GEOTHERMAL WELL", label: "Geothermal" },
  { value: "SEALED", label: "Sealed" },
];

/**
 * Oldest completion year offered. The mirror's earliest real date is 1900 (27
 * wells that decade); the only values outside 1900..present are two rows dated
 * 2061 and 2070, which are keying errors in the state record and not worth a
 * pair of options nothing will ever match.
 */
const EARLIEST_COMPLETION_YEAR = 1900;

/** Reads a typed count back out of its formatted form: digits only, else null. */
function parseCount(v: string): number | null {
  const digits = v.replace(/[^0-9]/g, "");
  if (digits === "") return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function Seg<T extends string | number>({
  value,
  options,
  onSelect,
}: {
  value: T;
  options: { label: string; v: T }[];
  onSelect: (v: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <Button
          key={String(o.v)}
          size="sm"
          variant={value === o.v ? "default" : "outline"}
          onClick={() => onSelect(o.v)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * The same row of buttons, ticked several at a time — the Status control.
 *
 * A toggle rather than a menu because there are three buckets and they are the
 * first thing anyone touches; hiding them behind a dropdown to gain a multi-
 * select would cost more than it bought. "All" is not a fourth bucket, it is the
 * cleared state, so it deselects the rest rather than joining them.
 */
export function SegMulti<T extends string>({
  values,
  options,
  allLabel,
  onChange,
}: {
  values: T[];
  options: { label: string; v: T }[];
  allLabel: string;
  onChange: (v: T[]) => void;
}) {
  return (
    <div className="flex gap-1">
      <Button
        size="sm"
        variant={values.length === 0 ? "default" : "outline"}
        onClick={() => onChange([])}
      >
        {allLabel}
      </Button>
      {options.map((o) => (
        <Button
          key={String(o.v)}
          size="sm"
          variant={values.includes(o.v) ? "default" : "outline"}
          onClick={() =>
            onChange(
              values.includes(o.v)
                ? values.filter((x) => x !== o.v)
                : [...values, o.v]
            )
          }
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * A count typed with thousands separators.
 *
 * `type="text"`, not `type="number"`: a number input cannot render commas, and
 * these values run to nine figures (a billion MCF), where an unseparated run of
 * digits is unreadable and easy to mistype. Nothing but digits survives the
 * parse, so a pasted "$1,250,000" lands as 1250000. It is also not a stepper —
 * nobody nudges a revenue floor one at a time — so losing the spin arrows costs
 * nothing and buys back the width they ate.
 */
function CountInput({
  value,
  onChange,
  placeholder,
  label,
  className = "w-28",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <Input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      value={value == null ? "" : value.toLocaleString("en-US")}
      placeholder={placeholder}
      onChange={(e) => onChange(parseCount(e.target.value))}
      className={`h-7 text-xs tabular-nums ${className}`}
    />
  );
}

/**
 * A Min/Max numeric pair, sized to sit in the bar. Empty input = unbounded on
 * that end, so the placeholders carry the meaning and no label is needed
 * between them.
 */
export function Range({
  min,
  max,
  onMin,
  onMax,
  label,
  width = "w-28",
}: {
  min: number | null;
  max: number | null;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
  /** Screen-reader name for the pair; the visible one is the bar's field label. */
  label: string;
  /** Sized to the widest value the field can hold, not to a uniform grid. */
  width?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <CountInput
        value={min}
        onChange={onMin}
        placeholder="Min"
        label={`Minimum ${label}`}
        className={width}
      />
      <span className="text-xs text-muted-foreground">–</span>
      <CountInput
        value={max}
        onChange={onMax}
        placeholder="Max"
        label={`Maximum ${label}`}
        className={width}
      />
    </div>
  );
}

/**
 * A year, chosen from a list rather than typed.
 *
 * Completion years are a closed set with a known floor and ceiling, so there is
 * nothing for a free-text box to accept that the list cannot offer — and plenty
 * it should not (a typo, a two-digit year, a date in a range no well was drilled
 * in). Newest first, because the recent end is the one people filter on.
 *
 * `"any"` is the unbounded sentinel: the Select's value must be a non-empty
 * string, so null cannot be its own option.
 */
function YearSelect({
  value,
  onChange,
  years,
  label,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  years: number[];
  label: string;
  placeholder: string;
}) {
  return (
    <Select
      value={value == null ? "any" : String(value)}
      onValueChange={(v) => onChange(v === "any" ? null : Number(v))}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-24 text-xs tabular-nums">
        {/* Without a renderer the trigger prints the raw value, which for the
            unbounded end is the literal "any". */}
        <SelectValue>{(v) => (v === "any" ? placeholder : String(v))}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-64">
        <SelectItem value="any">{placeholder}</SelectItem>
        {years.map((y) => (
          <SelectItem key={y} value={String(y)} className="tabular-nums">
            {y}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Inline label + control — the bar's unit of layout. */
/** A `YYYY-MM-DD` filter value as a local calendar date, for the picker. */
function isoToDate(iso: string | null): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The picker's local calendar date back to `YYYY-MM-DD` (no UTC shift). */
function dateToIso(d: Date | null): string | null {
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function BarField({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {label && (
        <span className="text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

export function Divider() {
  return <div aria-hidden className="h-5 w-px shrink-0 bg-border" />;
}

/** How many ends of a group's ranges are actually bounded. */
function boundCount(...values: (number | null)[]): number {
  return values.filter((v) => v != null).length;
}

/**
 * A button that stands in for a group of collapsed filters.
 *
 * The bar's original rule was that nothing hides behind a disclosure, because a
 * filter that is hiding operators has to be visible while it does it. Collapsing
 * these keeps that promise a different way: the button carries the count of
 * bounds currently set and changes colour when any are, so a group that is
 * filtering the map says so from the closed state. The full values are one click
 * away and also in the tooltip.
 */
function GroupToggle({
  label,
  open,
  onToggle,
  bounds,
  title,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  bounds: number;
  title: string;
}) {
  return (
    <Button
      size="sm"
      variant={open ? "default" : bounds > 0 ? "secondary" : "outline"}
      onClick={onToggle}
      title={title}
      aria-expanded={open}
      className="gap-1"
    >
      {label}
      {bounds > 0 && (
        <span className="rounded-full bg-foreground/15 px-1.5 text-[10px] tabular-nums">
          {bounds}
        </span>
      )}
      <ChevronDown
        className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
      />
    </Button>
  );
}

/**
 * Which filing purposes the permit map draws.
 *
 * The options are handed in by the map, counted off the permit payload it has
 * loaded (`purposeCounts`), because the RRC's vocabulary is whatever the mirror
 * carries: a fixed list here would offer purposes with nothing behind them and
 * miss a code the state started filing last week. Codes the feed does not name,
 * and permits filed with no purpose at all, sit under "Other" so every dot on
 * the map has a box that brings it back.
 *
 * The counts are of the LOADED payload, not of the current selection, so they
 * stay put as boxes are ticked. Ticking one otherwise drops every other option
 * to zero, which is the one moment the numbers would be useless.
 */
function PurposeFilter({
  options,
  selected,
  onChange,
}: {
  options: PurposeOption[];
  /** Empty = every purpose. */
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const named = options.filter((o) => !o.other);
  const other = options.filter((o) => o.other);
  const chosen = options.filter((o) => selected.includes(o.value));
  const label =
    selected.length === 0
      ? "All purposes"
      : selected.length === 1
        ? // A selected purpose can pan out of the loaded payload, taking its
          // option with it; the filter is still on, so it still has to read as on.
          chosen[0]?.label ?? "1 purpose"
        : `${selected.length} purposes`;

  function toggle(value: string, checked: boolean) {
    onChange(
      checked ? [...selected, value] : selected.filter((v) => v !== value)
    );
  }

  const item = (o: PurposeOption) => (
    <DropdownMenuCheckboxItem
      key={o.value}
      checked={selected.includes(o.value)}
      onCheckedChange={(v) => toggle(o.value, v)}
      closeOnClick={false}
    >
      {o.label}
      <span className="ml-auto pl-3 text-[10px] tabular-nums text-muted-foreground">
        {o.count.toLocaleString()}
      </span>
    </DropdownMenuCheckboxItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="sm"
            variant={selected.length > 0 ? "secondary" : "outline"}
            className="gap-1"
            aria-label="Filter permits by filing purpose"
          />
        }
      >
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56">
        {/* Unticking several boxes is quick; re-ticking them one at a time to
            get back to the whole queue is not. */}
        <DropdownMenuItem
          className="cursor-pointer"
          disabled={selected.length === 0}
          onClick={() => onChange([])}
        >
          Show all purposes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {named.map(item)}
        {/* Codes the feed could not name, and permits filed with none at all.
            Grouped rather than listed among the rest: they are not purposes
            anyone asks for, but they are permits on the map, so they need a box.
            The label sits inside the group so it names it to a screen reader. */}
        {other.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Other</DropdownMenuLabel>
              {other.map(item)}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A chosen value (county / operator / focused person) with a clear button. */
function Chip({
  value,
  clearLabel,
  onClear,
  width = "w-44",
}: {
  value: string;
  clearLabel: string;
  onClear: () => void;
  /** Narrower when several sit side by side; see the county picker. */
  width?: string;
}) {
  return (
    <div
      className={`flex h-7 ${width} items-center justify-between gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-xs`}
    >
      <span className="truncate">{value}</span>
      <Button size="icon-xs" variant="ghost" aria-label={clearLabel} onClick={onClear}>
        <X className="size-3" />
      </Button>
    </div>
  );
}

/**
 * Type-ahead picker: the chosen values as clearable chips, plus a search input
 * with its result list. The list is absolutely positioned and hangs below the
 * bar, so the bar itself must sit above the map in the stacking order (see
 * `scout-map.tsx`).
 *
 * The list is NOT height-capped. Every search behind it returns ten rows at
 * most (operators and people 10, counties 8), so the whole answer fits under
 * the bar; a cap with the scrollbar hidden showed seven and silently held back
 * the rest. Nor is it width-capped to the input: it is a floating card, so it
 * grows to the longest result (to a ceiling) rather than truncating
 * "BORDERLINE OPERA..." into four indistinguishable rows.
 *
 * SINGLE by default, which is what an operator and a person are: one chip and
 * the box disappears, because a second value there would mean something the map
 * cannot draw. `multi` keeps the box next to the chips, for the fields that ARE
 * a list.
 */
function Picker({
  selected,
  clearLabel,
  onRemove,
  query,
  onQuery,
  placeholder,
  results,
  multi = false,
}: {
  selected: { key: string | number; label: string }[];
  clearLabel: string;
  onRemove: (key: string | number) => void;
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  /** `sub` is the disambiguator: two people can share a name, and the one worth
   *  opening is the one with the operators and wells behind it. */
  results: {
    key: string | number;
    label: string;
    sub?: string;
    onPick: () => void;
  }[];
  multi?: boolean;
}) {
  const chips = selected.map((c) => (
    <Chip
      key={c.key}
      value={c.label}
      width={multi && selected.length > 1 ? "w-28" : "w-44"}
      clearLabel={`${clearLabel}: ${c.label}`}
      onClear={() => onRemove(c.key)}
    />
  ));
  if (selected.length > 0 && !multi) return <>{chips}</>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      <div className="relative w-44">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          className="h-7 text-xs"
        />
        {results.length > 0 && (
          <ul className="absolute z-20 mt-1 w-max min-w-full max-w-[28rem] rounded-md border bg-popover p-1 shadow-md">
            {results.map((r) => (
              <li key={r.key}>
                <button
                  className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={r.onPick}
                >
                  <span className="block whitespace-nowrap">{r.label}</span>
                  {r.sub && (
                    <span className="block whitespace-nowrap text-[11px] text-muted-foreground">
                      {r.sub}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * A closed vocabulary picked several at a time — districts and well types.
 *
 * The same control the permit purposes use, in the general case: a trigger that
 * names the selection, a "show all" escape at the top, and a checkbox per
 * option. `PurposeFilter` stays its own component rather than being folded in
 * here because its options carry live counts and an "Other" group that only
 * permits have, and neither belongs in a menu of 14 districts.
 *
 * EMPTY IS "ALL". Nothing ticked writes `"all"` back, not `[]`: an empty list
 * means "resolved to nobody" everywhere downstream, and a menu with no boxes
 * ticked is plainly not asking for no wells.
 */
export function MultiSelect<T extends string | number>({
  options,
  selected,
  onChange,
  allLabel,
  noun,
  ariaLabel,
  width = "w-40",
}: {
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
  allLabel: string;
  /** Pluralised for the count form: "3 districts". */
  noun: string;
  ariaLabel: string;
  width?: string;
}) {
  const label =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? String(selected[0])
        : `${selected.length} ${noun}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="sm"
            variant={selected.length > 0 ? "secondary" : "outline"}
            className={`justify-between gap-1 ${width} text-xs font-normal`}
            aria-label={ariaLabel}
          />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56">
        <DropdownMenuItem
          className="cursor-pointer"
          disabled={selected.length === 0}
          onClick={() => onChange([])}
        >
          {allLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={String(o.value)}
            checked={selected.includes(o.value)}
            onCheckedChange={(v) =>
              onChange(
                v ? [...selected, o.value] : selected.filter((x) => x !== o.value)
              )
            }
            closeOnClick={false}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The county type-ahead, several at a time.
 *
 * 254 counties is past what a checkbox menu can offer, so this stays the search
 * box it always was and grows a chip per pick. The half-typed query is its own
 * state, so it never outlives the picks it produced.
 *
 * Exported for the Recon alerts form, which picks an alert's counties with the
 * same control the bar uses.
 */
export function CountyPicker({
  codes,
  onChange,
}: {
  codes: number[];
  onChange: (next: number[]) => void;
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];
    return COUNTY_OPTIONS.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query]);

  return (
    <Picker
      multi
      selected={codes.map((code) => ({
        key: code,
        label: COUNTY_OPTIONS.find((c) => c.code === code)?.name ?? String(code),
      }))}
      clearLabel="Remove county"
      onRemove={(key) => onChange(codes.filter((c) => c !== key))}
      query={query}
      onQuery={setQuery}
      placeholder="Search county…"
      results={results
        // A county already picked is not a result; offering it again only
        // produces a duplicate chip.
        .filter((c) => !codes.includes(c.code))
        .map((c) => ({
          key: c.code,
          label: c.name,
          onPick: () => {
            onChange([...codes, c.code]);
            setQuery("");
          },
        }))}
    />
  );
}

/**
 * Scout's control bar: one row across the top of the map area, not a card over
 * it. Mode first, then every control that mode uses — inline, including operator
 * mode's four numeric ranges — with the searches and the settings menu pinned
 * right. Nothing is hidden behind a disclosure: a filter that is hiding
 * operators has to be visible while it does it.
 */
const MODE_OPTIONS: { label: string; v: MapMode }[] = [
  { label: "Wells", v: "wells" },
  { label: "Permits", v: "permits" },
  { label: "Operators", v: "operators" },
];

export function MapFilters({
  filters,
  onChange,
  prices,
  onSelectOperator,
  onSelectPrincipal,
  noProductionData = false,
  focusCapped = false,
  permitCounts = null,
  permitPurposes = [],
  onOpenAlerts,
  modes = ["wells", "permits", "operators"],
  bare = false,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  /**
   * Opens the operator's dossier.
   *
   * NOT called in wells mode. There, picking an operator is a map filter and
   * only that: the map redraws to their wells and stays readable, where a modal
   * over the result made you dismiss it to see what you had just asked for.
   * Their dossier is still one click away on any of the dots. Operator mode
   * keeps the dossier, because there the answer to "who is this" IS the point of
   * naming them.
   */
  onSelectOperator: (operatorNumber: number) => void;
  /** Same deal for a person: picking one filters the map AND opens their
   *  principal panel, which is where "who is this" actually gets answered. */
  onSelectPrincipal: (name: string) => void;
  /** Live commodity prices behind the revenue estimate (from the page). */
  prices: CommodityPrices;
  /**
   * True when the loaded operator points carry no production at all — an old
   * `.scout-data/operators.json`. Without this the production/revenue filters
   * would silently blank the map, since absent production reads as zero.
   */
  noProductionData?: boolean;
  /**
   * True when the focus query returned its cap rather than every match, so the
   * map is a sample. Reported here because the bar is what asked for it.
   */
  focusCapped?: boolean;
  /** Live pending-permit queue size, for the bar. */
  permitCounts?: { total: number; approved: number; drilled: number } | null;
  /**
   * Filing purposes present in the permit payload the map has loaded, with
   * their populations (`purposeCounts`). Empty in every other mode, and empty
   * until the first payload lands, which is when the control appears.
   */
  permitPurposes?: PurposeOption[];
  /** Opens the Recon alerts manager. */
  onOpenAlerts?: () => void;
  /**
   * The modes the Show switch offers. With one, the switch is not drawn: the
   * map is that mode only (admin's Prospecting map is Operators only).
   */
  modes?: MapMode[];
  /**
   * Just the controls, no bar: for a host that supplies its own row (the
   * admin Prospecting toolbar, which portals these in beside its tabs).
   */
  bare?: boolean;
}) {
  const [opQuery, setOpQuery] = useState("");
  const [opResults, setOpResults] = useState<OperatorMatch[]>([]);
  const [personQuery, setPersonQuery] = useState("");
  const [personResults, setPersonResults] = useState<PersonMatch[]>([]);
  /*
   * Which collapsed groups are expanded. Independent rather than an accordion:
   * production and revenue are asked together often enough ("who makes a lot of
   * gas but little money") that forcing one shut to open the other would cost
   * more than the row it saves. Both open share ONE row, so the bar grows
   * sideways, not downward.
   */
  const [showProduction, setShowProduction] = useState(false);
  const [showRevenue, setShowRevenue] = useState(false);
  /** Wells mode's own three collapsed groups, on the same terms as those. */
  const [showDepth, setShowDepth] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  /*
   * Wells mode's production band. Its own state rather than `showProduction`
   * above even though the two are never on screen together: they count
   * different bounds, and one flag would carry an operator-mode group open into
   * the well map with the wrong number on it.
   */
  const [showRate, setShowRate] = useState(false);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  /**
   * Switching what the map SHOWS clears what it is filtered to.
   *
   * The modes ask different questions of different records, and a filter set
   * for one carries a different meaning into the next — a county means "wells
   * here" on the well map and "operators who work here" on the operator map,
   * and a depth band means nothing at all to a permit. Carrying them across
   * silently narrowed the new mode to a subset nobody asked for, which reads as
   * missing data rather than as a filter still being on.
   *
   * The gear-menu SETTINGS survive, and so does the DRAWN AREA: those are how
   * the user wants the map drawn and where they are looking, not what they are
   * looking for. `carryAcrossMode` is the one place that list is written down,
   * because Orion's `applyScoutView` has to make the same cut. The collapsed
   * number groups close with the values they held.
   */
  function switchMode(mode: MapMode) {
    setShowProduction(false);
    setShowRevenue(false);
    setShowDepth(false);
    setShowCompleted(false);
    setShowRate(false);
    setOpQuery("");
    setOpResults([]);
    setPersonQuery("");
    setPersonResults([]);
    onChange(carryAcrossMode(filters, mode, DEFAULT_FILTERS));
  }

  const productionBounds = boundCount(
    filters.minOil12,
    filters.maxOil12,
    filters.minGas12,
    filters.maxGas12
  );
  const revenueBounds = boundCount(filters.minRevenue, filters.maxRevenue);
  const depthBounds = boundCount(filters.minDepth, filters.maxDepth);
  /*
   * Newest year first. Built here rather than at module scope so the current
   * year is read during a render, not once when the bundle is evaluated — and
   * only ever RENDERED behind `showCompleted`, which starts closed, so the
   * options never exist during hydration and cannot mismatch the server's.
   */
  const years = useMemo(() => {
    const now = new Date().getUTCFullYear();
    return Array.from(
      { length: now - EARLIEST_COMPLETION_YEAR + 1 },
      (_, i) => now - i
    );
  }, []);
  const completedBounds = boundCount(
    filters.minCompletionYear,
    filters.maxCompletionYear
  );
  const rateBounds = boundCount(
    filters.minOilRate,
    filters.maxOilRate,
    filters.minGasRate,
    filters.maxGasRate
  );
  const expanded =
    (filters.mode === "operators" && (showProduction || showRevenue)) ||
    (filters.mode === "wells" && (showDepth || showCompleted || showRate));

  /*
   * A GROUP THAT IS FILTERING OPENS ITSELF, mid-render.
   *
   * The button carries its bound count from the closed state, which is enough
   * when the user typed the values: they know what they set. It is not enough
   * when something else sets them — Orion drives this bar through
   * `scout_set_view` and writes the same `Filters` the boxes write, and a filter
   * the user never touched has to be readable at a glance rather than one click
   * away.
   *
   * Adjusted during the render that sees the change rather than in an effect, so
   * the group is never painted closed over values it is hiding. Opens only:
   * closing stays the user's decision, and `switchMode` shuts them with the
   * values.
   */
  const [seenBounds, setSeenBounds] = useState({
    depth: 0,
    completed: 0,
    rate: 0,
    production: 0,
    revenue: 0,
  });
  if (
    seenBounds.depth !== depthBounds ||
    seenBounds.completed !== completedBounds ||
    seenBounds.rate !== rateBounds ||
    seenBounds.production !== productionBounds ||
    seenBounds.revenue !== revenueBounds
  ) {
    setSeenBounds({
      depth: depthBounds,
      completed: completedBounds,
      rate: rateBounds,
      production: productionBounds,
      revenue: revenueBounds,
    });
    if (depthBounds > seenBounds.depth) setShowDepth(true);
    if (completedBounds > seenBounds.completed) setShowCompleted(true);
    if (rateBounds > seenBounds.rate) setShowRate(true);
    if (productionBounds > seenBounds.production) setShowProduction(true);
    if (revenueBounds > seenBounds.revenue) setShowRevenue(true);
  }

  useEffect(() => {
    if (filters.operator) return;
    const q = opQuery.trim();
    const t = setTimeout(() => {
      if (q.length < 2) {
        setOpResults([]);
        return;
      }
      searchOperators(q).then(setOpResults).catch(() => setOpResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [opQuery, filters.operator]);

  /*
   * People come from the RRC mirror over a gated route, not from the Archon
   * copy the rest of this bar reads: it is the fresher and trigram-indexed one
   * (see `rrc-people.ts`). Hence the AbortController — a slow answer for "bor"
   * must not overwrite the results for "borderline", the same rule the RRC
   * browser's search follows.
   */
  useEffect(() => {
    if (filters.person) return;
    const q = personQuery.trim();
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (q.length < 2) {
        setPersonResults([]);
        return;
      }
      searchPeople(q, ctrl.signal)
        .then(setPersonResults)
        .catch(() => {
          if (!ctrl.signal.aborted) setPersonResults([]);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [personQuery, filters.person]);

  const countyPicker = (
    <CountyPicker
      // Keyed by mode: `switchMode` clears the value, and a half-typed county
      // name left in the box would otherwise outlive the search it was for.
      key={filters.mode}
      codes={chosen(filters.county) ?? []}
      onChange={(v) => set({ county: v.length === 0 ? "all" : v })}
    />
  );

  const operatorPicker = (
    <Picker
      selected={
        filters.operator
          ? [
              {
                key: filters.operator.operator_number,
                label:
                  partyName(filters.operator.operator_name) ||
                  String(filters.operator.operator_number),
              },
            ]
          : []
      }
      clearLabel="Clear operator"
      onRemove={() => {
        set({ operator: null });
        setOpQuery("");
        setOpResults([]);
      }}
      query={opQuery}
      onQuery={setOpQuery}
      placeholder="Search operator…"
      results={opResults.map((o) => ({
        key: o.operator_number,
        label: partyName(o.operator_name) || String(o.operator_number),
        onPick: () => {
          set({ operator: o });
          setOpResults([]);
          // Wells mode: filter only. See `onSelectOperator`.
          if (filters.mode !== "wells") {
            onSelectOperator(o.operator_number);
          }
        },
      }))}
    />
  );

  // People are attached to operating companies, so a person means "every
  // operator this person is on". The picker resolves the name; the map turns it
  // into that set of operators (see `personOpsRef` in scout-map.tsx).
  const personPicker = (
    <Picker
      selected={
        filters.person ? [{ key: filters.person, label: partyName(filters.person) }] : []
      }
      clearLabel="Clear person"
      onRemove={() => {
        set({ person: null });
        setPersonQuery("");
        setPersonResults([]);
      }}
      query={personQuery}
      onQuery={setPersonQuery}
      placeholder="Search person…"
      results={personResults.map((p) => ({
        key: p.officer_name,
        label: partyName(p.officer_name),
        sub: [
          `${p.operator_count} operator${p.operator_count === 1 ? "" : "s"}`,
          p.total_wells > 0 ? `${p.total_wells.toLocaleString()} wells` : null,
          [p.city, p.state].filter(Boolean).join(", ") || null,
        ]
          .filter(Boolean)
          .join(" · "),
        onPick: () => {
          set({ person: p.officer_name });
          setPersonResults([]);
          setPersonQuery("");
          onSelectPrincipal(p.officer_name);
        },
      }))}
    />
  );

  return (
    <div
      className={
        bare
          ? "contents"
          : "relative z-20 flex shrink-0 flex-col border-b border-border bg-background"
      }
    >
      {/* `gap-y-3` is the gap BETWEEN wrapped rows, not padding on any one of
          them: the bar is a single wrapping flex row, so a second row appears
          only when the window is too narrow to hold everything, and this is what
          keeps it from sitting tight under the first. Bare, the host's row is
          the row, and these controls join it as siblings of its own. */}
      <div className={bare ? "contents" : "flex min-h-11 flex-wrap items-center gap-x-2 gap-y-3 px-3 py-2"}>
        {modes.length > 1 && (
          <>
            <BarField label="Show">
              <Seg
                value={filters.mode}
                onSelect={switchMode}
                options={MODE_OPTIONS.filter((o) => modes.includes(o.v))}
              />
            </BarField>

            <Divider />
          </>
        )}

        {filters.mode === "wells" && (
          <>
            <BarField label="Type">
              <Seg
                value={filters.oilGas}
                onSelect={(v) => set({ oilGas: v })}
                options={[
                  { label: "All", v: "all" },
                  { label: "Oil", v: "O" },
                  { label: "Gas", v: "G" },
                ]}
              />
            </BarField>

            <BarField label="Status">
              <SegMulti
                values={chosen(filters.status) ?? []}
                allLabel="All"
                onChange={(v) => set({ status: v.length === 0 ? "all" : v })}
                options={[
                  { label: "Active", v: "active" as WellActivity },
                  { label: "Inactive", v: "inactive" as WellActivity },
                  { label: "Plugged", v: "plugged" as WellActivity },
                ]}
              />
            </BarField>

            <BarField label="District">
              <MultiSelect
                ariaLabel="District"
                allLabel="All districts"
                noun="districts"
                width="w-32"
                options={DISTRICTS.map((d) => ({ value: d, label: `District ${d}` }))}
                selected={chosen(filters.district) ?? []}
                onChange={(v) => set({ district: v.length === 0 ? "all" : v })}
              />
            </BarField>

            {/* Distinct from "Type" above, which is the commodity the well is
                classified against (oil vs gas). This is what the well DOES
                today: producing, injecting, shut in, storage. */}
            <BarField label="Well type">
              <MultiSelect
                ariaLabel="Well type"
                allLabel="All well types"
                noun="well types"
                options={WELL_TYPES}
                selected={chosen(filters.wellType) ?? []}
                onChange={(v) => set({ wellType: v.length === 0 ? null : v })}
              />
            </BarField>

            {/* Depth and completion year are collapsed for the same reason
                operator mode's ranges are: four more boxes inline would push the
                county/operator/person searches off the row. Both are answered by
                the focus query rather than the tiles, so either one narrows the
                map to its matches the way a county does. */}
            <GroupToggle
              label="Depth"
              open={showDepth}
              onToggle={() => setShowDepth((v) => !v)}
              bounds={depthBounds}
              title="Total depth in feet, from the wellbore's reported API depth."
            />

            <GroupToggle
              label="Completed"
              open={showCompleted}
              onToggle={() => setShowCompleted((v) => !v)}
              bounds={completedBounds}
              title="Completion year, from the RRC's completion date. Wells with no completion date on file are excluded once either end is set."
            />

            {/* The same two boxes operator mode's Production group carries, one
                grain down: the WELL's rate rather than the operator's. */}
            <GroupToggle
              label="Production"
              open={showRate}
              onToggle={() => setShowRate((v) => !v)}
              bounds={rateBounds}
              title="Oil (bbl) and gas (MCF) per month, allocated to the well over its last 12 filed months rather than read off a meter. Wells with no production on file are excluded once either end is set."
            />

            {/* A depth or year band with no place attached matches six figures
                of wells, past what the focus query returns. Say the map is a
                sample rather than letting it pass for the whole answer. */}
            {focusCapped && (
              <span
                title="More wells match than the map draws, so this is the first 30,000 by API number — which is county order, not a spread across the state. Add a county, district or operator to see the real answer."
                className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="size-3" />
                Showing a sample
              </span>
            )}
          </>
        )}

        {/* Operator mode used to run all four ranges straight across the bar,
            which left no room for the county and name searches every other mode
            has. Production (oil + gas) and revenue now collapse behind a button
            each and open into the row below. Production is what the operator
            itself reported to the RRC over the last 12 months, so one that
            reported nothing counts as 0 and any Min above 0 hides them. */}
        {filters.mode === "operators" && (
          <>
            <BarField label="Wells">
              <Range
                width="w-20"
                label="wells operated"
                min={filters.minWells}
                max={filters.maxWells}
                onMin={(v) => set({ minWells: v })}
                onMax={(v) => set({ maxWells: v })}
              />
            </BarField>

            <GroupToggle
              label="Production"
              open={showProduction}
              onToggle={() => setShowProduction((v) => !v)}
              bounds={productionBounds}
              title="Oil (bbl) and gas (MCF) the operator itself reported, per month: its last 12 months over 12."
            />

            <GroupToggle
              label="Revenue"
              open={showRevenue}
              onToggle={() => setShowRevenue((v) => !v)}
              bounds={revenueBounds}
              title={`Estimated $/month: the operator's own last-12-month production ÷ 12 at $${prices.oilPerBbl.toFixed(
                2
              )}/bbl and $${prices.gasPerMcf.toFixed(
                2
              )}/MCF. Gross, before royalty and deducts.`}
            />

            {noProductionData && (
              <span
                title="No production figures in the loaded operator data — production and revenue filters will match nothing. Re-run scripts/scout-sync-data.mjs, then hard-refresh."
                className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="size-3" />
                No production data
              </span>
            )}
          </>
        )}

        {filters.mode === "permits" && (
          <>
            {permitCounts && (
              <BarField label="Queue">
                <span className="text-sm tabular-nums">
                  {permitCounts.total.toLocaleString()} pending
                </span>
              </BarField>
            )}
            {/* Only once a payload has been counted: an empty menu is a control
                that looks broken. */}
            {permitPurposes.length > 0 && (
              <BarField label="Purpose">
                <PurposeFilter
                  options={permitPurposes}
                  selected={filters.permitPurpose}
                  onChange={(v) => set({ permitPurpose: v })}
                />
              </BarField>
            )}
            <BarField label="Date">
              <div
                className="flex items-center gap-1"
                title="Filed date for a pending permit, issue date for an approved or drilled one."
              >
                <DatePicker
                  value={isoToDate(filters.permitSince)}
                  onChange={(d) => {
                    const since = dateToIso(d);
                    set({
                      permitSince: since,
                      // A floor raised past the ceiling drags the ceiling with
                      // it, as the completion years do.
                      permitUntil:
                        since && filters.permitUntil && filters.permitUntil < since
                          ? since
                          : filters.permitUntil,
                    });
                  }}
                  placeholder="From"
                  className="h-7 w-32 text-xs"
                />
                <span className="text-xs text-muted-foreground">–</span>
                <DatePicker
                  value={isoToDate(filters.permitUntil)}
                  onChange={(d) => set({ permitUntil: dateToIso(d) })}
                  placeholder="To"
                  className="h-7 w-32 text-xs"
                  disabled={(d) =>
                    filters.permitSince != null && dateToIso(d)! < filters.permitSince
                  }
                />
              </div>
            </BarField>
            {(filters.permitSince || filters.permitUntil) && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => set({ permitSince: null, permitUntil: null })}
              >
                Clear date
              </Button>
            )}
          </>
        )}

        {/* County + operator + person, in every mode. They mean something
            different in operator mode — see the county note on
            `getCountyOperators`: operators sit at their mailing address, so a
            county picks who WORKS there, not who is based there, and the
            matching points stay scattered statewide. That is why the label says
            "Works in". Person is the third way in: not a place or a company but
            the people behind them, resolved to their operators. */}
        {/* Flows straight on from the mode's own controls rather than being
            pushed right. On a narrow window the bar wraps and this group lands
            on its own row, where `ml-auto` stranded it against the right edge
            with a gulf of empty bar to its left; the settings button keeps the
            right end for itself. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <BarField label={filters.mode === "operators" ? "Works in" : "County"}>
            {countyPicker}
          </BarField>
          <BarField label={filters.mode === "operators" ? "Name" : "Operator"}>
            {operatorPicker}
          </BarField>
          <BarField label="Person">{personPicker}</BarField>

          <Divider />

          {onOpenAlerts && (
            <Button size="sm" variant="ghost" onClick={onOpenAlerts}>
              <Bell className="size-4" />
              Alerts
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Map settings"
                  className="ml-auto"
                />
              }
            >
              <Settings className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Map settings</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={filters.excludePlugged}
                  onCheckedChange={(v) => set({ excludePlugged: v })}
                  closeOnClick={false}
                >
                  Exclude plugged wells
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={filters.showSurveys}
                  onCheckedChange={(v) => set({ showSurveys: v })}
                  closeOnClick={false}
                >
                  Survey lines
                  {/* The control is always available, but the layer only draws
                      once close enough to read, so say so rather than letting a
                      zoomed-out user think the toggle is broken. */}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    zoom 12+
                  </span>
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={filters.showPipelines}
                  onCheckedChange={(v) => set({ showPipelines: v })}
                  closeOnClick={false}
                >
                  Pipelines
                  {/* The opposite of the survey rule: trunk lines draw from the
                      whole state and thinner pipe joins as you zoom. */}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    all zooms
                  </span>
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* The expansion. One row for both groups, so opening the second widens it
          rather than pushing the map down again. Tinted and rule-separated so it
          reads as belonging to the buttons above rather than as a second bar. */}
      {expanded && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 bg-muted/30 px-3 py-2">
          {filters.mode === "wells" && showDepth && (
            <>
              <BarField label="Depth ft">
                {/* The boxes and the bars write the same two values. The boxes
                    are how you enter 8,437; the bars are how you find out that
                    8,000 to 10,000 feet is 72,711 wells, and that there is a
                    tail past 16,000 worth looking at. */}
                <div className="flex items-center gap-2">
                  <Range
                    label="total depth in feet"
                    width="w-24"
                    min={filters.minDepth}
                    max={filters.maxDepth}
                    onMin={(v) => set({ minDepth: v })}
                    onMax={(v) => set({ maxDepth: v })}
                  />
                  <div className="w-44">
                    <RangeHistogram
                      field="depth"
                      label="total depth in feet"
                      min={filters.minDepth}
                      max={filters.maxDepth}
                      onChange={(minDepth, maxDepth) => set({ minDepth, maxDepth })}
                    />
                  </div>
                </div>
              </BarField>

              {depthBounds > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => set({ minDepth: null, maxDepth: null })}
                >
                  Clear depth
                </Button>
              )}
            </>
          )}

          {filters.mode === "wells" && showDepth && showCompleted && <Divider />}

          {filters.mode === "wells" && showCompleted && (
            <>
              <BarField label="Completed">
                <div className="flex items-center gap-1">
                  <YearSelect
                    label="Earliest completion year"
                    placeholder="From"
                    years={years}
                    value={filters.minCompletionYear}
                    // Raising the floor above the ceiling drags the ceiling with
                    // it. Restricting the "To" list below stops the pair being
                    // BUILT backwards; this stops it being left that way after
                    // the fact, which the list alone cannot do.
                    onChange={(v) =>
                      set({
                        minCompletionYear: v,
                        maxCompletionYear:
                          v != null &&
                          filters.maxCompletionYear != null &&
                          filters.maxCompletionYear < v
                            ? v
                            : filters.maxCompletionYear,
                      })
                    }
                  />
                  <span className="text-xs text-muted-foreground">–</span>
                  <YearSelect
                    label="Latest completion year"
                    placeholder="To"
                    // The upper list starts at the lower bound, so the pair
                    // cannot be set to an empty range in the first place.
                    years={
                      filters.minCompletionYear == null
                        ? years
                        : years.filter((y) => y >= filters.minCompletionYear!)
                    }
                    value={filters.maxCompletionYear}
                    onChange={(v) => set({ maxCompletionYear: v })}
                  />
                  {/* Five-year bars, so a thumb lands on the step it is drawn
                      over while the lists above still offer every year. */}
                  <div className="ml-1 w-44">
                    <RangeHistogram
                      field="completionYear"
                      label="completion year"
                      min={filters.minCompletionYear}
                      max={filters.maxCompletionYear}
                      onChange={(minCompletionYear, maxCompletionYear) =>
                        set({ minCompletionYear, maxCompletionYear })
                      }
                    />
                  </div>
                </div>
                {/* The exclusion is the surprising half of this filter, so it is
                    stated on screen rather than only in the button's tooltip. */}
                {completedBounds > 0 && (
                  <span
                    className="text-[10px] text-muted-foreground"
                    title="About 8% of on-schedule wellbores carry no completion date. An unknown date cannot be shown to fall inside the range, so those wells drop out."
                  >
                    excl. undated
                  </span>
                )}
              </BarField>

              {completedBounds > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    set({ minCompletionYear: null, maxCompletionYear: null })
                  }
                >
                  Clear completed
                </Button>
              )}
            </>
          )}

          {filters.mode === "wells" && (showDepth || showCompleted) && showRate && (
            <Divider />
          )}

          {/* Built from the same `Range` pair as operator mode's block below,
              with the same labels and the same units, because it is the same
              question asked of a well instead of a company. */}
          {filters.mode === "wells" && showRate && (
            <>
              <BarField label="Oil bbl/mo">
                <Range
                  label="oil in bbl per month"
                  min={filters.minOilRate}
                  max={filters.maxOilRate}
                  onMin={(v) => set({ minOilRate: v })}
                  onMax={(v) => set({ maxOilRate: v })}
                />
              </BarField>

              <BarField label="Gas MCF/mo">
                <Range
                  label="gas in MCF per month"
                  min={filters.minGasRate}
                  max={filters.maxGasRate}
                  onMin={(v) => set({ minGasRate: v })}
                  onMax={(v) => set({ maxGasRate: v })}
                />
              </BarField>

              {rateBounds > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    set({
                      minOilRate: null,
                      maxOilRate: null,
                      minGasRate: null,
                      maxGasRate: null,
                    })
                  }
                >
                  Clear production
                </Button>
              )}
            </>
          )}

          {filters.mode === "operators" && showProduction && (
            <>
              <BarField label="Oil bbl/mo">
                <Range
                  label="oil in bbl per month"
                  min={filters.minOil12}
                  max={filters.maxOil12}
                  onMin={(v) => set({ minOil12: v })}
                  onMax={(v) => set({ maxOil12: v })}
                />
              </BarField>

              <BarField label="Gas MCF/mo">
                <Range
                  label="gas in MCF per month"
                  min={filters.minGas12}
                  max={filters.maxGas12}
                  onMin={(v) => set({ minGas12: v })}
                  onMax={(v) => set({ maxGas12: v })}
                />
              </BarField>

              {productionBounds > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    set({
                      minOil12: null,
                      maxOil12: null,
                      minGas12: null,
                      maxGas12: null,
                    })
                  }
                >
                  Clear production
                </Button>
              )}
            </>
          )}

          {filters.mode === "operators" && showProduction && showRevenue && (
            <Divider />
          )}

          {filters.mode === "operators" && showRevenue && (
            <>
              <BarField label="Est. $/mo">
                <Range
                  label="estimated revenue per month in dollars"
                  min={filters.minRevenue}
                  max={filters.maxRevenue}
                  onMin={(v) => set({ minRevenue: v })}
                  onMax={(v) => set({ maxRevenue: v })}
                />
                {/* The estimate is only as good as the quotes behind it, and both
                    move during the session, so the basis stays on screen. */}
                <span
                  className="text-[10px] text-muted-foreground"
                  title={`The operator's own last-12-month production ÷ 12, at $${prices.oilPerBbl.toFixed(
                    2
                  )}/bbl and $${prices.gasPerMcf.toFixed(
                    2
                  )}/MCF. Gross, before royalty and deducts.`}
                >
                  @${prices.oilPerBbl.toFixed(0)}/${prices.gasPerMcf.toFixed(2)}
                </span>
              </BarField>

              {revenueBounds > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => set({ minRevenue: null, maxRevenue: null })}
                >
                  Clear revenue
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
