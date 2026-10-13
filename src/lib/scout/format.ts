// Shared display helpers for the well/operator detail panels.

/** 8-digit zero-padded API string. */
export function api8(n: number): string {
  return String(n).padStart(8, "0");
}

/** CCYYMMDD integer -> "YYYY-MM-DD" (null for 0/empty). */
export function fmtDate8(n: number | null | undefined): string | null {
  if (!n) return null;
  const s = String(n).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 10-digit phone integer -> "(NPA) NXX-XXXX" (null for 0/empty). */
export function fmtPhone(n: number | null | undefined): string | null {
  if (!n) return null;
  const s = String(n).padStart(10, "0");
  if (s.length !== 10) return String(n);
  return `(${s.slice(0, 3)}) ${s.slice(3, 6)}-${s.slice(6)}`;
}

/** Cycles in the trailing window every Scout rate is averaged over. */
export const MONTHS_IN_WINDOW = 12;

/**
 * A windowed total as the monthly rate Scout displays it in.
 *
 * The counterpart to `monthlyRate` for figures that arrive already summed from
 * SQL. `months` is how many cycles the sum actually covers, and passing it
 * matters twice over:
 *
 *   1. THE RRC LAGS ~3 MONTHS. Every one of these windows is anchored to the
 *      last REPORTED cycle, not to today, so the twelve cycles in it all carry
 *      data. Summed over a calendar year instead, a quarter of the window
 *      would be months nobody has filed yet and every rate on the page would
 *      read ~25% low.
 *   2. OPERATORS LAG TOO. One that filed nine of those twelve months has nine
 *      observations, and dividing its total by twelve understates it the same
 *      way. Queries that can count their own cycles pass that count here.
 *
 * The default is the full window, for the two sources that cannot report a
 * count: the synced operator points file and the materialised lease board.
 */
export function perMonth(
  total: number | null | undefined,
  months: number | null | undefined = MONTHS_IN_WINDOW
): number {
  const n = Number(months) || MONTHS_IN_WINDOW;
  return (Number(total) || 0) / (n > 0 ? n : MONTHS_IN_WINDOW);
}

/** Production volume -> compact string (e.g. 437M, 3.4K, 0). Null/0 -> "0". */
export function fmtVol(n: number | null | undefined): string {
  if (!n) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/** A dollar figure -> compact string with the sign (e.g. $1.2M, $450, $0). */
export function fmtUsd(n: number | null | undefined): string {
  return `$${fmtVol(Math.round(n ?? 0))}`;
}

/** Tokens that stay upper-case through {@link titleCase}. */
const KEEP_UPPER = new Set([
  "LLC", "L.L.C.", "LP", "L.P.", "LLP", "PLLC", "LC", "PC",
  // No "CO": in this data it is far more often "COMPANY" than Colorado.
  "USA", "US", "AL", "AR", "AZ", "CA", "FL", "GA", "IL", "KS", "LA",
  "MS", "MT", "NM", "NV", "NY", "OH", "OK", "PA", "TN", "TX", "UT", "WY",
]);

/**
 * RRC records are stored SHOUTING ("JOHNSON & ERNST OPERATING CO.", "WICHITA
 * FALLS"). Rendering them raw makes every panel look like a mainframe dump, so
 * names, cities and addresses are cased for display here.
 *
 * Left alone when the string already contains lower case — that means someone
 * has cased it deliberately and re-casing would only damage it. Corporate
 * suffixes and state codes stay upper (`LLC`, `TX`), as do initials (`B.`) and
 * roman numerals (`III`).
 */
export function titleCase(s: string | null | undefined): string {
  if (!s) return "";
  if (/[a-z]/.test(s)) return s;
  // Hyphens are token boundaries, not part of a word, so CROSS-PLAINS reads
  // "Cross-Plains" and the lease number in A-304-BRYSCH survives intact.
  return s.replace(/[A-Za-z0-9.']+/g, (word) => {
    const upper = word.toUpperCase();
    if (KEEP_UPPER.has(upper)) return upper;
    if (/\d/.test(word)) return upper; // 304, ZIPs, lease numbers
    if (/^[A-Z]\.?$/.test(upper)) return upper; // initials
    if (/^[IVX]{2,}\.?$/.test(upper)) return upper; // II, III, IV
    const cased = upper.charAt(0) + upper.slice(1).toLowerCase();
    // O'CONNOR -> O'Connor, but DANNY'S stays Danny's.
    return cased.replace(
      /'([a-z]{2,})/g,
      (_, rest: string) => `'${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
    );
  });
}

/**
 * Words that mark an entity rather than a person. A name carrying one keeps
 * its order: "BRUCE, JOSEPH INC." is a company that happens to be filed with
 * a comma, and "SMITH, JOHN OIL" is not John Smith.
 */
const ENTITY_TOKENS = new Set([
  "INC", "INC.", "LLC", "L.L.C.", "LP", "L.P.", "LLP", "PLLC", "LTD", "LTD.",
  "LC", "PC", "CO", "CO.", "CORP", "CORP.", "CORPORATION", "COMPANY",
  "PARTNERSHIP", "PARTNERS", "TRUST", "TRUSTEE", "TRUSTEES", "ESTATE", "EST",
  "EST.", "OPERATING", "ENERGY", "OIL", "GAS", "PETROLEUM", "RESOURCES",
  "RES", "RES.", "PRODUCTION", "EXPLORATION", "MINERALS", "MINERAL",
  "ROYALTY", "ROYALTIES", "RANCH", "FARMS", "FARM", "ASSOCIATES", "GROUP",
  "HOLDINGS", "VENTURES", "ENTERPRISES", "INDUSTRIES", "SERVICES", "SERVICE",
  "DRILLING", "PIPELINE", "MIDSTREAM", "COUNTY", "CITY", "STATE",
  "UNIVERSITY", "SCHOOL", "CHURCH", "FOUNDATION", "BANK", "DBA", "D/B/A",
  "FUND", "INVESTMENTS", "INVESTMENT", "PROPERTIES", "LAND", "CATTLE",
  "SUPPLY", "DEVELOPMENT", "INTERESTS", "MANAGEMENT", "CAPITAL",
  "INTERNATIONAL", "NATURAL", "USA",
]);

/** Trailing tokens that follow a person's name and stay at the end of it. */
const NAME_SUFFIXES = new Set([
  "JR", "JR.", "SR", "SR.", "II", "III", "IV", "MD", "M.D.", "DDS", "PHD",
  "ESQ", "ESQ.", "ETAL", "ETUX", "ETVIR", "DECEASED", "DEC'D",
]);

function splitSuffix(tokens: string[]): { name: string[]; suffix: string[] } {
  const name = [...tokens];
  const suffix: string[] = [];
  while (name.length > 1 && NAME_SUFFIXES.has(name[name.length - 1].toUpperCase())) {
    suffix.unshift(name.pop() as string);
  }
  return { name, suffix };
}

/**
 * A person's name the way people say it, and an entity's name as filed.
 *
 * The RRC files individuals surname-first with a comma ("RYAN, JOSEPH G.",
 * officers the same), and the county appraisal rolls file them surname-first
 * with NO comma ("HAYS NANCY ANDREWS"). Neither reads naturally on a screen,
 * so this turns both into "Joseph G. Ryan" / "Nancy Andrews Hays", then cases
 * the result with {@link titleCase}.
 *
 * Only a name that is SHOUTING is reordered, the same rule titleCase uses: a
 * string with lower case in it was cased by a person and is left alone.
 *
 * The no-comma flip is a guess about word order that only the roll's own
 * owner type can license, so it runs only when the caller says `individual`;
 * without a comma and without that flag the name is only cased. Corporate
 * words anywhere in the name switch the flip off (see `ENTITY_TOKENS`), and
 * a trailing suffix ("JR.", "III", "ETUX") stays at the end.
 */
export function partyName(
  raw: string | null | undefined,
  opts: { individual?: boolean } = {}
): string {
  if (!raw) return "";
  const s = raw.trim();
  if (!s || /[a-z]/.test(s)) return s;

  const words = s.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (words.some((w) => ENTITY_TOKENS.has(w.toUpperCase()))) return titleCase(s);

  const comma = s.indexOf(",");
  if (comma > 0) {
    const last = s.slice(0, comma).trim();
    const rest = s
      .slice(comma + 1)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (rest.length === 0) return titleCase(s);
    const { name, suffix } = splitSuffix(rest[0].split(/\s+/));
    const tail = [...suffix, ...rest.slice(1)];
    return titleCase([name.join(" "), last, ...tail].filter(Boolean).join(" "));
  }

  if (opts.individual && words.length > 1) {
    const { name, suffix } = splitSuffix(words);
    if (name.length > 1) {
      const [last, ...given] = name;
      return titleCase([...given, last, ...suffix].join(" "));
    }
  }
  return titleCase(s);
}

/** RRC P-5 organization status codes. */
export const P5_STATUS: Record<string, string> = {
  A: "Active",
  I: "Inactive",
  D: "Delinquent",
  X: "Active (extension)",
  H: "Active (hearing)",
  R: "Revoked",
  S: "See remarks",
};
