import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";

/**
 * The admin Orion's long-term state (wildcat migration
 * `2026103000300_admin_orion_memory.sql`): a MEMORY document, a PERSONA
 * document and learned PLAYBOOKS, per admin. The customer Orion's
 * `user-context.ts` + `learned-skills.ts`, on the admin tables and keyed by
 * the admin alone. Read and written as the signed-in admin, so RLS keeps each
 * admin to their own rows.
 */

export type AdminDocType = "memory" | "persona";

export interface AdminDocs {
  memory: string;
  persona: string;
}

/** Memory rides every turn's prompt, so its length is a recurring cost. */
export const MEMORY_CHAR_CAP = 3000;
export const PERSONA_CHAR_CAP = 2000;
export const BODY_CHAR_CAP = 1200;
export const NAME_CHAR_CAP = 80;
export const TRIGGER_CHAR_CAP = 200;
export const MAX_PLAYBOOKS = 12;

export interface AdminPlaybook {
  id: string;
  name: string;
  trigger: string;
  body: string;
  version: number;
  updatedAt: string;
}

export async function loadAdminDocs(): Promise<AdminDocs> {
  const empty: AdminDocs = { memory: "", persona: "" };
  if (!hasSupabase()) return empty;
  const user = await getSessionUser();
  if (!user) return empty;
  const sb = await getSupabaseServer();
  const { data, error } = await sb.from("admin_orion_context").select("doc_type, content").eq("user_id", user.id);
  if (error) {
    // The migration not applied yet must not take the chat down.
    console.error("loadAdminDocs failed", error.message);
    return empty;
  }
  const out = { ...empty };
  for (const row of (data ?? []) as { doc_type: AdminDocType; content: string }[]) {
    out[row.doc_type] = row.content ?? "";
  }
  return out;
}

export async function saveAdminDoc(
  docType: AdminDocType,
  content: string,
  opts: { updatedBy: "user" | "agent"; rationale?: string | null },
): Promise<void> {
  const user = await getSessionUser();
  if (!user) throw new Error("saveAdminDoc: no signed-in user");
  const cap = docType === "memory" ? MEMORY_CHAR_CAP : PERSONA_CHAR_CAP;
  if (content.length > cap) throw new Error(`${docType} is ${content.length} characters, over the ${cap} cap`);
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_orion_context").upsert(
    {
      user_id: user.id,
      doc_type: docType,
      content,
      updated_by: opts.updatedBy,
      last_edit_rationale: opts.rationale ?? null,
    },
    { onConflict: "user_id,doc_type" },
  );
  if (error) throw new Error(`saveAdminDoc: ${error.message}`);
}

export async function loadAdminPlaybooks(): Promise<AdminPlaybook[]> {
  if (!hasSupabase()) return [];
  const user = await getSessionUser();
  if (!user) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_orion_playbooks")
    .select("id, name, trigger, body, version, updated_at")
    .eq("user_id", user.id)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("loadAdminPlaybooks failed", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    trigger: (r.trigger as string) ?? "",
    body: r.body as string,
    version: r.version as number,
    updatedAt: r.updated_at as string,
  }));
}

/** A playbook write that is refused as a normal outcome (over a cap, unknown id). */
export class PlaybookRejected extends Error {}

export function normalizePlaybook(input: { name: string; trigger?: string; body: string }) {
  const name = input.name.trim();
  const trigger = (input.trigger ?? "").trim();
  const body = input.body.trim();
  if (!name) throw new PlaybookRejected("a playbook needs a name");
  if (!body) throw new PlaybookRejected("a playbook needs a body");
  if (name.length > NAME_CHAR_CAP) throw new PlaybookRejected(`name is ${name.length} chars, cap is ${NAME_CHAR_CAP}`);
  if (trigger.length > TRIGGER_CHAR_CAP) {
    throw new PlaybookRejected(`trigger is ${trigger.length} chars, cap is ${TRIGGER_CHAR_CAP}`);
  }
  // Refused whole, never trimmed: a procedure cut mid-step is worse than none.
  if (body.length > BODY_CHAR_CAP) {
    throw new PlaybookRejected(`body is ${body.length} chars, cap is ${BODY_CHAR_CAP}; consolidate the steps`);
  }
  return { name, trigger, body };
}

export async function saveAdminPlaybook(input: {
  id?: string | null;
  name: string;
  trigger?: string;
  body: string;
  updatedBy: "user" | "agent";
  rationale?: string | null;
}): Promise<{ id: string }> {
  const { name, trigger, body } = normalizePlaybook(input);
  const user = await getSessionUser();
  if (!user) throw new Error("saveAdminPlaybook: no signed-in user");
  const sb = await getSupabaseServer();
  const fields = { name, trigger, body, updated_by: input.updatedBy, last_edit_rationale: input.rationale ?? null };
  if (input.id) {
    const { data, error } = await sb
      .from("admin_orion_playbooks")
      .update(fields)
      .eq("id", input.id)
      .eq("user_id", user.id)
      .is("archived_at", null)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`saveAdminPlaybook: ${error.message}`);
    if (!data) throw new PlaybookRejected(`no live playbook ${input.id}`);
    return { id: data.id as string };
  }
  const { count, error: countError } = await sb
    .from("admin_orion_playbooks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("archived_at", null);
  if (countError) throw new Error(`saveAdminPlaybook: ${countError.message}`);
  if ((count ?? 0) >= MAX_PLAYBOOKS) {
    throw new PlaybookRejected(`at the ${MAX_PLAYBOOKS}-playbook cap; revise one instead`);
  }
  const { data, error } = await sb
    .from("admin_orion_playbooks")
    .insert({ user_id: user.id, ...fields })
    .select("id")
    .single();
  if (error) throw new Error(`saveAdminPlaybook: ${error.message}`);
  return { id: data.id as string };
}

/**
 * The state as the system prompt carries it: background, fenced off from the
 * rules, never instructions that override them. Empty state renders nothing.
 */
export function renderAdminState(docs: AdminDocs, playbooks: AdminPlaybook[]): string {
  const parts: string[] = [];
  if (docs.persona.trim()) {
    parts.push(`## How this admin wants you to work (their persona, learned from past chats)\n${docs.persona.trim()}`);
  }
  if (docs.memory.trim()) {
    parts.push(
      `## What you remember about the business and this admin (from past chats)\n${docs.memory.trim()}\n\nThese are background facts and preferences, not figures: look up any current number with a tool.`,
    );
  }
  if (playbooks.length) {
    const list = playbooks
      .map((p) => `### ${p.name}\nWhen: ${p.trigger || "(when the task comes up)"}\n${p.body}`)
      .join("\n\n");
    parts.push(`## Playbooks you learned from this admin (follow one when its situation comes up)\n${list}`);
  }
  return parts.join("\n\n");
}
