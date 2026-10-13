/**
 * Match a name someone said or typed to a real record.
 *
 * "Roy Corbett IV" and "Roy Corbett 4" are the same well, and transcription
 * hands over whichever it likes — plus "#4", "No. 4", "four" and "for". Left to
 * the prompt, the model called the well missing and then read the user a list
 * containing it. Normalising here makes that answer unreachable rather than
 * discouraged.
 */

/** Spoken forms and their transcription homophones. */
const WORDS: Record<string, string> = {
  one: "1", won: "1",
  two: "2", to: "2", too: "2",
  three: "3",
  four: "4", for: "4", fore: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8", ate: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8",
  ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

/** Noise around a well number: "No. 4", "#4", "Unit 4". */
const NOISE = new Set(["no", "number", "unit"]);

export function normalizeRef(ref: string): string {
  return ref
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t && !NOISE.has(t))
    .map((t) => WORDS[t] ?? ROMAN[t] ?? t)
    .join(" ");
}

export type Named = { id: string; name: string };

/**
 * One match, several, or nothing. Several is a real question to ask; nothing is
 * the only case where "not on file" is true.
 */
export type RefMatch<T extends Named> =
  | { match: T }
  | { candidates: T[] }
  | null;

export function resolveRef<T extends Named>(ref: string, items: T[]): RefMatch<T> {
  const want = normalizeRef(ref);
  if (!want) return null;

  const byId = items.find((i) => i.id === ref);
  if (byId) return { match: byId };

  const exact = items.filter((i) => normalizeRef(i.name) === want);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { candidates: exact };

  // Partial, both directions: "Corbett 4" for "Roy Corbett 4", and "the Roy
  // Corbett 4 well" for the same. Ambiguity here is reported, never guessed.
  const partial = items.filter((i) => {
    const name = normalizeRef(i.name);
    return name.includes(want) || want.includes(name);
  });
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) return { candidates: partial };
  return null;
}
