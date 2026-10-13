/**
 * The preset field list for a well's Info tab (russell-feedback-one.md:16). The
 * Info tab arrives pre-loaded with a standard set of fields — a different one for
 * producing and for SWD/injection wells — and the user can still add fields of
 * their own.
 *
 * A template is a DISPLAY overlay on the existing `well_equipment` label/value
 * rows, not new storage. Slots are virtual until filled: the panel renders the
 * union of (template slots, in order) and (stored rows matching no slot, appended
 * after). Each row is edited/created through the detail modal.
 *
 * Matching is by NORMALIZED label with per-slot aliases, using the same
 * `canonical` the ingest dedup keys use — so a row Orion wrote as "Tbg Pump"
 * lands in the "Downhole pump" slot instead of appearing as a duplicate.
 * `well-info-template.test.ts` asserts every alias canonicalizes distinctly and
 * no two slots claim the same key.
 *
 * Pure module (no DOM, no server deps) so it is testable and importable anywhere.
 */

import { canonical } from "@/lib/ai/ingest/normalize";
import type { WellEquipment, WellType } from "@/lib/wells/wells";

/** One preset field on the well info sheet. */
export interface InfoSlot {
  /** Canonical display label — what the user sees and what a filled row is titled. */
  label: string;
  /** Other labels that mean this same slot (abbreviations already in the field). */
  aliases?: string[];
}

/**
 * The joint count and tubing depth are intentionally ABSENT from both templates:
 * the tubing tally owns them now (see `isTallyEquipmentLabel` in wells.ts). Well
 * name and perforations are absent too — they live in the well header / settings,
 * not as editable info rows.
 */

const CHEMICAL_SLOTS: InfoSlot[] = [
  // A standing dose program, four slots rather than one opaque string so it is
  // filterable/reportable later (B4). Dated chemical JOBS stay in Service.
  { label: "Chemical" },
  { label: "Treatment rate" },
  { label: "Treatment method" },
  { label: "Chemical vendor" },
];

/** Producing-well info sheet. */
export const PRODUCER_INFO_TEMPLATE: InfoSlot[] = [
  { label: "KB", aliases: ["RKB"] },
  // How the well is lifted. Seeded from the W-10 producing method at import
  // (`rrc/well-record.ts`), which is why it sits above the pump it describes.
  // Producers only: an injection well does not produce, and a row whose label
  // matches no slot renders as a stray "additional field" below the sheet.
  { label: "Producing method", aliases: ["Lift method", "Artificial lift"] },
  { label: "Downhole pump", aliases: ["Tbg Pump", "Pump"] },
  { label: "SN", aliases: ["Seating Nipple", "Seat Nipple"] },
  { label: "Tubing", aliases: ["Tbg"] },
  { label: "Polish rod", aliases: ["PR"] },
  { label: "Polish rod liner", aliases: ["PRL"] },
  { label: "Rod subs" },
  { label: "Rods", aliases: ["Rods 7/8", "Rod String"] },
  { label: "Casing" },
  { label: "Casing depth" },
  { label: "Rod depth" },
  { label: "Plug back or bridge plugs", aliases: ["Plug Back", "PBTD", "Bridge Plug"] },
  { label: "Top of cement", aliases: ["TOC"] },
  { label: "Surface casing", aliases: ["Surface"] },
  { label: "Surface casing depth" },
  { label: "Pumping unit", aliases: ["Unit"] },
  { label: "Motor" },
  { label: "Sheave" },
  { label: "Belts" },
  ...CHEMICAL_SLOTS,
  { label: "Oil tanks good" },
  { label: "Oil tanks bad" },
  { label: "Water tanks good" },
  { label: "Water tanks bad" },
];

/**
 * SWD / injection info sheet. Drops the whole rod string, pumping unit, motor,
 * sheave and belts (no beam pump on an injection well) and adds the packer + its
 * setting depth. Tank counts lead with water. Plunger size is NOT a slot — it is
 * `wells.plunger_size`, which the settings dialog no longer edits; add a slot
 * here (or to the org's own field list) if the pumper needs to record it.
 */
export const INJECTION_INFO_TEMPLATE: InfoSlot[] = [
  { label: "KB", aliases: ["RKB"] },
  { label: "Injection pump", aliases: ["Pump"] },
  { label: "Packer" },
  { label: "Setting depth", aliases: ["Packer Depth", "Packer Setting Depth"] },
  { label: "SN", aliases: ["Seating Nipple", "Seat Nipple"] },
  { label: "Tubing", aliases: ["Tbg"] },
  { label: "Casing" },
  { label: "Casing depth" },
  { label: "Plug back or bridge plugs", aliases: ["Plug Back", "PBTD", "Bridge Plug"] },
  { label: "Top of cement", aliases: ["TOC"] },
  { label: "Surface casing", aliases: ["Surface"] },
  { label: "Surface casing depth" },
  ...CHEMICAL_SLOTS,
  { label: "Water tanks good" },
  { label: "Water tanks bad" },
  { label: "Oil tanks good" },
  { label: "Oil tanks bad" },
];

