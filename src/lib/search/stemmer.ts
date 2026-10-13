/**
 * Porter's stemming algorithm (Porter 1980), so a search matches the WORD
 * rather than the spelling of it.
 *
 * Without it, "perforating" and "perforation" are two unrelated strings, and a
 * reader who searches for one never finds the chat that used the other. Prefix
 * matching alone does not solve this: it is directional, so "perforat" finds
 * both but "perforation" finds neither.
 *
 * The original 1980 algorithm rather than Porter2/Snowball: it is smaller, it
 * is the one every reference implementation agrees on, and its known
 * weaknesses (irregular plurals, over-stemming a handful of short words) do not
 * bite on the vocabulary this searches. Its rules are stated in terms of the
 * consonant/vowel "measure" of a stem, which is what the helpers below compute.
 */

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/**
 * Whether the letter at `i` is a consonant. `y` is the awkward one: it is a
 * consonant at the start of a word or after a vowel, and a vowel otherwise.
 */
function isConsonant(word: string, i: number): boolean {
  const ch = word[i];
  if (VOWELS.has(ch)) return false;
  if (ch !== "y") return true;
  return i === 0 ? true : !isConsonant(word, i - 1);
}

/**
 * Porter's `m`: the number of vowel-consonant sequences in a stem. Most rules
 * only fire above some `m`, which is what stops them mangling short words.
 */
function measure(stem: string): number {
  let m = 0;
  let i = 0;
  // Skip any leading consonants.
  while (i < stem.length && isConsonant(stem, i)) i++;
  while (i < stem.length) {
    while (i < stem.length && !isConsonant(stem, i)) i++;
    if (i >= stem.length) break;
    m++;
    while (i < stem.length && isConsonant(stem, i)) i++;
  }
  return m;
}

/** Porter's `*v*`: the stem contains a vowel. */
function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) if (!isConsonant(stem, i)) return true;
  return false;
}

/** Porter's `*d`: the stem ends in a doubled consonant. */
function endsDoubleConsonant(stem: string): boolean {
  const n = stem.length;
  if (n < 2) return false;
  return stem[n - 1] === stem[n - 2] && isConsonant(stem, n - 1);
}

/**
 * Porter's `*o`: the stem ends consonant-vowel-consonant, where the final
 * consonant is not w, x or y. Marks the words that need their `e` restored.
 */
function endsCvc(stem: string): boolean {
  const n = stem.length;
  if (n < 3) return false;
  if (
    !isConsonant(stem, n - 3) ||
    isConsonant(stem, n - 2) ||
    !isConsonant(stem, n - 1)
  ) {
    return false;
  }
  return !"wxy".includes(stem[n - 1]);
}

/** Replace `suffix` with `replacement` when the remaining stem has m > `min`. */
function replaceIf(
  word: string,
  suffix: string,
  replacement: string,
  min: number
): string | null {
  if (!word.endsWith(suffix)) return null;
  const stem = word.slice(0, word.length - suffix.length);
  return measure(stem) > min ? stem + replacement : word;
}

/** Apply the first matching rule from a suffix → replacement table. */
function applyTable(
  word: string,
  table: [string, string][],
  min: number
): string {
  for (const [suffix, replacement] of table) {
    const out = replaceIf(word, suffix, replacement, min);
    if (out !== null) return out;
  }
  return word;
}

const STEP2: [string, string][] = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
  ["izer", "ize"], ["abli", "able"], ["alli", "al"], ["entli", "ent"],
  ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
  ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"],
  ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
];

const STEP3: [string, string][] = [
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
  ["ical", "ic"], ["ful", ""], ["ness", ""],
];

const STEP4: [string, string][] = [
  ["al", ""], ["ance", ""], ["ence", ""], ["er", ""], ["ic", ""],
  ["able", ""], ["ible", ""], ["ant", ""], ["ement", ""], ["ment", ""],
  ["ent", ""], ["ou", ""], ["ism", ""], ["ate", ""], ["iti", ""],
  ["ous", ""], ["ive", ""], ["ize", ""],
];

/**
 * Reduce a lowercase word to its stem. Words of two letters or fewer are
 * returned unchanged, as Porter specifies.
 */
export function stem(word: string): string {
  if (word.length <= 2) return word;
  let w = word;

  // 1a — plurals.
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) {
    // unchanged
  } else if (w.endsWith("s")) w = w.slice(0, -1);

  // 1b — past tense and gerunds.
  let stripped = false;
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    stripped = true;
  } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    stripped = true;
  }
  if (stripped) {
    // Tidy up the stem the removal exposed: "conflat" → "conflate",
    // "hopp" → "hop", "fil" → "file".
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (endsDoubleConsonant(w) && !"lsz".includes(w[w.length - 1])) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && endsCvc(w)) w += "e";
  }

  // 1c — terminal y becomes i, so step 2's tables can see it.
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;

  w = applyTable(w, STEP2, 0);
  w = applyTable(w, STEP3, 0);

  // 4 — strip the derivational suffix entirely. `-ion` only after s or t.
  const step4 = applyTable(w, STEP4, 1);
  if (step4 !== w) {
    w = step4;
  } else if (w.endsWith("sion") || w.endsWith("tion")) {
    const base = w.slice(0, -3);
    if (measure(base) > 1) w = base;
  }

  // 5a — drop a silent e.
  if (w.endsWith("e")) {
    const base = w.slice(0, -1);
    const m = measure(base);
    if (m > 1 || (m === 1 && !endsCvc(base))) w = base;
  }
  // 5b — collapse a doubled l.
  if (measure(w) > 1 && w.endsWith("ll")) w = w.slice(0, -1);

  return w;
}
