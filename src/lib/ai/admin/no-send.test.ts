import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Orion can never send email: nothing the admin chat route loads may reach
 * the send path. Walks the route's real import graph (every `@/` and relative
 * import, transitively) and scans each module. The runtime guard
 * (`orion-guard.ts`) is the second wall; this is the first.
 */

// Both Orion routes: the admin chat and the Enrich chat (one target's research).
const ENTRIES = ["src/app/api/admin/chat/route.ts", "src/app/api/admin/enrich/chat/route.ts"];
const ENTRY = ENTRIES[0];
const FORBIDDEN = [
  /gmail-actions/, // the send server action
  /\bsendMessage\b/, // client.ts's messages.send
  /\bsendGmailMessage\b/,
  /messages\/send/,
  /drafts\/send/,
  /gmail\/compose/, // the MIME builder only sending needs
];

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join("src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return resolve(candidate);
  }
  return null;
}

function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [resolve(entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const next = resolveImport(file, m[1] ?? m[2]);
      if (next) stack.push(next);
    }
  }
  return [...seen];
}

const graph = importGraph(ENTRY);
const enrichGraph = importGraph(ENTRIES[1]);

describe("nothing the admin chat route loads can send email", () => {
  it("walks a real graph", () => {
    // The tools, the guard and the draft contract are all reached.
    for (const m of ["lib/ai/admin/tools.ts", "lib/ai/admin/google-tools.ts", "lib/ai/admin/draft-tools.ts", "lib/admin/google/fetch.ts"]) {
      expect(graph.some((f) => f.endsWith(m)), m).toBe(true);
    }
  });

  it("reaches no send path", () => {
    const hits = graph.flatMap((file) => {
      const src = readFileSync(file, "utf8");
      return FORBIDDEN.filter((p) => p.test(src)).map((p) => `${file} matches ${p}`);
    });
    expect(hits).toEqual([]);
  });

  it("the Enrich route reaches its tools and no send path either", () => {
    expect(enrichGraph.some((f) => f.endsWith("lib/ai/admin/enrich-tools.ts"))).toBe(true);
    const hits = enrichGraph.flatMap((file) => {
      const src = readFileSync(file, "utf8");
      return FORBIDDEN.filter((p) => p.test(src)).map((p) => `${file} matches ${p}`);
    });
    expect(hits).toEqual([]);
  });
});
