import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill prompts live as plain `.md` files in THIS directory, not in TypeScript,
 * so they can be read and edited directly without touching code. Each file is a
 * template with `{{PLACEHOLDER}}` tokens for the dynamic pieces the code fills in
 * (the destination menu, existing records, field lists, ...).
 *
 * Read fresh on every call so editing a prompt takes effect without a restart.
 * The cost is a few-KB file read once per document scan — negligible next to the
 * model call. Server-only, and relies on the repo files being on disk at
 * `process.cwd()` (true for `next dev` and a self-hosted node server).
 */
const SKILLS_DIR = join(process.cwd(), "src", "lib", "ai", "ingest", "skills");

/**
 * `{{include:<file>}}` pulls another skill file in verbatim, resolved BEFORE
 * token substitution. This is how prose that several skills must agree on — the
 * settlement ground rules shared by the revenue, oil-run, and gas-settlement
 * readers — lives in ONE file, so teaching one reader a vendor quirk teaches
 * them all. Depth-capped so a cycle fails loudly instead of hanging.
 */
const INCLUDE_RE = /\{\{include:([\w-]+)\}\}/g;
function resolveIncludes(text: string, depth = 0): string {
  return text.replace(INCLUDE_RE, (_whole, name: string) => {
    if (depth >= 3) {
      throw new Error(`loadSkill: include depth exceeded at "${name}"`);
    }
    const included = readFileSync(join(SKILLS_DIR, `${name}.md`), "utf8");
    return resolveIncludes(included.trim(), depth + 1);
  });
}

/**
 * Load skill `<name>.md`, resolve its `{{include:...}}` directives, and
 * substitute its `{{TOKEN}}` placeholders from `vars`. An unknown token is left
 * intact (so a typo is visible in the prompt rather than silently blanked).
 */
export function loadSkill(name: string, vars: Record<string, string>): string {
  const template = readFileSync(join(SKILLS_DIR, `${name}.md`), "utf8");
  return substitute(resolveIncludes(template), vars);
}

/**
 * Load ONE `## <section>` block from a multi-section skill file `<name>.md` and
 * substitute its `{{TOKEN}}` placeholders. Lets many small per-type prompts live
 * in a single editable markdown file (each under its own `##` heading) instead of
 * inline TypeScript. Throws if the section is missing, so a typo is loud.
 */
export function loadSkillSection(
  name: string,
  section: string,
  vars: Record<string, string> = {}
): string {
  const lines = readFileSync(join(SKILLS_DIR, `${name}.md`), "utf8").split("\n");
  const headRe = new RegExp(`^##[ \\t]+${escapeRe(section)}[ \\t]*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    throw new Error(`loadSkillSection: no "## ${section}" in ${name}.md`);
  }
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##[ \t]+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return substitute(lines.slice(start, end).join("\n").trim(), vars);
}

function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
