/**
 * Bridge the geology registry into the AI SDK's tool shape.
 *
 * Fable calls tools through the SDK, but every call still goes through
 * `callTool` so `toolCalls[]` stays complete — the ledger is what lets Fable
 * show its work, and a call made behind the harness's back would be a number in
 * the answer with nothing behind it.
 *
 * Read-only by construction: the registry refuses to admit a tool that mutates,
 * so there is nothing here for Orion's approval gate to guard.
 */
import { tool, type Tool } from "ai";
import type { JSONValue } from "ai";
import { callTool, type CallDeps } from "./call-tool";
import {
  claimImageBudget,
  findFigureImage,
  imagesUsed,
  MAX_IMAGES_PER_RUN,
  readFigureImage,
} from "./figure-image";
import type { AgentRole, ToolRegistry } from "./registry";

/**
 * A corpus segment reference. Internal, always.
 *
 * Both shapes the tools emit: the full `section/slug#12` anchor, and the short
 * `asquith#18` form that appears inside prose fields.
 */
const ANCHOR = /\b[a-z0-9][\w.-]*(?:\/[\w.-]+)?#\d+\b/gi;
/**
 * A parenthetical citation: "(Asquith Eq. 4.7)", "(Table 4.1)", "(Ahmed 2006)".
 *
 * A bare four-digit number is NOT a citation here — this domain is full of them
 * and they are depths. "(4109-4122 ft)" must survive; a year only counts when an
 * author's name is in front of it.
 */
const CITATION =
  /\s*\((?:[^()]*\b(?:eq\.?|equation|table|fig\.?|figure|chapter|[a-z]{3,}(?:\s*(?:&|and)\s*[a-z]{3,})?,?\s+(?:19|20)\d{2})\b[^()]*)\)/gi;

/**
 * Remove the reference library from anything the model will read.
 *
 * The prompt already forbids naming a document or a passage. It leaked anyway,
 * and the reason is that the tools cite their own sources: a porosity comes back
 * as `method: "density porosity (Asquith Eq. 4.7)"` with a `source` naming the
 * exact corpus segment. The model is told to show its work, so it does the
 * reasonable thing and repeats what the tool told it — and the operator, who is
 * not supposed to know a library exists, reads a textbook citation.
 *
 * Asking the model harder does not fix a string it is being handed. Cutting the
 * string does. The provenance is not lost: it stays in the ledger, which is
 * where an audit would look for it.
 */
function scrubCitations<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(ANCHOR, "").replace(CITATION, "").replace(/\s{2,}/g, " ").trim() as unknown as T;
  }
  if (Array.isArray(value)) return value.map(scrubCitations) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Whole fields that exist only to name a source.
      // Anything whose job is to name where a fact came from. `basis` is on the
      // list because that is exactly where the tools put their citations
      // ("Asquith Table 4.2 'Fresh water' 1.0 g/cm3"), and the rule the operator
      // set is absolute: they never learn the library exists.
      if (/^(source|sources|anchor|basis|citation|reference|provenance)$/i.test(k)) continue;
      if (/(_source|Source|_basis|Basis|_citation|Citation)$/.test(k)) continue;
      out[k] = scrubCitations(v);
    }
    return out as unknown as T;
  }
  return value;
}

export function geologyTools(
  registry: ToolRegistry,
  deps: CallDeps,
  role: AgentRole = "fable"
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const t of registry.listFor(role)) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      async execute(args: unknown) {
        try {
          const result = await callTool(deps, { stage: "stage3", branch: t.name }, t.name, args, role);
          // A gate refusing comes back as a value, not a throw, so the model can
          // respond to it inside the turn — ask for the W-2, offer a range, say
          // what is unresolved — instead of the turn ending.
          // Scrubbed on the way to the model, never in the ledger: the trace and
          // any later audit still see exactly what the tool said.
          return scrubCitations(
            result.refused
              ? { refused: result.refused, value: result.value, method: result.provenance.method }
              : { value: result.value, method: result.provenance.method }
          );
        } catch (err: unknown) {
          /*
           * A tool that throws is a fact about the turn, not the end of it.
           *
           * Thrown, this reaches the SDK, which may end the step and can end the
           * run — and the operator gets an error where an answer should be, over
           * a lookup that was never the whole question. Returned, the model reads
           * it, works with what it has, and says what it could not establish.
           *
           * `callTool` has already recorded the failure in the ledger with its
           * reason, so the trace still shows the attempt. What must not happen is
           * the model apologising to the operator about a tool: the instruction
           * below is the one it acts on, and the prompt's rule against naming
           * tools is what keeps it out of the answer.
           */
          const message = err instanceof Error ? err.message : String(err);
          console.warn("geology:fable-tool-failed", { tool: t.name, error: message });
          return {
            failed: true,
            tool: t.name,
            reason: message,
            instruction:
              "This lookup did not run. Do not mention it, do not apologise for it, and do not " +
              "retry it more than once. Continue with what you already have, and if a conclusion " +
              "genuinely depended on it, say which fact is not established and what would settle it.",
          };
        }
      },
      /*
       * The one result that is not JSON.
       *
       * `figure_fetch` answers with a map, and a map has to arrive as pixels —
       * the whole reason the corpus keeps the rendered pages is that a plate
       * described once at ingest loses exactly the detail a screen turns on.
       * Every other tool falls through to the SDK's default serialisation,
       * which is what the numbers want.
       *
       * Degrades rather than fails: past the per-run budget, or if the file
       * cannot be read, the model still gets the index entry as JSON.
       */
      async toModelOutput({ output }) {
        // `toModelOutput` has no "do what you would have done" return, so the
        // JSON form every other tool relies on is spelled out here rather than
        // fallen through to.
        const asJson = { type: "json", value: output as JSONValue } as const;

        const image = findFigureImage(output);
        if (!image) return asJson;

        const text = JSON.stringify(output);
        if (!claimImageBudget(deps)) {
          return {
            type: "content",
            value: [{
              type: "text",
              text: `${text}\n\nThe sheet itself was not attached: this turn has already `
                + `read ${MAX_IMAGES_PER_RUN} figures, which is the limit. Work from the `
                + `description above, and say so if a conclusion needed the map itself.`,
            }],
          };
        }

        const data = await readFigureImage(image);
        if (!data) return asJson;
        return {
          type: "content",
          value: [
            { type: "text", text },
            { type: "image-data", data, mediaType: image.mediaType },
          ],
        };
      },
    });
  }
  return out;
}

export { MAX_IMAGES_PER_RUN, imagesUsed };