/** The template for a well of the given type. */
export function infoTemplateFor(type: WellType): InfoSlot[] {
  return type === "injection" ? INJECTION_INFO_TEMPLATE : PRODUCER_INFO_TEMPLATE;
}

/**
 * The tubing tally leads a well's info sheet but is NOT a template slot — it has
 * its own row and its own editor (`well-info-panel.tsx`), so it is named here
 * for the surfaces that list the sheet's rows rather than render them.
 */
export const TALLY_FIELD_LABEL = "Tubing tally";

/**
 * Every row of a well's info sheet for a well type, in the order the well page
 * prints them. A well's own added fields and its formation tops are per-well and
 * are not part of it.
 *
 * These are the DEFAULTS only. An org's live sheet lives in `well_info_fields`
 * and is read through `@/lib/wells/well-info-fields`; this is what that table is
 * seeded with, and the fallback for an org that has no rows yet.
 */
export function infoSheetFields(type: WellType): string[] {
  return defaultInfoFields(type).map((field) => field.label);
}

/** One field on an org's own info sheet — a `well_info_fields` row. */
export interface WellInfoField {
  id: string;
  label: string;
  /** Alternate labels that mean this field, matched canonically. */
  aliases: string[];
  /** Print order within the sheet. */
  sortOrder: number;
  /**
   * What kind of row this is on the well page. `tally` is the tubing tally,
   * which that table renders itself as a link to the tally editor; everything
   * else is an ordinary label/value slot. Marked at seed time and NOT derived
   * from the label, which the org may rename (2026081200400).
   */
  kind: WellInfoFieldKind;
}

export type WellInfoFieldKind = "field" | "tally";

/**
 * The default sheet for a well type as fields: the tubing tally, then the
 * template. Sort orders are gapped by 10 so a field can later be dropped between
 * two others without renumbering the sheet.
 */
export function defaultInfoFields(type: WellType): Omit<WellInfoField, "id">[] {
  const slots: InfoSlot[] = [
    { label: TALLY_FIELD_LABEL },
    ...infoTemplateFor(type),
  ];
  return slots.map((slot, i) => ({
    label: slot.label,
    aliases: slot.aliases ?? [],
    sortOrder: (i + 1) * 10,
    kind: i === 0 ? ("tally" as const) : ("field" as const),
  }));
}

/**
 * The defaults as a field list, for a caller with no org sheet to hand (a
 * workspace rendered without one, or an org whose rows haven't been seeded).
 * The ids mark them as unstored, so an edit aimed at one is refused rather than
 * silently dropped.
 */
export function defaultInfoFieldList(type: WellType): WellInfoField[] {
  return defaultInfoFields(type).map((field) => ({
    ...field,
    id: `${DEFAULT_FIELD_ID_PREFIX}${type}:${field.label}`,
  }));
}

/** Marks a field that is a hardcoded default rather than a stored row. */
export const DEFAULT_FIELD_ID_PREFIX = "default:";

/**
 * The template slots a well's Info tab renders, from the org's fields.
 *
 * The tally is dropped on the way through: that table renders it as its own row
 * (a link to the tally editor), so leaving it in the slot list would print the
 * field twice. It is recognised by `kind`, never by its label — matching on the
 * label meant renaming the row in Settings produced exactly that duplicate.
 */
export function slotsFromFields(fields: WellInfoField[]): InfoSlot[] {
  return fields
    .filter((field) => field.kind !== "tally")
    .map((field) => ({ label: field.label, aliases: field.aliases }));
}

/**
 * What the well page's Info table titles its tubing-tally row, or null when the
 * org has taken the tally off the sheet — in which case that table shows no
 * tally row at all.
 */
export function tallyLabelOf(fields: WellInfoField[]): string | null {
  return fields.find((field) => field.kind === "tally")?.label ?? null;
}

/**
 * One row of a well's Info table. The tally is a row of its own — it opens the
 * tally spreadsheet rather than a value editor — but it is NOT pinned to the top:
 * it sits wherever the org dragged it in Settings, like every other row.
 *
 * `fieldId` is the `well_info_fields` row this came from, carried through so the
 * Info tab can drag rows into a new order without re-deriving which field a row
 * is (a label is not an identity: the org may rename or duplicate one).
 */
export type InfoRowItem =
  | { kind: "tally"; fieldId: string; label: string }
  | {
      kind: "field";
      fieldId: string;
      slot: InfoSlot;
      row: WellEquipment | null;
    };

