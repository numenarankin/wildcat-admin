/**
 * A tank's name, derived — never stored.
 *
 * A tank has no name of its own worth keeping: in the field it is "the 123 tank
 * on Roach", and that is exactly the lease it sits on plus the number painted on
 * its side (the same number the gatherer's run tickets carry). Storing a
 * free-text name on top of those two facts only created a third thing to keep in
 * sync — rename the lease and the tank kept the old one.
 *
 * So `tanks.name` is no longer read or written anywhere. Every surface that
 * shows a tank shows this instead, computed from the tank's effective lease
 * (its battery's lease, else its own) and its `tank_no`.
 *
 * Pure module: no DB, no React, so the data layer, the reports, and their tests
 * all share one rule.
 */

/**
 * "Roach T123" — the lease and the tank number, prefixed by what the tank holds:
 * `T` for oil, `W` for water, so tank 123 on Jones is "Jones W123" if it is a
 * saltwater tank. The letter is how a pumper tells the two apart on a list where
 * both appear, and it is the letter they paint on the tank.
 *
 * Both parts are optional in the data, and each gap has an answer:
 *  - no number (legacy rows; the tank form requires one now) → "Roach tank"
 *  - no lease (a tank not yet assigned) → "T123"
 *  - neither → "Unnamed tank"
 *
 * A number the operator already typed with EITHER letter ("T123", "W123") keeps
 * one letter, and it is the product's: the tank holds what the row says it
 * holds, not what was typed into the number field.
 *
 * `product` is required rather than defaulting to oil so the compiler lists
 * every call site — a forgotten argument would silently print a `T` on a water
 * tank, which is the exact confusion this letter exists to end.
 */
export function tankDisplayName(
  leaseName: string | null | undefined,
  tankNo: string | null | undefined,
  product: "oil" | "water"
): string {
  const lease = (leaseName ?? "").trim();
  const no = (tankNo ?? "").trim().replace(/^[TtWw]\s*(?=\S)/, "");
  const letter = product === "water" ? "W" : "T";
  if (!no) return lease ? `${lease} tank` : "Unnamed tank";
  return lease ? `${lease} ${letter}${no}` : `${letter}${no}`;
}
