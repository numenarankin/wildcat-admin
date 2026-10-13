/**
 * Vendor invoice: the PURE grouping that turns the flat rows the data-entry grid
 * holds (one row per CHARGE LINE) into invoice drafts — ONE per DOCUMENT
 * (vendor x invoice number) — each carrying its charge lines.
 *
 * Same shape and same reason as `./oil-run-statement`: the grid is flat, so the
 * header facts (vendor, invoice number, date, property, totals) repeat on every
 * row, and grouping folds them back up. No I/O — the write layer
 * (`dispatchWrite` -> `writeVendorInvoices`) resolves the printed vendor and
 * property refs to ids and persists to `pidx_documents` / `pidx_lines` and their
 * typed children. Kept pure so the grouping, the key, and the tax reconciliation
 * are unit-tested without a database.
 *
 * Two things here are deliberately NOT the model's job, because it gets them
 * wrong in ways that are expensive to detect later:
 *
 *  - **Folding.** The model emits one row per line and repeats the header. If it
 *    were asked to nest, a two-line invoice would sometimes come back as two
 *    one-line invoices.
 *  - **Tax arithmetic.** The document states which lines are taxable and prints
 *    ONE tax total. Computing a per-line tax needs rates by jurisdiction and
 *    effective date, which we do not have, so v1 records what was printed and
 *    flags a MISLABEL — a vendor calling the Texas Chapter 191 well-servicing tax
 *    "Sales Tax" — rather than pretending to check the arithmetic.
 */

import { canonical } from "@/lib/ai/ingest/normalize";
import type { VendorInvoiceRow } from "@/lib/ai/ingest/schemas";

/** One charge line on a drafted invoice. */
export interface VendorInvoiceLine {
  lineNo: string;
  description: string;
  chargeType: "Labor" | "Materials" | "Equipment" | "Other";
  chargeSubtype: string;
  quantity: number | null;
  uom: string;
  unitPrice: number | null;
  noCharge: boolean;
  amount: number | null;
  serviceStart: string;
  serviceEnd: string;
  /** null = the invoice did not say, which is different from "not taxable". */
  taxable: boolean | null;
  taxFlagRaw: string;
  afeNumber: string;
  costCenter: string;
  glCode: string;
  ticketNo: string;
  workOrderNo: string;
  poNumber: string;
  sourceText: string;
}

/**
 * How the printed tax label compares to what the described work is actually
 * taxed under. `mislabeled` means a Chapter 191 "oil well service" job billed
 * under a label that says sales tax; it decides the stored `tax_type` and is
 * never shown to the user, because the vendor's wording changes no figure.
 */
export type TaxLabelVerdict =
  | "no_tax_line"
  | "consistent"
  | "mislabeled"
  | "unknown";