/**
 * Exactly what the well page's Info table renders, given the org's sheet and the
 * well's stored rows: one row per field on the sheet, IN THE SHEET'S ORDER, each
 * carrying the stored row that fills it.
 *
 * **The sheet is the whole table.** A stored `well_equipment` row whose label
 * matches no field (`offSheet` below) is NOT rendered. Those are leftovers from
 * imports and older templates — a well carrying eighteen blank "Tbg Anchor" /
 * "Kbars" rows made the well page disagree with the list the operator just
 * edited in Settings, which is the whole point of that list. Nothing is deleted:
 * the rows stay in the database and reappear the moment the sheet carries their
 * label again.
 *
 * **Order is the sheet's, all of it.** The tally used to be rendered ahead of the
 * slots, so dragging it down in Settings changed nothing. Here it is spliced back
 * into its own position: the slots keep the order `slotsFromFields` gave them, so
 * walking `fields` and taking the next slot at each non-tally field puts every
 * row back where the admin put it.
 *
 * The one place that decision is made, so `WellInfoPanel`'s props and the tests
 * that assert what an admin's edit did to a well page read the same function.
 */
export function wellInfoView(
  fields: WellInfoField[],
  equipment: WellEquipment[]
): {
  /** Every row the table renders, in sheet order. */
  rows: InfoRowItem[];
  /** Stored rows on no field — kept out of the table, returned so a caller can
   *  count or surface them elsewhere. */
  offSheet: WellEquipment[];
} {
  const matched = matchInfoSlots(slotsFromFields(fields), equipment);
  let next = 0;
  const rows: InfoRowItem[] = fields.map((field) => {
    if (field.kind === "tally") {
      return { kind: "tally", fieldId: field.id, label: field.label };
    }
    const resolved = matched.slots[next++];
    return {
      kind: "field",
      fieldId: field.id,
      slot: resolved.slot,
      row: resolved.row,
    };
  });
  return { rows, offSheet: matched.extras };
}

/** The Info table's rows in render order, as labels — the testable surface. */
export function wellInfoRowLabels(
  fields: WellInfoField[],
  equipment: WellEquipment[]
): string[] {
  return wellInfoView(fields, equipment).rows.map((item) =>
    item.kind === "tally" ? item.label : item.slot.label
  );
}

/** Canonical keys a slot claims — its label plus every alias. */
export function slotKeys(slot: InfoSlot): string[] {
  return [slot.label, ...(slot.aliases ?? [])].map(canonical);
}

/**
 * The preset field labels across both templates, for Orion's `add_well_equipment`
 * tool description — so the labels it writes land in slots instead of creating a
 * duplicate row beside an empty slot. Deduped, producer-then-injection order.
 * The tubing tally's own labels are appended: Orion still extracts them, and the
 * tally UI (not a slot) consumes them.
 */
export const INFO_TEMPLATE_TOOL_LABELS: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slot of [...PRODUCER_INFO_TEMPLATE, ...INJECTION_INFO_TEMPLATE]) {
    if (!seen.has(slot.label)) {
      seen.add(slot.label);
      out.push(slot.label);
    }
  }
  for (const label of ["#jts", "Tubing Depth"]) {
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
})();

/** A template slot paired with the stored equipment row that fills it, if any. */
export interface ResolvedSlot {
  slot: InfoSlot;
  /** The stored row filling this slot, or null when the slot is still empty. */
  row: WellEquipment | null;
}

/** A template resolved against a well's stored rows. */
export interface MatchedInfo {
  /** Template slots in order, each carrying its stored row (or null). */
  slots: ResolvedSlot[];
  /** Stored rows that matched no slot — the user's own fields, in row order. */
  extras: WellEquipment[];
}

/**
 * Pair each template slot with the stored equipment row whose label matches it
 * (by canonical label / alias), and collect the rest as "additional fields". A
 * label matches at most one slot (first slot to claim its canonical key wins),
 * and each row fills at most one slot.
 */
export function matchInfoSlots(
  template: InfoSlot[],
  rows: WellEquipment[]
): MatchedInfo {
  const keyToSlot = new Map<string, number>();
  template.forEach((slot, i) => {
    for (const key of slotKeys(slot)) {
      if (key && !keyToSlot.has(key)) keyToSlot.set(key, i);
    }
  });

  const rowForSlot: (WellEquipment | null)[] = template.map(() => null);
  const claimed = new Set<string>();
  for (const row of rows) {
    const idx = keyToSlot.get(canonical(row.label));
    if (idx != null && rowForSlot[idx] == null) {
      rowForSlot[idx] = row;
      claimed.add(row.id);
    }
  }

  return {
    slots: template.map((slot, i) => ({ slot, row: rowForSlot[i] })),
    extras: rows.filter((r) => !claimed.has(r.id)),
  };
}
