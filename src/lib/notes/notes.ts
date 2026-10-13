import "server-only";

/**
 * Notes data access. A note is a free-form markdown document (body stored as
 * HTML, like `files.content`) that can tag any number of facilities and people.
 * Storage is two tables — `notes` + polymorphic `note_tags` — see
 * `2026073000500_notes.sql` for the schema and why the tag key is polymorphic
 * TEXT (well ids are slugs, everything else uuids).
 *
 * Author names are denormalized at insert time, matching facility_comments: the
 * legacy `users` directory is never populated, so a join would render "Unknown".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSessionUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/settings/profile";
import { initialsFrom } from "@/lib/wells/wells";
import { getOrgMembers } from "@/lib/settings/org-data";
import {
  getContractors,
  getEmployees,
  getGatherers,
  getRoyaltyOwners,
  getServiceProviders,
} from "@/lib/people/people";
import { getWells } from "@/lib/wells/wells";
import { getTanks } from "@/lib/tanks/actions";
import { getMeters } from "@/lib/meters/actions";
import { getBatteries } from "@/lib/batteries/actions";
import { getLeases } from "@/lib/leases/actions";
import { getProjectFolders } from "@/lib/projects/folders";
import { snippetFromHtml } from "@/lib/notes/format";
import {
  TAG_KIND_BY_TYPE,
  type Note,
  type NoteSummary,
  type NoteTag,
  type NoteTagType,
  type TagTarget,
} from "@/lib/notes/types";

type Sb = SupabaseClient;

/** The signed-in user as the notes surface renders them (byline, delete rights). */
export interface NoteUser {
  name: string;
  initials: string;
  authId: string | null;
}

/** Centralized display-name resolution, mirroring `getCommentUser`. */
export async function getNoteUser(): Promise<NoteUser> {
  const [user, profile] = await Promise.all([getSessionUser(), getProfile()]);
  const name = profile.name.trim() || user?.email?.split("@")[0] || "You";
  return { name, initials: initialsFrom(name), authId: user?.id ?? null };
}

interface NoteTagRow {
  target_type: string;
  target_id: string;
  target_kind: string;
  label: string | null;
}

function mapTag(r: NoteTagRow): NoteTag {
  const type = r.target_type as NoteTagType;
  return {
    type,
    id: r.target_id,
    label: r.label ?? "",
    // Trust the stored kind, but fall back to the canonical mapping.
    kind: (r.target_kind as NoteTag["kind"]) ?? TAG_KIND_BY_TYPE[type],
  };
}

interface NoteRow {
  id: string;
  title: string;
  content: string | null;
  updated_at: string;
  created_at: string;
  author_name: string | null;
  author_auth_id: string | null;
  note_tags: NoteTagRow[] | null;
}

const SUMMARY_COLS =
  "id, title, content, updated_at, author_name, note_tags(target_type, target_id, target_kind, label)";
const NOTE_COLS =
  "id, title, content, updated_at, created_at, author_name, author_auth_id, note_tags(target_type, target_id, target_kind, label)";

function mapSummary(r: NoteRow): NoteSummary {
  return {
    id: r.id,
    title: r.title,
    snippet: snippetFromHtml(r.content ?? ""),
    tags: (r.note_tags ?? []).map(mapTag),
    updatedAt: r.updated_at,
    author: r.author_name,
  };
}

function mapNote(r: NoteRow): Note {
  return {
    id: r.id,
    title: r.title,
    content: r.content ?? "",
    tags: (r.note_tags ?? []).map(mapTag),
    updatedAt: r.updated_at,
    createdAt: r.created_at,
    author: r.author_name,
    authorAuthId: r.author_auth_id,
  };
}

