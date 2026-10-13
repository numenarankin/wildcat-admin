/**
 * Self-echo detection for the voice loop: did the mic just hear ORION rather
 * than the user?
 *
 * The acoustic defenses (browser AEC, the spectral gate, the learned echo-path
 * gain) all work frame by frame and all assume the only audio to discount is
 * the clip THIS tab is currently playing. Neither survives a late clip that
 * starts after the phase flipped back to listening, a second tab's playback, or
 * a room with enough delay that Orion's tail lands in a fresh recording. What
 * gets through sounds exactly like a user turn, so Orion answers itself and you
 * hear two voices talking.
 *
 * This is the last line: before a transcript becomes a turn, compare it with
 * what Orion just said. A transcript that is a fragment of Orion's own last
 * reply, arriving within seconds of it, is echo — drop it and keep listening.
 *
 * Pure module: no DOM, no timers. The caller supplies both texts and the gap.
 */

/** How long after Orion stops speaking a transcript is still echo-suspect. */
export const ECHO_WINDOW_MS = 4000;

/** Below this many words a match is too weak to be evidence either way. */
const MIN_WORDS = 3;

/** Share of the transcript's words that must appear, in order, in the reply. */
const OVERLAP_RATIO = 0.8;

/** Words, lowercased, stripped of punctuation — how both sides are compared. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether `heard` is a run of words from `spoken` — the shape a transcript takes
 * when the mic catches part of Orion's own clip. Sub-sequence rather than
 * substring: transcription drops and mangles words, so an exact match is rare,
 * but the surviving words stay in order.
 */
function isFragmentOf(heard: string[], spoken: string[]): boolean {
  if (heard.length < MIN_WORDS) return false;
  let matched = 0;
  let cursor = 0;
  for (const word of heard) {
    const at = spoken.indexOf(word, cursor);
    if (at === -1) continue;
    matched++;
    cursor = at + 1;
  }
  return matched / heard.length >= OVERLAP_RATIO;
}

/**
 * True when a transcript should be treated as Orion hearing itself.
 *
 * `sinceSpokenMs` is the time between Orion's last clip ending and this
 * transcript arriving; past {@link ECHO_WINDOW_MS} the user has had time to
 * genuinely repeat something back, so we stop suspecting it. A user who really
 * does parrot Orion inside the window loses one turn and can just say it again,
 * which is a far cheaper failure than the two-voice feedback loop.
 */
export function looksLikeSelfEcho(
  transcript: string,
  lastSpoken: string,
  sinceSpokenMs: number
): boolean {
  if (!transcript.trim() || !lastSpoken.trim()) return false;
  if (sinceSpokenMs > ECHO_WINDOW_MS || sinceSpokenMs < 0) return false;
  return isFragmentOf(words(transcript), words(lastSpoken));
}
