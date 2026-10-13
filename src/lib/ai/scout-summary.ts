"use server";

/**
 * Scout's generated dossier summaries: four to six sentences of prose over the
 * SAME figures the Summary tab is already drawing beside them.
 *
 * WHY IT IS BUILT THIS WAY
 * Orion can already answer every one of these questions in the drawer through
 * the RRC read tools, but the user has to know to ask and the dossier itself
 * says nothing. This closes that, under one hard constraint: the summary must be
 * reconcilable with the pane it sits on. So the model gets NO TOOLS and no
 * database. It is handed the payload the tab renders and asked to write it out,
 * which makes "the summary invented a number" a checkable failure rather than a
 * judgement call — every figure in the prose has to appear in the payload, and
 * every figure in the payload is on screen.
 *
 * The payload builders below therefore mirror the modals row for row, INCLUDING
 * their omissions: `Row` renders nothing for a null value, so a null fact is not
 * in the payload either, and a tile that shows a dash contributes nothing. That
 * is what makes a thin record produce a short honest summary instead of an
 * invented one, which is the common case and not the edge case: 927,795 of the
 * mirror's 1,368,247 wellbore rows carry no status or compliance at all.
 *
 * THE FIGURES ARE NOT RECOMPUTED HERE. `perMonthOf`, `idleFor`, `lateralFeet`
 * and the P-5 table live in `@/lib/scout/dossier-format`, and the modals read
 * the same ones. They were briefly copied into this file, on the reasoning that
 * a summary must say what the tab says; the copies are what made that fragile,
 * because the tab could change and the sentence beside it could not follow.
 * The module is pure, so neither the `"use client"` modal nor this `"use
 * server"` file has to import the other.
 */

import { createHash } from "node:crypto";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { assertPlatformAdmin } from "@/lib/auth/platform-admin";
import { gateAI, meterAnthropic } from "@/lib/billing/credits";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getLeaseDossier, getWellDossier } from "@/lib/scout/rrc-queries";
import {
  idleFor,
  lateralFeet,
  perMonthOf,
  P5_ORG,
} from "@/lib/scout/dossier-format";
import { H15_STATUS } from "@/lib/scout/rrc-uic";
import { stripEmDashes } from "@/lib/reports/prose";
import { api8, fmtDate8, fmtVol, titleCase } from "@/lib/scout/format";
import { districtLabel } from "@/lib/scout/rrc-districts";
import type {
  LeaseDossier,
  WellDossier,
} from "@/lib/scout/rrc-types";

// ------------------------------------------------------------------ contract

/** Which dossier a payload describes. `operator` is reserved, not yet built. */
export type DossierSubject = "well" | "lease" | "operator";

/** One rendered fact, as its tab labels it. `section` groups it as the tab does. */
export interface SummaryFact {
  section: string;
  label: string;
  value: string;
}

/** Everything the model is allowed to know about a subject. */
export interface DossierPayload {
  subject: DossierSubject;
  /** The modal's own title. */
  title: string;
  /** The modal's sub-line (API, county, district / lease no, district, field). */
  subtitle: string;
  facts: SummaryFact[];
}

export interface ScoutSummary {
  text: string;
  /** True when this came back from the process cache without a model call. */
  cached: boolean;
  /**
   * Set instead of `text` when no summary could be produced. Surfaced verbatim
   * in the UI: an AI feature that fails silently reads as a broken button.
   */
  error?: string;
}

// --------------------------------------------------------------------- model

const MODEL = "claude-opus-5";

/**
 * LOW, and stated rather than inherited.
 *
 * With `effort` unset Opus 5 deliberates at `high`, and that silent phase is
 * what makes a call feel hung (a one-line ingest verdict measured 18 seconds of
 * it). This job has nothing to deliberate about: every fact is supplied, nothing
 * is derived, and the only work is choosing which four to six of the supplied
 * facts matter and writing them as sentences. The user is sitting in front of an
 * open modal waiting for it, so latency here is felt directly, unlike the cron
 * summaries in `@/lib/reports/schedule/summary` that can afford `medium`.
 */
const EFFORT = "low";

