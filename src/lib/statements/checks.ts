/**
 * Deterministic checks over an extracted statement — PURE math, no DB / React /
 * I/O, so it unit-tests without a database or a model call.
 *
 * The model is good at reading a settlement statement and bad at noticing when
 * its own arithmetic doesn't close. These checks catch the second thing for
 * free, before any validation pass and before a human looks at the numbers.
 *
 * Nothing here BLOCKS or MUTATES. Every finding is a warning the review UI
 * badges on the offending field, exactly the way `findDuplicateRevenue` badges a
 * likely-duplicate transaction without excluding it: we guide, the user decides.
 * A warning on a correct statement costs a glance; silently "fixing" a number
 * the purchaser actually printed would be much worse.
 */

import type { ExtractedStatement } from "@/lib/statements/extract";

export type WarningCode =
  /** netValue ≠ gross − deducts − taxes (− fees on gas). */
  | "net-mismatch"
  /** |volume × price − gross| is outside tolerance. */
  | "price-mismatch"
  /** Σ line netValue ≠ the statement's own printed total. */
  | "total-mismatch"
  /** periodEnd is before periodStart, or a date isn't ISO. */
  | "period-invalid"
  /** A line carries value but no volume — usually a misread column. */
  | "zero-volume"
  /** A lease was printed on the line but resolved to nothing. */
  | "unmatched-lease"
  /** The transcription marked this line's source text illegible (`[?]`). */
  | "illegible-source";

/** One finding, addressed to a specific statement and (usually) a line. */
export interface StatementWarning {
  code: WarningCode;
  /** Index into the extracted `statements` array. */
  statement: number;
  /** Index into that statement's `lineItems`, or null for header-level. */
  line: number | null;
  /** Human-readable, shown next to the field it concerns. */
  message: string;
}

/**
 * Absolute dollars. Two cents absorbs per-line rounding on a statement that
 * prints values to the cent but computes at higher precision.
 */
export const NET_TOLERANCE_USD = 0.02;

/**
 * Fraction of gross. Realized price is frequently a weighted average that the
 * statement rounds when printing, so `volume × price` rarely reproduces gross
 * exactly — 1% flags a genuinely wrong number without flagging every line.
 */
export const PRICE_TOLERANCE_RATIO = 0.01;

/** Absolute dollars against the statement's own printed total. */
export const TOTAL_TOLERANCE_USD = 0.05;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The marker `TRANSCRIBE_PROMPT` emits for a figure it could not read. */
const ILLEGIBLE = "[?]";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** Is `v` a usable finite number? Guards nulls from the nullable gas fields. */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Does `a` differ from `b` by MORE than `tolerance` dollars?
 *
 * The difference is rounded to cents first, because binary floating point makes
 * the exact boundary unreliable: `4700.02 - 4700` evaluates to
 * 0.020000000000436557, which is greater than a $0.02 tolerance by pure
 * representation error. Without the rounding, a statement that is off by exactly
 * the tolerance we said we would accept gets flagged — the reviewer learns the
 * badges cry wolf, and stops reading them.
 *
 * Cents are the right unit here in any case: every value being compared is money
 * the document printed to two decimal places.
 */
function differsBeyond(a: number, b: number, tolerance: number): boolean {
  const cents = Math.round(Math.abs(a - b) * 100) / 100;
  return cents > tolerance;
}

/**
 * Does any value in this line's free-text bag carry the illegible marker? The
 * marker rides in `raw` (and in the printed refs) because the typed numeric
 * fields are numbers — a figure the reader couldn't make out comes back null,
 * and the marker is the only signal that null means "unreadable" rather than
 * "not printed".
 */
function hasIllegibleSource(line: {
  leaseRef?: string;
  tankRef?: string;
  meterRef?: string;
  raw?: Record<string, unknown>;
}): boolean {
  if (
    [line.leaseRef, line.tankRef, line.meterRef].some((r) =>
      (r ?? "").includes(ILLEGIBLE)
    )
  ) {
    return true;
  }
  return Object.values(line.raw ?? {}).some(
    (v) => typeof v === "string" && v.includes(ILLEGIBLE)
  );
}

