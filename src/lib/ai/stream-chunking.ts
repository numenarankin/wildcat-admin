/**
 * How much text `smoothStream` releases per tick.
 *
 * ## The bug this replaces
 *
 * The old rule was `buffer > 80 ? 5 : buffer > 24 ? 2 : 1` characters, on a
 * 12 ms tick, written on the belief that a big buffer means "we have fallen
 * behind the model, go faster". That belief is wrong about how the SDK drains.
 *
 * Read `smoothStream`'s transform (node_modules/ai/dist/index.mjs): on every
 * incoming delta it loops `while (detectChunk(buffer) != null)`, emitting a
 * chunk and `await`ing the delay each time, until the chunker returns null. Our
 * chunker only returns null on an EMPTY buffer — so each delta is drained all
 * the way to zero before the next one is read. `buffer.length` therefore never
 * measures backlog. It measures how much of the CURRENT delta is left, and it
 * falls as the drain proceeds, so every delta finished at the slowest tier: two
 * characters per tick, then one.
 *
 * Cost, for a 100-character delta under the old rule: ~4 ticks at 5, ~28 at 2,
 * ~24 at 1 — about 56 ticks, 0.67 s, call it 150 characters a second. A
 * six-thousand-character answer spent about forty seconds being typed out after
 * the model had already produced it.
 *
 * And it was not merely cosmetic. `transform` is awaited, so the sleeping
 * blocked the upstream read: the model's stream was not consumed while we
 * dripped, and everything behind it — including tool-call chunks — queued.
 *
 * ## The measurement
 *
 * A 6,000-character answer, streamed as the model actually streams it (deltas
 * of a few characters), against generation of about 30 s at 50 tokens/second:
 *
 *     delta size    old transform    new transform
 *     4 chars           72.0 s            9.0 s
 *     8 chars           72.0 s            9.0 s
 *     30 chars          64.8 s            4.8 s
 *
 * Small deltas were the pathological case and they are the common case: at
 * eight characters the old rule never once reached its fast tier, spending
 * eight ticks on eight characters. It roughly tripled the length of every long
 * answer.
 *
 * ## The rule
 *
 * Emit a small delta WHOLE — one tick, nothing to smooth — and split only a
 * delta big enough to visibly pop, into a bounded number of pieces. Cost is
 * then one tick per token rather than one tick per character, which is under
 * the model's own generation rate and therefore free.
 */

/**
 * A delta at or below this is emitted WHOLE, in one tick.
 *
 * The cost that matters is per emitted CHUNK, and the model streams token by
 * token — deltas of roughly four to eight characters, thousands of them in a
 * long answer. Splitting those is all cost and no smoothing: nobody can see a
 * four-character delta arrive in two pieces, and at 12 ms each the pieces add
 * up to entire minutes across an answer. Splitting is only worth paying for on
 * a delta large enough to visibly pop.
 */
const WHOLE_BELOW = 24;
/** Pieces a large delta is split into. */
const PIECES = 4;
/** Floor on a piece, so the tail of a large delta does not dribble. */
const MIN_CHARS = 12;

/**
 * `delayInMs` for `smoothStream`.
 *
 * Since a small delta now costs exactly one tick, this is a CEILING on delta
 * throughput: one over the delay, in deltas per second. It has to sit below the
 * model's own inter-token interval or it binds and the transform is once again
 * the slowest thing in the turn.
 *
 * Opus streams somewhere around 50-100 tokens a second, so a token arrives
 * every 10-20 ms. 12 ms — the old value — capped at 83/s and bound on anything
 * above that; 6 ms caps at 166/s, which is clear of the range with margin. Text
 * still glides, because the smoothing that matters comes from splitting big
 * deltas rather than from the tick being slow.
 */
export const SMOOTH_DELAY_MS = 6;

/** The chunk to release, or null when there is nothing left. */
export function smoothChunk(buffer: string): string | null {
  if (buffer.length === 0) return null;
  if (buffer.length <= WHOLE_BELOW) return buffer;
  return buffer.slice(0, Math.max(MIN_CHARS, Math.ceil(buffer.length / PIECES)));
}

/**
 * Ticks to drain a delta of `size`. Test-facing: the cost is the whole point,
 * and it is not obvious from the rule.
 */
export function ticksToDrain(size: number): number {
  let left = size;
  let ticks = 0;
  while (left > 0) {
    const chunk = smoothChunk("x".repeat(left));
    left -= (chunk as string).length;
    ticks++;
  }
  return ticks;
}