/**
 * Six sentences need a fraction of this, but the AI SDK does not recognise the
 * Claude 5 model ids and silently caps an unknown model at 4096, so the ceiling
 * is stated. Set well above the target because thinking tokens, however few at
 * `low`, are drawn from the same budget: a ceiling that fits only the prose
 * returns an empty completion instead of a short one.
 */
const MAX_OUTPUT_TOKENS = 1000;

const SYSTEM = [
  "You are a petroleum land and production analyst writing the short summary at",
  "the top of a Texas Railroad Commission dossier. The reader is an operator or a",
  "landman looking at this exact record on screen.",
  "Write 4 to 6 sentences of plain prose. No bullet points, no headings, no",
  "preamble, no closing offer of help.",
  "The record below is the only source you may state a fact from. Every figure",
  "you state must appear in it, copied exactly as it is written there, units and",
  "separators included. Do not add, total, average, convert, rank or estimate any",
  "figure, and do not bring in outside knowledge of the operator, the field or",
  "the basin. If the record does not support something, leave it out.",
  "Lead with what this is and what it is doing now, then the facts that change a",
  "decision: status and how long it has been idle, depth and completion, operator",
  "standing (P-5, H-15, 14(b)(2)), production level, and whether reports are being",
  "filed.",
  "What you are given is this dossier's Summary tab. Other tabs of the same",
  "dossier carry production, well tests, permits and filings, so never say that",
  "something does not exist merely because it is absent below. The exception is a",
  "record that states it is not on schedule or a historic wellbore: there the",
  "state genuinely publishes no current detail, and saying so is the answer.",
  "Texas records are often thin. When the record below is short, write two or",
  "three sentences saying what is known and stop. Never fill a gap with",
  "inference.",
  "Do not describe this application, this tab, or the record's structure.",
  "Do not use em dashes; use commas or periods instead.",
].join(" ");

// --------------------------------------------------------------------- cache

/**
 * Bump when the prompt or the payload shape changes: it is part of the key, so
 * every stored summary becomes a miss rather than lingering in the old voice.
 */
const PROMPT_VERSION = 1;

/**
 * How long a generated summary is served without re-asking. The mirror reloads
 * nightly at most, and the key already carries the facts, so this is only a
 * ceiling on how stale a WORDING may get, not the invalidation mechanism.
 */
const TTL_MS = 12 * 60 * 60 * 1000;

/** Entries kept before the oldest is dropped. A summary is ~600 bytes. */
const CACHE_LIMIT = 500;

/**
 * PER PROCESS, in memory, deliberately not a table.
 *
 * This app runs behind its migrations, so there is no column to write to, and a
 * summary is cheap to regenerate. What matters is not durability but WHAT
 * INVALIDATES IT: the key is a hash of the payload itself, so the entry dies the
 * moment any fact on the tab changes and cannot outlive the numbers it describes.
 * A vintage stamp would need a second read to check and would still serve stale
 * prose for anything that changed off-cycle. The cost is that each server
 * instance warms its own copy and a redeploy empties it, which for a read that
 * bills a model call and is asked for by hand is the right trade.
 */
const cache = new Map<string, { text: string; at: number }>();

function keyOf(payload: DossierPayload): string {
  const digest = createHash("sha256")
    .update(renderPayload(payload))
    .digest("hex")
    .slice(0, 32);
  return `${payload.subject}:v${PROMPT_VERSION}:${digest}`;
}