/** A drafted invoice: ONE document's charge lines. */
export interface VendorInvoiceDraft {
  vendor: string;
  invoiceNo: string;
  /** True when no invoice number was printed and the key had to be minted. */
  invoiceNoDerived: boolean;
  invoiceDate: string;
  dueDate: string;
  paymentTerms: string;
  documentKind: "invoice" | "field_ticket";
  propertyRef: string;
  county: string;
  rrcDistrict: string;
  subtotal: number | null;
  taxPrinted: number | null;
  taxLabelRaw: string;
  /** What the label claims versus what the work is; see {@link TaxLabelVerdict}. */
  taxLabelVerdict: TaxLabelVerdict;
  invoiceTotal: number | null;
  lines: VendorInvoiceLine[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO date string, or "" if the value is not a clean YYYY-MM-DD. */
function iso(v: string): string {
  const t = (v ?? "").trim();
  return ISO.test(t) ? t : "";
}

/**
 * The services Texas Tax Code ch. 191 subch. E taxes at 2.42% as "oil well
 * service", which displaces sales tax on that labor (34 TAC 3.324). Matched
 * against the line description because the description is the only place the
 * document says what was actually done.
 *
 * Deliberately narrow. A false positive here accuses a vendor of mislabeling
 * their tax, so the list holds only the statutory terms and their common trade
 * spellings, not everything that happens on a wellbore.
 */
const CH191_TERMS = [
  "cement",
  "cementing",
  "squeeze",
  "acidize",
  "acidizing",
  "acid job",
  "frac",
  "fracture",
  "fracturing",
  "stimulat",
  "perforat",
  "shoot",
  "wireline log",
  "gamma ray",
  "casing collar",
  "ccl",
  "bond log",
  "downhole survey",
];

/** Labels a vendor prints that assert sales tax rather than the 2.42% tax. */
const SALES_TAX_TERMS = ["sales tax", "state tax", "local tax", "use tax"];

/** True when a line's description names a Chapter 191 "oil well service". */
export function isCh191Service(description: string): boolean {
  const d = (description ?? "").toLowerCase();
  return CH191_TERMS.some((t) => d.includes(t));
}

/**
 * Compare the printed tax label against the work described on the lines.
 *
 * Only three inputs matter and none of them is a rate table, which is the point:
 * this catches the GLOC and Quasar "Sales Tax (2.42%)" case on day one without
 * needing jurisdiction rates that do not exist yet.
 */
export function classifyTaxLabel(
  taxPrinted: number | null,
  taxLabelRaw: string,
  lines: VendorInvoiceLine[]
): TaxLabelVerdict {
  if (taxPrinted == null || taxPrinted === 0) return "no_tax_line";
  const label = (taxLabelRaw ?? "").toLowerCase().trim();
  if (label === "") return "unknown";
  const saysSalesTax = SALES_TAX_TERMS.some((t) => label.includes(t));
  const saysWellService =
    label.includes("well service") ||
    label.includes("well servicing") ||
    label.includes("191");
  const hasCh191Work = lines.some((l) => isCh191Service(l.description));

  // The tell: a 2.42% rate printed next to a sales-tax label. Texas sales tax is
  // never 2.42%, so the rate itself gives the vendor away even when no line
  // description matches the term list.
  const printsCh191Rate = /2\.42\s*%/.test(label);

  if (saysSalesTax && (hasCh191Work || printsCh191Rate)) return "mislabeled";
  if (saysWellService) return "consistent";
  if (saysSalesTax) return "consistent";
  return "unknown";
}

/**
 * `canonical` with the spaces squeezed out, so an initialism printed two ways in
 * one packet compares equal: "G.L.O.C." canonicalizes to "g l o c" and "GLOC" to
 * "gloc", which would split one invoice into two drafts.
 *
 * Local rather than a change to `canonical` itself: that function is the dedup
 * key for every other ingest type, and loosening it there would silently merge
 * records across the whole pipeline.
 */
function squash(value: string): string {
  return canonical(value).replace(/\s+/g, "");
}

/**
 * The date to file a document under, and whether we inferred it.
 *
 * A vendor invoice prints its own date and that is the answer. A field ticket
 * often does not: one ticket can cover two separate jobs, so the only dates on
 * it are the service dates of its lines and there is no single ticket date to
 * print. Those documents file under their LATEST service date, the day the work
 * being billed finished, which is the day an operator reaching for the ticket
 * would name.
 *
 * Flagged as derived so a date we chose is never read as one the vendor
 * printed, exactly as `invoiceNoDerived` does for a minted number. A document
 * with no dates anywhere returns null and files undated rather than being
 * rejected: `doc_date` is nullable for that case (2026082400100).
 */
export function documentDate(d: {
  invoiceDate: string;
  lines: { serviceStart: string; serviceEnd: string }[];
}): { date: string | null; derived: boolean } {
  if (d.invoiceDate) return { date: d.invoiceDate, derived: false };

  // ISO dates sort lexically, so "latest" is plain string comparison.
  let latest = "";
  for (const l of d.lines) {
    for (const candidate of [l.serviceStart, l.serviceEnd]) {
      if (candidate && candidate > latest) latest = candidate;
    }
  }
  return latest ? { date: latest, derived: true } : { date: null, derived: false };
}

/**
 * Group key for one invoice document.
 *
 * Vendor plus invoice number, the vendor squashed so a differently-punctuated
 * spelling on two rows of the same document does not split it in half. When no
 * invoice number was printed — EXO's daily job descriptions and the 2021 Dollar
 * packet carry hours, rates and a total with no number — the date and property
 * stand in, so two different days do not silently merge into one document.
 */
export function invoiceKey(r: {
  vendor: string;
  invoiceNo: string;
  invoiceDate: string;
  propertyRef: string;
}): string {
  const vendor = squash(r.vendor);
  const no = squash(r.invoiceNo);
  if (no !== "") return `${vendor}|${no}`;
  return `${vendor}|@${iso(r.invoiceDate)}|${squash(r.propertyRef)}`;
}

/** First non-blank value across the group's rows, for a repeated header fact. */
function firstText(rows: VendorInvoiceRow[], pick: (r: VendorInvoiceRow) => string): string {
  for (const r of rows) {
    const v = (pick(r) ?? "").trim();
    if (v !== "") return v;
  }
  return "";
}

/** First non-null value across the group's rows, for a repeated money total. */
function firstNumber(
  rows: VendorInvoiceRow[],
  pick: (r: VendorInvoiceRow) => number | null
): number | null {
  for (const r of rows) {
    const v = pick(r);
    if (v != null) return v;
  }
  return null;
}

/** "yes"/"no"/"unknown" -> the tri-state the column actually stores. */
function taxableFlag(v: VendorInvoiceRow["taxable"]): boolean | null {
  return v === "yes" ? true : v === "no" ? false : null;
}

/**
 * Fold flat charge-line rows into one draft per document.
 *
 * Order is preserved: lines come out in the order the model emitted them, which
 * is the order they were printed, so a reviewer reading the draft next to the
 * PDF sees the same sequence. Groups come out in first-seen order for the same
 * reason.
 */
/** Header fields the model fills on an invoice's FIRST row and leaves blank after. */
const HEADER_TEXT = [
  "vendor",
  "invoiceNo",
  "invoiceDate",
  "dueDate",
  "paymentTerms",
  "propertyRef",
  "county",
  "rrcDistrict",
  "taxLabelRaw",
] as const;
const HEADER_NUM = ["subtotal", "taxPrinted", "invoiceTotal"] as const;

/**
 * Carry each invoice's header down its own rows.
 *
 * The model fills the header once per invoice and leaves it blank on the
 * following lines — repeating fourteen fields on every row is what pushed a
 * multi-invoice packet past the extraction timeout. A blank row therefore
 * belongs to the invoice above it, and a row that names a vendor or an invoice
 * number starts a new one.
 *
 * Deliberately NOT a blanket "fill every blank from the previous row": only the
 * header travels. A line's own blank fields (no AFE, no unit price) stay blank,
 * because inheriting those would invent data.
 */
function fillDownHeaders(rows: VendorInvoiceRow[]): VendorInvoiceRow[] {
  let current: VendorInvoiceRow | null = null;
  return rows.map((r) => {
    // A row that names either identifier begins a new invoice.
    const startsInvoice =
      (r.vendor ?? "").trim() !== "" || (r.invoiceNo ?? "").trim() !== "";
    if (startsInvoice || current === null) {
      current = r;
      return r;
    }
    const filled = { ...r };
    for (const k of HEADER_TEXT) {
      if ((filled[k] ?? "") === "") filled[k] = current[k];
    }
    for (const k of HEADER_NUM) {
      if (filled[k] == null) filled[k] = current[k];
    }
    // documentKind has a non-empty default, so it is carried unconditionally.
    filled.documentKind = current.documentKind;
    return filled;
  });
}

export function groupInvoiceLines(input: VendorInvoiceRow[]): VendorInvoiceDraft[] {
  const rows = fillDownHeaders(input);
  const groups = new Map<string, VendorInvoiceRow[]>();
  for (const r of rows) {
    const key = invoiceKey(r);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const drafts: VendorInvoiceDraft[] = [];
  for (const group of groups.values()) {
    const lines: VendorInvoiceLine[] = group.map((r) => ({
      lineNo: (r.lineNo ?? "").trim(),
      description: (r.description ?? "").trim(),
      chargeType: r.chargeType,
      chargeSubtype: (r.chargeSubtype ?? "").trim(),
      quantity: r.quantity,
      uom: (r.uom ?? "").trim(),
      // A "No Charge" line has no price, and 0 would read as a free line that
      // was priced rather than one the vendor declined to bill.
      unitPrice: r.noCharge ? null : r.unitPrice,
      noCharge: r.noCharge,
      amount: r.amount,
      serviceStart: iso(r.serviceStart),
      serviceEnd: iso(r.serviceEnd),
      taxable: taxableFlag(r.taxable),
      taxFlagRaw: (r.taxFlagRaw ?? "").trim(),
      afeNumber: (r.afeNumber ?? "").trim(),
      costCenter: (r.costCenter ?? "").trim(),
      glCode: (r.glCode ?? "").trim(),
      ticketNo: (r.ticketNo ?? "").trim(),
      workOrderNo: (r.workOrderNo ?? "").trim(),
      poNumber: (r.poNumber ?? "").trim(),
      sourceText: (r.sourceText ?? "").trim(),
    }));

    const taxPrinted = firstNumber(group, (r) => r.taxPrinted);
    const taxLabelRaw = firstText(group, (r) => r.taxLabelRaw);
    const invoiceNo = firstText(group, (r) => r.invoiceNo);

    drafts.push({
      vendor: firstText(group, (r) => r.vendor),
      invoiceNo,
      invoiceNoDerived: invoiceNo === "",
      invoiceDate: iso(firstText(group, (r) => r.invoiceDate)),
      dueDate: iso(firstText(group, (r) => r.dueDate)),
      paymentTerms: firstText(group, (r) => r.paymentTerms),
      documentKind: group[0].documentKind,
      propertyRef: firstText(group, (r) => r.propertyRef),
      county: firstText(group, (r) => r.county),
      rrcDistrict: firstText(group, (r) => r.rrcDistrict),
      subtotal: firstNumber(group, (r) => r.subtotal),
      taxPrinted,
      taxLabelRaw,
      taxLabelVerdict: classifyTaxLabel(taxPrinted, taxLabelRaw, lines),
      invoiceTotal: firstNumber(group, (r) => r.invoiceTotal),
      lines,
    });
  }
  return drafts;
}
