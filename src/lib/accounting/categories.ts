import { z } from "zod";
import type { TransactionKind } from "@/lib/accounting/types";

/**
 * A ledger category and its accounting code. The active set is per-organization
 * (configured in Settings → Accounting); `DEFAULT_CATEGORIES` below is the
 * sample fallback used until an org saves its own chart of accounts.
 */
export interface Category {
  code: string;
  label: string;
  kind: TransactionKind;
}

/** Schema for the org-supplied chart of accounts (the Settings JSON). */
export const categoriesSchema = z
  .array(
    z.object({
      code: z.string().trim().min(1, "code is required"),
      label: z.string().trim().min(1, "label is required"),
      kind: z.enum(["revenue", "expense"]),
    })
  )
  .min(1, "Add at least one category");

/** Built-in sample chart of accounts for an oil & gas operator. */
export const DEFAULT_CATEGORIES: Category[] = [
  // Revenue
  { code: "REV-OIL", label: "Oil Sales", kind: "revenue" },
  { code: "REV-GAS", label: "Gas Sales", kind: "revenue" },
  { code: "REV-NGL", label: "NGL Sales", kind: "revenue" },
  { code: "REV-SWD", label: "Saltwater Disposal Income", kind: "revenue" },
  { code: "REV-OTH", label: "Other Income", kind: "revenue" },
  // Expense
  { code: "EXP-LOE", label: "Lease Operating Expense", kind: "expense" },
  { code: "EXP-WRK", label: "Workover & Repairs", kind: "expense" },
  { code: "EXP-SEV", label: "Severance / Production Tax", kind: "expense" },
  { code: "EXP-CMP", label: "Compression", kind: "expense" },
  { code: "EXP-CHM", label: "Chemicals", kind: "expense" },
  { code: "EXP-PWR", label: "Electricity & Fuel", kind: "expense" },
  { code: "EXP-WTR", label: "Water Disposal", kind: "expense" },
  { code: "EXP-EQP", label: "Equipment Rental", kind: "expense" },
  { code: "EXP-LBR", label: "Pumping & Labor", kind: "expense" },
  { code: "EXP-TRN", label: "Trucking & Transportation", kind: "expense" },
  { code: "EXP-INS", label: "Insurance", kind: "expense" },
  { code: "EXP-ADM", label: "Administrative", kind: "expense" },
];

/** Categories of a given kind, from a supplied list. */
export function categoriesFor(
  categories: Category[],
  kind: TransactionKind
): Category[] {
  return categories.filter((c) => c.kind === kind);
}

/** Parses + validates the Settings JSON text into a category list. */
export function parseCategories(
  text: string
): { ok: true; categories: Category[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  const result = categoriesSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    return {
      ok: false,
      error: path ? `${path}: ${first.message}` : (first?.message ?? "Invalid format."),
    };
  }
  return { ok: true, categories: result.data };
}

/**
 * The prompt a user copies to have an LLM convert their raw account list into
 * the exact JSON this app expects. Kept here so the button and any docs stay in
 * sync with the schema above.
 */
export const CATEGORIES_PROMPT = `Convert my chart of accounts into JSON for my accounting app.

Output ONLY a JSON array — no commentary, no code fences. Each item must be an object with exactly these keys:
- "code": string — the account code (e.g. "EXP-LBR")
- "label": string — the human-readable account name (e.g. "Pumping & Labor")
- "kind": "revenue" or "expense" — whether the account records money coming in (revenue) or going out (expense)

Example:
[
  { "code": "REV-GAS", "label": "Gas Sales", "kind": "revenue" },
  { "code": "EXP-LBR", "label": "Pumping & Labor", "kind": "expense" }
]

Here is my list of accounts (paste yours below):
`;