function remember(key: string, text: string): void {
  if (cache.size >= CACHE_LIMIT) {
    // Insertion-ordered, so the first key is the oldest write.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { text, at: Date.now() });
}

// ------------------------------------------------------------------- payload

/** Skip a fact the tab itself would not draw: null, blank, or an em dash tile. */
function push(
  facts: SummaryFact[],
  section: string,
  label: string,
  value: string | null | undefined
): void {
  const v = (value ?? "").trim();
  // "—" is what a tile shows for an unpublished figure. Passed through it would
  // be a number-shaped hole in the prompt, which is exactly what invites the
  // model to fill it.
  if (!v || v === "—") return;
  facts.push({ section, label, value: v });
}






const num = (n: number | null | undefined): string | null =>
  n == null ? null : n.toLocaleString();

/**
 * The well dossier's Summary tab, as facts: the four tiles, the Wellbore panel,
 * the Lease & field panel, and the badges in the modal header. Nothing from the
 * Production, Injection, Compliance, Filings, Completions or Location tabs —
 * those are not on screen when this summary is read.
 */
export async function buildWellPayload(
  well: WellDossier
): Promise<DossierPayload> {
  const h = well.header;
  const s = well.status;
  const loc = well.location;
  const facts: SummaryFact[] = [];

  const idle = idleFor(s?.curr_inact_yrs ?? null, s?.curr_inact_mos ?? null);
  const lateral =
    loc?.lat != null &&
    loc.lon != null &&
    loc.bottom_lat != null &&
    loc.bottom_lon != null
      ? lateralFeet(loc.lat, loc.lon, loc.bottom_lat, loc.bottom_lon)
      : null;

  push(
    facts,
    "Highlights",
    "Status",
    `${titleCase(s?.well_type_name) || "Not on schedule"}${
      well.current
        ? idle
          ? `, idle ${idle}`
          : ", producing"
        : ", historic wellbore record"
    }`
  );
  push(
    facts,
    "Highlights",
    "Total depth",
    s?.api_depth
      ? `${s.api_depth.toLocaleString()} ft${
          lateral ? `, ${lateral.toLocaleString()} ft lateral` : ""
        }`
      : null
  );
  const completed = fmtDate8(Number(s?.completion_date));
  push(
    facts,
    "Highlights",
    "Completed",
    completed
      ? `${completed}${
          s?.orig_completion_dt && s.orig_completion_dt !== s.completion_date
            ? `, originally ${fmtDate8(Number(s.orig_completion_dt))}`
            : ""
        }`
      : null
  );
  push(
    facts,
    "Highlights",
    "Operator",
    titleCase(h?.operator_name)
      ? `${titleCase(h.operator_name)}${
          h.on_schedule === "Y" ? ", current (on schedule)" : ", not current"
        }`
      : null
  );

  push(facts, "Wellbore", "API", api8(Number(well.api_number)));
  push(facts, "Wellbore", "Well no.", h?.well_no_display ?? h?.well_no);
  push(facts, "Wellbore", "Type", titleCase(s?.well_type_name));
  push(
    facts,
    "Wellbore",
    "Oil / gas",
    h?.oil_gas_code === "O" ? "Oil" : h?.oil_gas_code === "G" ? "Gas" : null
  );
  push(facts, "Wellbore", "Setting", s?.wb_water_land_code);
  push(
    facts,
    "Wellbore",
    "Multiple completions",
    s?.multi_comp_flag === "Y" ? "Yes" : null
  );
  push(facts, "Wellbore", "Oil unit no.", h?.oil_unit_number);
  push(facts, "Wellbore", "County", titleCase(h?.county_name));
  push(facts, "Wellbore", "District", h?.district);

  push(
    facts,
    "Lease and field",
    "Lease",
    h?.lease_number ? titleCase(h.lease_name) || h.lease_number : null
  );
  push(facts, "Lease and field", "Lease no.", h?.lease_number);
  push(
    facts,
    "Lease and field",
    "Field",
    h?.field_number
      ? titleCase(h.field_name) || `Field ${h.field_number}`
      : titleCase(h?.field_name)
  );
  push(facts, "Lease and field", "Field no.", h?.field_number);
  push(facts, "Lease and field", "Operator no.", h?.operator_number);
  push(
    facts,
    "Lease and field",
    "P-5 status",
    s ? P5_ORG[s.p5_org_status ?? ""] : null
  );
  push(facts, "Lease and field", "H-15", s ? H15_STATUS[s.h15_status_code ?? ""] : null);

  // The one badge in the modal header that no row below repeats. "Historic
  // record" is already in the Status line above, and re-stating it here would
  // only give the model two ways to say the same thing.
  if (well.compliance?.wb_14b2_flag === "Y") {
    push(facts, "Flags", "14(b)(2)", "Flagged");
  }

  return {
    subject: "well",
    title: `${titleCase(h?.lease_name) || "Lease"} ${
      h?.well_no_display ?? h?.well_no ?? ""
    }`.trim(),
    subtitle: [
      `API ${api8(Number(well.api_number))}`,
      titleCase(h?.county_name) ? `${titleCase(h.county_name)} County` : null,
      h?.district ? `District ${h.district}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    facts,
  };
}

/**
 * The lease dossier's Summary tab, as facts: the four tiles, the Lease record
 * panel, the Latest reported cycle panel, and the header badges. Nothing from
 * Production, Allowables, Disposition, Counties, Wells, Purchaser or Map.
 */
export async function buildLeasePayload(
  lease: LeaseDossier
): Promise<DossierPayload> {
  const monthly = lease.monthly ?? [];
  const oilMo = perMonthOf(monthly, "oil_prod_vol");
  const gasMo = perMonthOf(monthly, "gas_prod_vol");
  const reported = monthly.filter((m) => m.reported).length;
  const unfiled = monthly.filter(
    (m) => m.reported && m.prod_report_filed === "N"
  ).length;
  const latest = monthly.filter((m) => m.reported).at(-1);
  const lastFlowing = [...monthly]
    .reverse()
    .find((m) => m.oil_prod_vol || m.gas_prod_vol);
  const facts: SummaryFact[] = [];

  push(
    facts,
    "Highlights",
    "Oil per month",
    `${fmtVol(Math.round(oilMo))} bbl, ${reported} reported months on file`
  );
  push(facts, "Highlights", "Gas per month", `${fmtVol(Math.round(gasMo))} MCF`);
  push(
    facts,
    "Highlights",
    "Wells on lease",
    `${lease.wells.length.toLocaleString()}, ${lease.counties.length} count${
      lease.counties.length === 1 ? "y" : "ies"
    }`
  );
  push(
    facts,
    "Highlights",
    "Reports not filed",
    `${unfiled.toLocaleString()} of ${reported} reported months`
  );

  push(facts, "Lease record", "Lease no.", lease.lease_no);
  push(facts, "Lease record", "Type", lease.oil_gas_code === "O" ? "Oil" : "Gas");
  push(
    facts,
    "Lease record",
    "District",
    lease.district_name || districtLabel(lease.district_no)
  );
  push(
    facts,
    "Lease record",
    "Field",
    lease.field_no
      ? titleCase(lease.field_name) || `Field ${lease.field_no}`
      : titleCase(lease.field_name)
  );
  push(facts, "Lease record", "Field no.", lease.field_no);
  push(facts, "Lease record", "Field type", lease.field_type);
  push(facts, "Lease record", "Gas well no.", lease.gas_well_no);
  push(facts, "Lease record", "Operator", titleCase(lease.operator_name));
  push(
    facts,
    "Lease record",
    "Schedule",
    lease.off_schedule ? "Off schedule" : "On schedule"
  );
  push(facts, "Lease record", "Severance", lease.severance ? "Severed" : "None");

  // Titled with the cycle, exactly as the panel is, so the model can date the
  // figures without being told a month that is not on screen.
  const cycleSection = `Latest reported cycle${latest ? ` ${latest.cycle}` : ""}`;
  const bbl = (n: number | null | undefined) => {
    const v = num(n);
    return v ? `${v} bbl` : null;
  };
  const mcf = (n: number | null | undefined) => {
    const v = num(n);
    return v ? `${v} MCF` : null;
  };
  push(facts, cycleSection, "Oil", bbl(latest?.oil_prod_vol));
  push(facts, cycleSection, "Oil allowable", num(latest?.oil_allow));
  push(facts, cycleSection, "Oil in tank", num(latest?.oil_ending_bal));
  push(facts, cycleSection, "Gas", mcf(latest?.gas_prod_vol));
  push(facts, cycleSection, "Gas allowable", num(latest?.gas_allow));
  push(facts, cycleSection, "Condensate", bbl(latest?.cond_prod_vol));
  push(facts, cycleSection, "Casinghead", mcf(latest?.csgd_prod_vol));
  push(
    facts,
    cycleSection,
    "Report filed",
    latest ? (latest.prod_report_filed === "N" ? "No" : "Yes") : null
  );
  push(
    facts,
    cycleSection,
    "Last month with volume",
    lastFlowing ? lastFlowing.cycle : null
  );

  return {
    subject: "lease",
    title: titleCase(lease.lease_name) || `Lease ${lease.lease_no}`,
    subtitle: [
      `${lease.oil_gas_code === "O" ? "Oil" : "Gas"} lease #${lease.lease_no}`,
      `District ${lease.district_name || districtLabel(lease.district_no)}`,
      titleCase(lease.field_name),
    ]
      .filter(Boolean)
      .join(" · "),
    facts,
  };
}

/**
 * The payload as the model sees it, and as the cache hashes it. One fact per
 * line under its section, in the order the tab lays them out.
 */
export async function renderDossierPayload(
  payload: DossierPayload
): Promise<string> {
  return renderPayload(payload);
}

/** The cache key for a payload. Exported for the test that pins invalidation. */
export async function dossierCacheKey(payload: DossierPayload): Promise<string> {
  return keyOf(payload);
}

function renderPayload(payload: DossierPayload): string {
  const lines: string[] = [
    `${payload.subject === "well" ? "Well" : payload.subject === "lease" ? "Lease" : "Operator"}: ${payload.title}`,
  ];
  if (payload.subtitle) lines.push(payload.subtitle);
  let section = "";
  for (const f of payload.facts) {
    if (f.section !== section) {
      section = f.section;
      lines.push("", section.toUpperCase());
    }
    lines.push(`- ${f.label}: ${f.value}`);
  }
  return lines.join("\n");
}

// -------------------------------------------------------------------- action

/**
 * The one model call, shared by every subject. Not exported: an entry point
 * taking a caller-supplied payload would be a billed endpoint for arbitrary
 * text. Callers hand it a payload built here from a record we fetched.
 */
async function summarise(payload: DossierPayload): Promise<ScoutSummary> {
  if (payload.facts.length === 0) {
    // Nothing on the tab means nothing to write about, and a model asked to
    // summarise an empty record will produce something. Say the true thing.
    return {
      text: "The Railroad Commission publishes no detail on this record beyond its identifiers.",
      cached: false,
    };
  }

  const key = keyOf(payload);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { text: hit.text, cached: true };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: "", cached: false, error: "AI is not configured on this server." };
  }

  // One request-scoped client for the gate and the meter, so both resolve the
  // same org. Checked before the call, not after: charging for work we then
  // refuse to show is the worst order.
  const sb = await getSupabaseServer();
  const gate = await gateAI(sb);
  if (!gate.allowed) {
    return {
      text: "",
      cached: false,
      error:
        gate.reason === "gate_error"
          ? "AI credits could not be checked. Try again shortly."
          : "This organisation is out of AI credits.",
    };
  }

  try {
    const { text, usage } = await generateText({
      model: anthropic(MODEL),
      system: SYSTEM,
      prompt: `${renderPayload(payload)}\n\nWrite the summary.`,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      providerOptions: { anthropic: { effort: EFFORT } },
    });
    // Fire and forget: a metering hiccup must not swallow a summary the user is
    // already looking at.
    void meterAnthropic(
      {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cachedInputTokens,
        model: MODEL,
      },
      "scout dossier summary",
      sb
    );
    // The prompt asks for no em dashes; this is what guarantees it.
    const clean = stripEmDashes((text ?? "").trim());
    if (!clean) {
      return { text: "", cached: false, error: "The summary came back empty." };
    }
    remember(key, clean);
    return { text: clean, cached: false };
  } catch (error) {
    console.error("scout dossier summary failed", error);
    return { text: "", cached: false, error: "The summary could not be generated." };
  }
}

/**
 * Summarise one wellbore. Re-reads the dossier rather than trusting a payload
 * from the browser, so the prose is written over the same query the tab was
 * drawn from.
 */
export async function summariseWell(api: string): Promise<ScoutSummary> {
  await assertPlatformAdmin();
  const well = await getWellDossier(api);
  if (!well) return { text: "", cached: false, error: "No record for that API number." };
  return summarise(await buildWellPayload(well));
}

/** Summarise one lease, keyed as the mirror keys it. */
export async function summariseLease(
  oilGasCode: string,
  districtNo: string,
  leaseNo: string
): Promise<ScoutSummary> {
  await assertPlatformAdmin();
  const lease = await getLeaseDossier(oilGasCode, districtNo, leaseNo);
  if (!lease) return { text: "", cached: false, error: "No record for that lease." };
  return summarise(await buildLeasePayload(lease));
}
