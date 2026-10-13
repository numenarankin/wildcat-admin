import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Turn a rock's name into a depth window, so a screen can be asked for in the
 * words an operator actually uses.
 *
 * `rrc_well_screen` screens on DEPTH because depth is the thing nearly every
 * Texas well carries: formation tops are on 5.7% of wellbores, so a screen on
 * filed geology is a screen of whoever filed paperwork. That decision stands.
 * Its cost was that somebody had to supply the numbers, and "where else can I
 * repeat the Caddo recompletion" does not come with numbers on it. The model
 * was left to invent a window, which is exactly the kind of quiet fabrication
 * the rest of this work exists to remove.
 *
 * The geology side now publishes the table that closes it.
 * `geology-corpus/tables/formation-aliases.json` is built from
 * `rrc.completion_formation` joined to `rrc.completion`, about 16,000 filings
 * across six north-central Texas counties, and it carries per county the p10,
 * p50 and p90 of where each unit's TOP is filed, with the sample count behind
 * each one.
 *
 * ## Why this reads the file rather than calling the tool that owns it
 *
 * `formation_alias_resolve` in `api/_geology/tools/regional.py` answers the same
 * question and is the right front door for a geology turn. It is a Python tool
 * behind the petrophysics dispatcher, reachable by Fable and the geology
 * harness, and NOT by the RRC gatherer, which is the stage that actually
 * chooses a screen's extent. Reaching it from here would mean a cross-process
 * hop inside a user's wait to fetch three numbers out of a JSON file that is
 * already vendored into this repo.
 *
 * So both halves read ONE table. The numbers cannot diverge, because there is
 * only one place they exist. If the alias resolution grows richer on the Python
 * side (informal sands bracketed between formal units, GEOLEX supersession),
 * this stays the narrow lookup it is and the geology harness keeps the rest.
 *
 * ## What the window IS, and it is not a formation interval
 *
 * It is the spread of the TOP across a county: the structural relief of that
 * surface, not the thickness of the unit. Screening on it therefore asks "did
 * this hole penetrate the depth band the Caddo occupies around here, and is
 * anything perforated in it". For a behind-pipe screen that errs the SAFE way,
 * because a wide band makes the negative harder to satisfy: any perforation
 * anywhere in it disqualifies the well. The screen under-reports candidates
 * rather than manufacturing them, and every result says so.
 */

/** Where the table lives. Same variable the Python half reads. */
function corpusRoot(): string {
  return process.env.GEOLOGY_CORPUS_ROOT ?? path.join(process.cwd(), "geology-corpus");
}

interface AliasRecord {
  clean: string;
  raw_forms: string[];
  filings: number;
  verdict: "formal" | "informal" | "not_a_formation";
  canonical: string | null;
  confidence: string | null;
  note: string | null;
}

interface CountyWindow {
  depth_samples: number;
  depth_p10_ft: number;
  depth_p50_ft: number;
  depth_p90_ft: number;
}

interface AliasTable {
  counties: string[];
  depth_windows: Record<string, Record<string, CountyWindow>>;
  aliases: AliasRecord[];
}

/**
 * A window fitted on a handful of filings is one well's opinion.
 *
 * Reported either way, never silently dropped, because "three wells said so" is
 * a usable fact and a hidden one is not.
 */
const THIN_SAMPLES = 8;

let cached: AliasTable | null | undefined;

