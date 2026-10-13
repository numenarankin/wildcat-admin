/**
 * Server-side access to the user-created Orion skills stored in Supabase
 * (`orion_skills`). The built-in catalog lives in `./skills`; these are the
 * custom skills the team defines on the Skills page. Mapped into the same
 * `OrionSkill` shape so the UI and the prompt builder treat both uniformly.
 */

import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { ORION_SKILLS, type OrionSkill, type SkillCategory } from "@/lib/orion/skills";

interface OrionSkillRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  examples: string[] | null;
  enabled: boolean;
}

function mapSkill(r: OrionSkillRow): OrionSkill {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    category: r.category as SkillCategory,
    icon: "sparkles",
    tools: ["custom"],
    examples: r.examples ?? [],
    // For stored skills, this carries the live enabled state (used to seed the
    // UI toggle and to decide what goes into the prompt).
    enabledByDefault: r.enabled,
    builtIn: false,
  };
}

/**
 * Returns the team's custom skills, newest first. Resilient by design: a query
 * failure (e.g. before the migration is applied) returns an empty list rather
 * than throwing, so it can't take down the chat route or the Skills page.
 */
export async function getCustomSkills(): Promise<OrionSkill[]> {
  if (!hasSupabase()) return [];
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb
      .from("orion_skills")
      .select("id, name, description, category, examples, enabled")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as OrionSkillRow[]).map(mapSkill);
  } catch (error) {
    console.error("getCustomSkills failed", error);
    return [];
  }
}

/**
 * Every skill Orion has — the built-in catalog plus the team's custom skills,
 * in one list. This is what background jobs (e.g. proactive ingest) query to
 * decide what Orion is allowed to do; the ingest scan reads it to gate which
 * record types it proposes on the write-skill toggles.
 */
export async function getAllSkills(): Promise<OrionSkill[]> {
  const custom = await getCustomSkills();
  return [...ORION_SKILLS, ...custom];
}

/** One skill by id (built-in or custom), or null if there is no such skill. */
export async function getSkill(id: string): Promise<OrionSkill | null> {
  const builtIn = ORION_SKILLS.find((s) => s.id === id);
  if (builtIn) return builtIn;
  const custom = await getCustomSkills();
  return custom.find((s) => s.id === id) ?? null;
}