/**
 * Every deterministic finding across the extracted set, in statement then line
 * order. An empty array means the arithmetic closes — not that the extraction is
 * correct, only that it is self-consistent.
 */
export function checkStatements(
  statements: ExtractedStatement[]
): StatementWarning[] {
  const out: StatementWarning[] = [];

  statements.forEach((s, si) => {
    const add = (code: WarningCode, line: number | null, message: string) =>
      out.push({ code, statement: si, line, message });

    // --- Header ---------------------------------------------------------
    if (!ISO_DATE.test(s.periodStart) || !ISO_DATE.test(s.periodEnd)) {
      add("period-invalid", null, "The settlement period is missing or not a valid date.");
    } else if (s.periodEnd < s.periodStart) {
      add(
        "period-invalid",
        null,
        `Period ends (${s.periodEnd}) before it starts (${s.periodStart}).`
      );
    }

    // --- Lines ----------------------------------------------------------
    let netSum = 0;
    s.lineItems.forEach((l, li) => {
      const gross = num(l.grossValue) ?? 0;
      const deducts = num(l.deducts) ?? 0;
      const taxes = num(l.taxes) ?? 0;
      const fees = num(l.fees) ?? 0;
      const net = num(l.netValue) ?? 0;
      const volume = num(l.volume) ?? 0;
      const price = num(l.price);

      netSum += net;

      // Gas statements break out fees separately; oil ones fold them into
      // deducts. Subtracting a zero on the oil side costs nothing.
      const expectedNet = gross - deducts - taxes - fees;
      if (differsBeyond(expectedNet, net, NET_TOLERANCE_USD)) {
        add(
          "net-mismatch",
          li,
          `Net ${usd.format(net)} doesn't match gross − deducts − taxes${fees ? " − fees" : ""} (${usd.format(expectedNet)}).`
        );
      }

      /*
       * OIL ONLY. An oil statement prints a price per barrel, so volume × price
       * against gross is a real check on a real printed figure.
       *
       * A gas line's price is not printed anywhere — it is DERIVED from that
       * line's own net and volume (`realizedUnitPrice`), because no gas
       * settlement states a price per MCF. Checking a derivation against the
       * numbers it was derived from proves nothing and can only ever fire on
       * rounding, which is how a check stops being read.
       */
      if (l.product !== "gas" && price !== null && gross !== 0) {
        const implied = volume * price;
        if (Math.abs(implied - gross) > Math.abs(gross) * PRICE_TOLERANCE_RATIO) {
          add(
            "price-mismatch",
            li,
            `Volume × price is ${usd.format(implied)} but gross is ${usd.format(gross)}.`
          );
        }
      }

      if (volume === 0 && (gross !== 0 || net !== 0)) {
        add("zero-volume", li, "This line carries value but no volume.");
      }

      if (!l.leaseId && (l.leaseRef ?? "").trim()) {
        add(
          "unmatched-lease",
          li,
          `"${l.leaseRef}" didn't match a lease — pick one, or leave it unmatched.`
        );
      }

      if (hasIllegibleSource(l)) {
        add(
          "illegible-source",
          li,
          "Part of this line was unreadable on the page — check it against the document."
        );
      }
    });

    // --- Statement total ------------------------------------------------
    // Only meaningful when the document PRINTED a total. A computed total would
    // make this check a tautology, which is why the prompt is explicit that
    // `printedNetTotal` must be transcribed and null when absent.
    const printed = num(s.printedNetTotal);
    if (printed !== null && differsBeyond(printed, netSum, TOTAL_TOLERANCE_USD)) {
      add(
        "total-mismatch",
        null,
        `Line items sum to ${usd.format(netSum)} but the statement prints ${usd.format(printed)}.`
      );
    }
  });

  return out;
}

/** The warnings scoped to one statement, re-indexed for that statement's UI. */
export function warningsFor(
  warnings: StatementWarning[],
  statement: number
): StatementWarning[] {
  return warnings.filter((w) => w.statement === statement);
}