/** Every note in the org, newest-touched first. Soft-deleted rows excluded. */
export async function listNotes(sb: Sb): Promise<NoteSummary[]> {
  const { data, error } = await sb
    .from("notes")
    .select(SUMMARY_COLS)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listNotes: ${error.message}`);
  return ((data ?? []) as NoteRow[]).map(mapSummary);
}

/**
 * Notes tagging one facility or person, newest-touched first. Two steps because
 * a single embedded `!inner` filter would prune the note's OTHER tags: first
 * find the note ids for this target, then load those notes with their full tag
 * set.
 */
export async function listNotesForTarget(
  sb: Sb,
  type: NoteTagType,
  id: string
): Promise<NoteSummary[]> {
  const { data: tagRows, error: tagErr } = await sb
    .from("note_tags")
    .select("note_id")
    .eq("target_type", type)
    .eq("target_id", id);
  if (tagErr) throw new Error(`listNotesForTarget (tags): ${tagErr.message}`);

  const noteIds = [
    ...new Set(((tagRows ?? []) as { note_id: string }[]).map((r) => r.note_id)),
  ];
  if (noteIds.length === 0) return [];

  const { data, error } = await sb
    .from("notes")
    .select(SUMMARY_COLS)
    .in("id", noteIds)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listNotesForTarget (notes): ${error.message}`);
  return ((data ?? []) as NoteRow[]).map(mapSummary);
}

/** One note in full, for the editor. Null if missing or not in the caller's org. */
export async function getNote(sb: Sb, id: string): Promise<Note | null> {
  const { data, error } = await sb
    .from("notes")
    .select(NOTE_COLS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`getNote: ${error.message}`);
  if (!data) return null;
  return mapNote(data as NoteRow);
}

/**
 * Everything a note can tag: the org's facilities, people and projects,
 * flattened into one picker list. Composes the existing per-domain loaders (each RLS-scoped to the
 * org), so a target the caller can't otherwise see never appears here.
 */
export async function getTaggableTargets(): Promise<TagTarget[]> {
  const [
    members,
    employees,
    contractors,
    serviceProviders,
    royaltyOwners,
    gatherers,
    wells,
    tanks,
    meters,
    batteries,
    leases,
    projects,
  ] = await Promise.all([
    getOrgMembers(),
    getEmployees(),
    getContractors(),
    getServiceProviders(),
    getRoyaltyOwners(),
    getGatherers(),
    getWells(),
    getTanks(),
    getMeters(),
    getBatteries(),
    getLeases(),
    // Projects are per-user with explicit sharing, so this list is already
    // narrowed to the ones the tagger can open.
    getProjectFolders(),
  ]);

  const out: TagTarget[] = [];

  // Facilities.
  for (const w of wells)
    out.push({ kind: "facility", type: "well", id: w.id, label: w.name });
  for (const t of tanks)
    out.push({ kind: "facility", type: "tank", id: t.id, label: t.name });
  for (const m of meters)
    out.push({ kind: "facility", type: "meter", id: m.id, label: m.name });
  for (const b of batteries)
    out.push({ kind: "facility", type: "battery", id: b.id, label: b.name });
  for (const l of leases)
    out.push({ kind: "facility", type: "lease", id: l.id, label: l.name });

  // People.
  for (const m of members) {
    const label = m.name.trim() || m.email.split("@")[0] || "Member";
    out.push({
      kind: "person",
      type: "member",
      id: m.id,
      label,
      sublabel: m.email || undefined,
    });
  }
  for (const e of employees)
    out.push({
      kind: "person",
      type: "employee",
      id: e.id,
      label: e.name,
      sublabel: e.role || undefined,
    });
  for (const c of contractors)
    out.push({
      kind: "person",
      type: "contractor",
      id: c.id,
      label: c.name,
      sublabel: c.company || undefined,
    });
  for (const s of serviceProviders)
    out.push({
      kind: "person",
      type: "service_provider",
      id: s.id,
      label: s.company,
      sublabel: s.contact || undefined,
    });
  for (const r of royaltyOwners)
    out.push({ kind: "person", type: "royalty_owner", id: r.id, label: r.name });
  for (const g of gatherers)
    out.push({ kind: "person", type: "gatherer", id: g.id, label: g.name });

  // Projects. `id` is the project's folder id — what the Notes tab queries by.
  for (const p of projects)
    out.push({ kind: "project", type: "project", id: p.id, label: p.name });

  return out;
}
