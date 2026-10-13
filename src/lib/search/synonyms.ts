/**
 * Oilfield and petrophysics vocabulary, grouped by what it MEANS.
 *
 * Stemming closes the gap between "perforating" and "perforation". It does
 * nothing for the gap this table exists to close: an operator writes "SWD", the
 * answer says "saltwater disposal", and a month later they search for
 * "injection well". Three spellings of one thing, sharing no letters. In a
 * domain this abbreviation-heavy that is the normal case, not the edge one.
 *
 * Each group is a set of interchangeable phrases; searching for any member
 * finds all of them, and the group is scored as ONE concept rather than as
 * several terms, so an expansion can never outweigh a term the reader actually
 * typed.
 *
 * This is hand-written domain knowledge and is meant to be edited. Add a group
 * whenever a search fails because the words differed but the meaning did not.
 * Rules for adding one:
 *
 *   - Only true synonyms. "Oil" and "condensate" are related, not equal, and
 *     folding them together makes every oil search return condensate chats.
 *   - Include the abbreviation AND its expansion; the abbreviation is what gets
 *     typed and the expansion is what gets written.
 *   - Spell out spacing variants ("saltwater" / "salt water"): they tokenize
 *     differently and one is not a prefix of the other.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // --- Facilities and operations -------------------------------------------
  ["swd", "saltwater disposal", "salt water disposal", "disposal well", "injection well"],
  ["tank battery", "battery", "lease battery"],
  ["run ticket", "load ticket", "oil run", "run sheet"],
  ["pumper", "lease operator", "gauger"],
  ["workover", "rework", "well work"],
  ["p and a", "p&a", "plug and abandon", "plugging"],
  ["shut in", "shutin", "offline", "idle"],
  ["frac", "fracture stimulation", "hydraulic fracturing", "stimulation"],
  ["gauge", "strap", "tank gauge", "stick reading"],
  ["bs&w", "bsw", "basic sediment and water", "sediment and water"],
  ["h2s", "hydrogen sulfide", "sour gas"],
  ["compressor", "gas compression"],

  // --- Regulatory and commercial -------------------------------------------
  ["rrc", "railroad commission", "texas railroad commission"],
  ["afe", "authorization for expenditure"],
  ["jib", "joint interest billing", "joint interest bill"],
  ["nri", "net revenue interest"],
  ["wi", "working interest"],
  ["orri", "overriding royalty interest", "override"],
  ["settlement statement", "purchaser statement", "check stub", "revenue statement"],

  // --- Volumes and rates ---------------------------------------------------
  ["bbl", "barrel", "barrels"],
  ["mcf", "thousand cubic feet"],
  ["gor", "gas oil ratio", "gas to oil ratio"],
  ["wor", "water oil ratio", "water cut"],
  ["ip", "initial production", "initial potential"],
  ["eur", "estimated ultimate recovery"],
  ["decline curve", "dca", "arps", "decline analysis"],

  // --- Logs and petrophysics -----------------------------------------------
  ["las", "well log", "wireline log", "log file"],
  ["gr", "gamma ray"],
  ["rhob", "bulk density", "density log"],
  ["nphi", "neutron porosity", "neutron log"],
  ["dt", "sonic", "sonic log", "acoustic log"],
  ["rt", "true resistivity", "deep resistivity"],
  ["rxo", "flushed zone resistivity"],
  ["sw", "water saturation"],
  ["vsh", "vshale", "shale volume", "clay volume"],
  ["ro", "vitrinite reflectance", "thermal maturity"],
  ["toc", "total organic carbon", "organic richness"],
  ["perf", "perforation", "perforating", "shot"],
  ["net pay", "pay zone", "pay interval"],
  ["cbl", "cement bond log", "bond log"],
];
