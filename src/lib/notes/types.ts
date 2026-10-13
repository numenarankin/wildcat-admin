/**
 * Shared note + tag shapes. Pure module (no `server-only` imports): imported by
 * the client editor / picker as well as the server data layer, so it must stay
 * free of server-only imports — mirrors `@/lib/comments/types`.
 */

/** The families a tag belongs to; the picker groups by this. */
export type NoteTagKind = "facility" | "person" | "project";

/**
 * Every taggable target type. Mirrors the SQL check constraint on
 * `note_tags.target_type` (2026073000500_notes.sql). SWD wells collapse into
 * `well` and water meters into `meter`, exactly as facility_comments does — an
 * SWD facility is the same DB row as its production counterpart.
 */
export type NoteTagType =
  | "well"
  | "tank"
  | "meter"
  | "battery"
  | "lease"
  | "member"
  | "employee"
  | "contractor"
  | "service_provider"
  | "royalty_owner"
  | "gatherer"
  /** A project folder. Tagging one files the note on that project's Notes tab. */
  | "project";

/** Which family each tag type belongs to. */
export const TAG_KIND_BY_TYPE: Record<NoteTagType, NoteTagKind> = {
  well: "facility",
  tank: "facility",
  meter: "facility",
  battery: "facility",
  lease: "facility",
  member: "person",
  employee: "person",
  contractor: "person",
  service_provider: "person",
  royalty_owner: "person",
  gatherer: "person",
  project: "project",
};

/** Human labels for each tag type, for grouping headers and chip prefixes. */
export const TAG_TYPE_LABEL: Record<NoteTagType, string> = {
  well: "Well",
  tank: "Tank",
  meter: "Meter",
  battery: "Battery",
  lease: "Lease",
  member: "Team",
  employee: "Employee",
  contractor: "Contractor",
  service_provider: "Service provider",
  royalty_owner: "Interest owner",
  gatherer: "Gatherer",
  project: "Project",
};

/** A tag as stored on a note and rendered as a chip. */
export interface NoteTag {
  type: NoteTagType;
  /** The target's id — a well slug or a uuid rendered as text. */
  id: string;
  /** Display name, snapshotted at tag time. */
  label: string;
  kind: NoteTagKind;
}

/** A note as it appears in a list / card grid. */
export interface NoteSummary {
  id: string;
  title: string;
  /** Plain-text preview derived from the HTML body. */
  snippet: string;
  tags: NoteTag[];
  updatedAt: string;
  author: string | null;
}

/** A full note, as loaded into the editor. */
export interface Note {
  id: string;
  title: string;
  /** HTML body (the editor round-trips `getHTML()`). */
  content: string;
  tags: NoteTag[];
  updatedAt: string;
  createdAt: string;
  author: string | null;
  authorAuthId: string | null;
}

/** A candidate the tag picker offers. */
export interface TagTarget {
  kind: NoteTagKind;
  type: NoteTagType;
  id: string;
  label: string;
  /** Secondary line (company, role, substance…), optional. */
  sublabel?: string;
}