/** Read once. The table is 250 KB and does not change inside a process. */
function table(): AliasTable | null {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(
      path.join(corpusRoot(), "tables", "formation-aliases.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as AliasTable;
    cached = parsed.depth_windows && parsed.aliases ? parsed : null;
  } catch {
    // A deployment without the geology corpus screens on explicit depths and
    // loses nothing else.
    cached = null;
  }
  return cached;
}

/** For tests that point `GEOLOGY_CORPUS_ROOT` somewhere else mid-process. */
export function resetFormationTable(): void {
  cached = undefined;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface FormationWindow {
  /** The unit as the stratigraphic column names it. */
  canonical: string;
  /** What the caller typed, and what it was matched through. */
  asked: string;
  matched_via: "canonical name" | "operator filing string";
  county: string;
  /** p10 of the filed top. */
  top_ft: number;
  /** p90 of the filed top. */
  bottom_ft: number;
  median_top_ft: number;
  depth_samples: number;
  thin: boolean;
  note: string;
}

export interface FormationRefusal {
  error: string;
  counties_covered?: string[];
  formations_covered?: string[];
}

export function isFormationRefusal(
  r: FormationWindow | FormationRefusal
): r is FormationRefusal {
  return "error" in r;
}

/**
 * The canonical unit a typed string names, or null.
 *
 * Matching is exact after normalisation, against the canonical names and
 * against the operator spellings the filings actually contain. There is no
 * fuzzy fallback on purpose: the alias table's whole contract is that a string
 * which does not land on the column resolves to a refusal rather than to the
 * nearest plausible unit, and a screen pointed at the wrong rock returns wells
 * that look exactly like the right answer.
 */
function resolveCanonical(
  t: AliasTable,
  asked: string
): { canonical: string; via: FormationWindow["matched_via"] } | null {
  const want = norm(asked);
  for (const key of Object.keys(t.depth_windows)) {
    if (norm(key) === want) return { canonical: key, via: "canonical name" };
  }
  // Base names too: "caddo" has to reach "caddo limestone", because that is what
  // a person says and what the operator typed on the form.
  for (const key of Object.keys(t.depth_windows)) {
    const k = norm(key);
    if (k.startsWith(`${want} `)) return { canonical: key, via: "canonical name" };
  }
  for (const a of t.aliases) {
    if (a.verdict !== "formal" || !a.canonical) continue;
    const forms = [a.clean, ...a.raw_forms].map(norm);
    if (forms.includes(want)) {
      return { canonical: a.canonical, via: "operator filing string" };
    }
  }
  return null;
}

/**
 * The depth window a formation occupies in one county, from the filings.
 *
 * Refuses rather than guesses on every axis: an uncovered county, an unknown
 * rock, or a unit nobody has filed a top for in that county.
 */
export function formationWindow(
  formation: string,
  countyName: string
): FormationWindow | FormationRefusal {
  const t = table();
  if (!t) {
    return {
      error:
        "The formation table is not present in this deployment, so a rock name cannot be turned into a depth window. Give depth_top_ft and depth_bottom_ft directly.",
    };
  }

  const county = countyName.trim().toUpperCase();
  if (!t.counties.map((c) => c.toUpperCase()).includes(county)) {
    return {
      error: `The formation-to-depth table covers ${t.counties.length} north-central Texas counties and ${county} is not one of them. Screen there with explicit depths, or name a covered county.`,
      counties_covered: t.counties,
    };
  }

  const hit = resolveCanonical(t, formation);
  if (!hit) {
    return {
      error: `"${formation}" does not resolve to a unit in the stratigraphic column. It may be a driller's name for an informal sand, which this table does not place. Screen on explicit depths, or ask the geology side to resolve the string first.`,
      formations_covered: Object.keys(t.depth_windows),
    };
  }

  const w = t.depth_windows[hit.canonical]?.[county];
  if (!w) {
    return {
      error: `No operator has filed a ${hit.canonical} top in ${county}, so there is no window to screen on there. The unit may be absent, or it may be present and never picked.`,
      counties_covered: Object.keys(t.depth_windows[hit.canonical] ?? {}),
    };
  }

  const thin = w.depth_samples < THIN_SAMPLES;
  return {
    canonical: hit.canonical,
    asked: formation.trim(),
    matched_via: hit.via,
    county,
    top_ft: Math.round(w.depth_p10_ft),
    bottom_ft: Math.round(w.depth_p90_ft),
    median_top_ft: Math.round(w.depth_p50_ft),
    depth_samples: w.depth_samples,
    thin,
    note:
      `${Math.round(w.depth_p10_ft)} to ${Math.round(w.depth_p90_ft)} ft is the p10 to p90 spread of where the ${hit.canonical.toUpperCase()} TOP is filed in ${county}, from ${w.depth_samples} completion reports, median ${Math.round(w.depth_p50_ft)} ft. ` +
      "It is the relief of that surface across the county, NOT the thickness of the unit. A behind-pipe screen on it is conservative: any perforation anywhere in the band disqualifies the well, so it under-reports candidates rather than inventing them." +
      (thin
        ? ` ONLY ${w.depth_samples} FILINGS stand behind this window. That is one or two operators' opinion of where the top is, not a county-wide surface.`
        : ""),
  };
}
