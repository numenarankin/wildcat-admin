import { tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";

import { assertSignedIn } from "@/lib/auth/session";
import { getRrcLease, getRrcWell } from "@/lib/rrc/link";
import { GAS_KEYS, OIL_KEYS, streamOf } from "@/lib/scout/allocate-months";
import { hasRrcDb } from "@/lib/scout/rrc-db";
import {
  findDisposal,
  findSurveys,
  findWells,
  getCompletionReports,
  getCountyProfile,
  getCycleEdge,
  getFieldProfile,
  getInjectionEdge,
  getLeaderboard,
  getLeaseDossier,
  getLeaseYearly,
  getOperatorDisposition,
  getOperatorDossier,
  getOperatorNetwork,
  getProductionTrend,
  getWellDossier,
  listPermits,
  resolveCounty,
  resolveField,
  search,
} from "@/lib/scout/rrc-queries";
import { resolveOfficerNames } from "@/lib/ai/rrc/people";
import {
  findOwnersNear,
  getLeaseMinerals,
  getOwner,
  searchOwners,
} from "@/lib/scout/cad-queries";
import {
  cadCoverage,
  cadCoverageList,
  cadCoverageSentence,
  interestTotals,
} from "@/lib/scout/cad";
import {
  MAP_MODES,
  MAX_ZOOM,
  MIN_ZOOM,
  WELL_TYPE_VALUES,
  normalizeScoutView,
} from "@/lib/ai/scout-view-spec";
import type { MapMode } from "@/components/scout/map-filters";
import type {
  DispositionMonth,
  DispositionStream,
  G10Test,
  H15Test,
  PluggingJob,
  LeaseMonth,
  LeaseP4,
  WellboreFiling,
  WellConstruction,
  WellDossier,
  WellInjection,
} from "@/lib/scout/rrc-types";
import {
  H15_STATUS,
  H15_TEST_TYPE,
  P4_PRODUCT,
  P4_ROLE,
  casingLabel,
  h15Method,
  injTypeLabel,
  isDisposal,
} from "@/lib/scout/rrc-uic";

/**
 * Orion's read tools over the Texas Railroad Commission mirror (Scout).
 *
 * WHAT THIS IS. The `rrc` schema on Tiger Cloud is the RRC's PUBLIC record for
 * the whole state — every operator, lease, well, permit and completion report in
 * Texas, ~220M rows. It is NOT this company's data. The company's own wells,
 * tanks, meters and ledger live in Supabase behind the other tools, and the two
 * must never be conflated in an answer.
 *
 * GATING. `rrc-db.ts` deliberately carries no authorization: the mirror holds
 * only public records, so there is nothing to hide per-user, and access control
 * is about the early-access cohort instead. That makes gating the CALLER's job
 * — every tool here opens with `assertSignedIn()`.
 *
 * SHAPE. These results are read aloud over voice as often as they are rendered
 * in chat, so nothing here returns a raw dossier. A lease's 34-year monthly
 * series, an operator's 4,000-well fleet and a 25-code disposition matrix are
 * all summarised to the part that answers a question, with an explicit
 * `truncated` marker wherever a list was cut. A silent cut reads as "that's
 * all there is", which is worse than no answer.
 *
 * PERFORMANCE. Every query these call is filtered or pre-aggregated and returns
 * inside the pool's 5 s statement timeout — except operator-grain disposition,
 * which runs on the documented slow path. See `docs/plans/scout-tiger-wiring.md`
 * §5.
 */

/** Uniform "the mirror isn't wired up here" answer, rather than a throw. */
const NOT_CONFIGURED = {
  ok: false as const,
  error:
    "The Texas RRC mirror is not configured in this environment (RRC_DATABASE_URL is unset). Tell the user the public-records lookup is unavailable here; the company's own data tools still work.",
};

/**
 * Every tool opens with this. Returns null when the caller may proceed.
 *
 * Signed in, and nothing more. These read Texas public record over a
 * service-role connection that bypasses RLS, so the check protects the
 * CREDENTIAL — an ungated tool is a scraping endpoint — not any row. There is
 * nothing here to hide from one signed-in member versus another.
 */
async function guard(): Promise<typeof NOT_CONFIGURED | null> {
  await assertSignedIn();
  return hasRrcDb() ? null : NOT_CONFIGURED;
}

/** Last `n` entries, plus an explicit note when earlier ones were dropped. */
function tail<T>(rows: T[], n: number): { rows: T[]; truncated: boolean } {
  return rows.length <= n
    ? { rows, truncated: false }
    : { rows: rows.slice(-n), truncated: true };
}

function head<T>(rows: T[], n: number): { rows: T[]; truncated: boolean } {
  return rows.length <= n
    ? { rows, truncated: false }
    : { rows: rows.slice(0, n), truncated: true };
}

/** Lifetime totals over a lease/operator monthly series. */
function totals(months: LeaseMonth[]) {
  return months.reduce(
    (acc, m) => ({
      oil: acc.oil + (m.oil_prod_vol ?? 0),
      gas: acc.gas + (m.gas_prod_vol ?? 0),
      cond: acc.cond + (m.cond_prod_vol ?? 0),
      csgd: acc.csgd + (m.csgd_prod_vol ?? 0),
    }),
    { oil: 0, gas: 0, cond: 0, csgd: 0 }
  );
}

/** The 20 measures on a LeaseMonth are noise in a chat answer; these five aren't. */
function slimMonth(m: LeaseMonth) {
  return {
    cycle: m.cycle,
    oil: m.oil_prod_vol ?? 0,
    gas: m.gas_prod_vol ?? 0,
    cond: m.cond_prod_vol ?? 0,
    csgd: m.csgd_prod_vol ?? 0,
    reported: m.reported,
  };
}

const WEIGHTED_BASIS =
  "These are THIS WELL's months, not the lease's: each lease-month is split among the wells on the record by the W-10 test in effect that month, with oil and gas weighted SEPARATELY, wells excluded before they were completed or after they were shut in, and untested wells taking a head-count share of what the tested ones did not account for. Note the weighting comes from W-10 tests on OIL records only: a gas record carries one well on average and is not split, so a gas lease's months are that well's whole record rather than a share of it. It is the same split the Scout map and the well's own page show, so the numbers must agree. Still an ESTIMATE and must be said as one: Texas files oil per LEASE and there is no measured per-well volume. allocation.oilShare and allocation.gasShare are that month's fractions read back out of these volumes; evenSplitShare is the flat 1 / (wells on schedule), which is the fallback only where no test exists. A hole filed on both an oil lease and its own gas id draws gas from a record the lease series does not carry, so its gasShare can read above 1; quote the VOLUMES, and treat the share as the cross-check.";

const EVEN_BASIS =
  "These are LEASE totals, not this well's: the hole is on no current schedule, so there is no well test to weight it by and no per-well series to give. Multiply by allocation.evenSplitShare, which is the flat 1 / (wells on schedule for the lease), and say out loud that it is an even-split estimate rather than a measured figure.";

/**
 * A well's slice of what its lease filed, weighted by well test where the
 * filed tests allow it.
 *
 * `productionByTest` is ALREADY allocated: every month scaled by the test in
 * effect that month, liquids and gas weighted separately, summed over every
 * record the hole sits on. It is what the Scout map hover and the well's own
 * page read, so returning it here is what stops the tool and the map quoting
 * two different numbers for the same well in the same session.
 *
 * The share is derived back OUT of these two series rather than recomputed, so
 * the fraction quoted and the volumes quoted are one piece of arithmetic and
 * cannot drift apart.
 *
 * Empty for a hole on no current schedule, which is the normal state of a
 * plugged or historic wellbore. There is nothing to weight by then, so the
 * months stay at lease grain and the flat 1/N is the only estimate on offer.
 */
function allocatedProduction(w: WellDossier, months: number) {
  const weighted = w.productionByTest.length > 0;
  const series = weighted ? w.productionByTest : w.production;
  const t = tail(series.map(slimMonth), months);

  // The newest month both series report with volume in it: the one a person
  // quotes. A month the lease filed as zero yields no ratio, so it is skipped
  // rather than reported as a zero share.
  const lease = new Map(w.production.map((m) => [m.cycle, m]));
  const at = weighted
    ? [...w.productionByTest].reverse().find((m) => {
        const l = m.reported ? lease.get(m.cycle) : undefined;
        return l ? streamOf(l, OIL_KEYS) > 0 || streamOf(l, GAS_KEYS) > 0 : false;
      })
    : undefined;
  const shareAt = at ? lease.get(at.cycle) : undefined;
  const share = (keys: typeof OIL_KEYS | typeof GAS_KEYS) => {
    if (!at || !shareAt) return null;
    const denom = streamOf(shareAt, keys);
    return denom > 0 ? Math.round((streamOf(at, keys) / denom) * 1e4) / 1e4 : null;
  };

  return {
    months: t.rows,
    truncated: t.truncated,
    lifetime: totals(series),
    /** "well" once the months are this hole's share; "lease" when they are not. */
    grain: weighted ? "well" : "lease",
    allocation: {
      method: weighted ? "well-test" : "even-split",
      /** Whether this hole has a test of its own, or took the untested residual. */
      thisWellTested: w.w10.length > 0 || w.g10.length > 0,
      /** The month oilShare / gasShare were read off, "YYYY-MM". */
      asOfCycle: at?.cycle ?? null,
      oilShare: share(OIL_KEYS),
      gasShare: share(GAS_KEYS),
      /** The flat 1 / (wells on schedule). Fallback only, never the answer
       *  when a test exists. */
      evenSplitShare: w.allocationShare,
    },
    basis: weighted ? WEIGHTED_BASIS : EVEN_BASIS,
  };
}

/**
 * Collapse a 25-code x N-month disposition matrix to per-code totals.
 *
 * Codes are RRC's raw two-digit values (00 = stock, 01 = sold to a purchaser,
 * and so on). The mirror carries no label table, so they are passed through
 * unlabelled rather than guessed at.
 */
function dispositionTotals(
  d: Record<DispositionStream, DispositionMonth[]>,
  fromCycle?: string
) {
  const out: Record<string, Record<string, number>> = {};
  for (const stream of Object.keys(d) as DispositionStream[]) {
    const codes: Record<string, number> = {};
    for (const month of d[stream]) {
      if (fromCycle && month.cycle < fromCycle) continue;
      for (const [code, v] of Object.entries(month.codes)) {
        if (v) codes[code] = (codes[code] ?? 0) + v;
      }
    }
    if (Object.keys(codes).length > 0) out[stream] = codes;
  }
  return out;
}

/** Standing caveats every production answer off this mirror needs. */
async function vintage() {
  const { reported, loaded } = await getCycleEdge();
  return {
    lastReportedCycle: reported,
    lastLoadedCycle: loaded,
    // A different clock again: a county roll is a January-1 valuation for one
    // tax year, and only the listed counties have one loaded.
    mineralRolls: cadCoverageList().map((c) => ({
      county_no: c.countyNo,
      county: c.name,
      taxYear: c.taxYear,
    })),
    note:
      reported === loaded
        ? "Current through the last loaded cycle."
        : `RRC has published through ${reported}; cycles after that exist in the mirror as zeros because operators have not filed yet. They are UNREPORTED, not zero — never describe them as a production decline.`,
  };
}

/**
 * A stored link, rendered so Orion can say how much to trust it.
 *
 * `matchMethod` and `confirmedBy` are not decoration: an `api_exact` link with
 * no confirming user resolved itself off an exact API match, while an
 * `operator_lease_name` link is a person's judgement about a fuzzy name.
 */

/**
 * A well's UIC record, small enough to read aloud.
 *
 * The whole permit list and a 40-year monthly series are noise in a chat
 * answer; what a person asking about a disposal well wants is what it is
 * allowed to take, what it is taking, and whether there is room left.
 */
function slimInjection(inj: WellInjection) {
  const live = inj.permits.filter((p) => p.live);
  const p = live[0] ?? inj.permits[0] ?? null;
  return {
    isInjectionWell: live.length > 0,
    permits: inj.permits.length,
    livePermits: live.length,
    injectionType: p ? injTypeLabel(p.inj_type, p.approved_date) : null,
    isDisposal: p ? isDisposal(p.inj_type) : null,
    isCommercial: live.some((x) => x.is_commercial),
    permittedBblPerDay: inj.permittedBblPerDay,
    reportedBblPerDay: inj.recentBblPerDay,
    utilisation:
      inj.recentBblPerDay != null && inj.permittedBblPerDay
        ? Math.round((inj.recentBblPerDay / inj.permittedBblPerDay) * 100) / 100
        : null,
    permittedInterval:
      p?.top_inj_zone && p.bot_inj_zone
        ? { topFt: p.top_inj_zone, bottomFt: p.bot_inj_zone }
        : null,
    maxPressurePsig: p?.max_inj_pressure ?? null,
    fluids: p?.fluids ?? [],
    reportedThrough: inj.reportedThrough,
    basis:
      "Permitted volume is the AUTHORISED daily ceiling from the UIC permit; reported volume is the operator's own H-10 filings, averaged over the days in the months they actually filed. H-10 runs about a YEAR behind — far further than the ~3-month production lag — so never read a thin recent tail as a well that stopped.",
  };
}

/**
 * How many filings come back in full.
 *
 * Not a trim: a recompleted hole has a handful of filings and the whole point
 * of the list is that the earlier ones survive. The cap bounds a pathological
 * record, and `filingsTruncated` says when it bit, because a silent cut reads
 * as "that is all there is".
 */
const MAX_FILINGS = 12;

/** One filing, with the strings and perforations that belong to IT. */
function slimFiling(f: WellboreFiling) {
  return {
    fileDate: f.file_date,
    completionDate: f.completion_date,
    plugBackFt: f.plug_back_ft,
    /*
     * The DATUM every depth on this filing is measured from, and the code
     * saying what it is (KB kelly bushing, GL ground level, DF derrick floor).
     * Measured depth to true vertical, subsea conversion and structural dip all
     * start here, so a depth without it converts to nothing. Null is "not
     * recorded", never zero: a zero elevation is sea level.
     */
    kbElevationFt: f.elevation,
    elevationCode: f.elevation_code,
    perforations: f.perforations.map((p) => ({
      topFt: p.top_ft,
      bottomFt: p.bottom_ft,
      openHole: p.open_hole,
    })),
    casing: f.casing.map((x) => ({
      size: casingLabel(x.size_in),
      weightLbFt: x.weight_lb_ft,
      setFt: x.depth_set,
    })),
  };
}

/**
 * How the hole was built, small enough to read aloud.
 *
 * EVERY filing, newest first, each carrying its own casing and perforations. A
 * recompleted hole's earlier filings are the whole of the correlation and
 * re-entry question, so collapsing them to a count threw away the answer.
 * `latestFiling` still points at the newest, for callers that only want that.
 */
function slimConstruction(c: WellConstruction) {
  const newest = c.filings.find(
    (f) => f.casing.length > 0 || f.perforations.length > 0
  );
  const history = head(c.filings, MAX_FILINGS);
  return {
    filings: c.filings.length,
    /** Total depth of the hole from the wellbore root, feet. */
    totalDepthFt: c.total_depth,
    completedInterval:
      c.shallowest_perf != null && c.deepest_perf != null
        ? { topFt: c.shallowest_perf, bottomFt: c.deepest_perf }
        : null,
    openHole: c.has_open_hole,
    latestFiling: newest ? slimFiling(newest) : null,
    filingHistory: history.rows.map(slimFiling),
    filingsTruncated: history.truncated,
    basis:
      "From the RRC Well Bore Database, grouped by the FILING each string was reported on — a recompleted well has several sets and they must not be merged. A null depth is not recorded, never zero. Note the well's stated depth is the API-assignment depth: 17% of perforations statewide sit below it, so a deeper perforation is not a contradiction. filingHistory is every filing on the hole, newest first; kbElevationFt is the datum that filing's own depths are measured from (elevationCode says which datum: KB, GL or DF) and totalDepthFt is the depth of the hole itself, so a depth quoted subsea or as true vertical must use the elevation from the SAME filing it came off.",
  };
}

/** The H-15 story for one hole: the last test, and whether it is a problem. */
function slimPlugging(jobs: PluggingJob[]) {
  if (!jobs.length) return null;
  const j = jobs[0];
  return {
    jobs: jobs.length,
    pluggedOn: j.plug_date,
    // The orphaned-well marker. If this is true the operator walked away and
    // the Commission paid to plug it, which is a fact about the OPERATOR, not
    // just the well -- say so when it comes up.
    stateFunded: j.state_funded,
    wellType: j.well_type,
    totalDepthFt: j.total_depth,
    freshWaterDepthFt: j.fresh_water_depth,
    cementPlugs: j.plugs,
    cementSacks: j.cement_sacks,
    cementer: j.cement_comp,
    // Every job, because a hole plugged back and re-entered has more than one
    // and the earlier one is what a re-entry candidate is judged on.
    history: jobs.map((x) => ({
      date: x.plug_date,
      plugs: x.plugs,
      sacks: x.cement_sacks,
      stateFunded: x.state_funded,
    })),
  };
}

function slimG10(tests: G10Test[]) {
  const latest = tests[0];
  if (!latest) return null;
  return {
    filings: tests.length,
    lastTest: latest.test_date,
    // Deliverability is what the well DID make on test day; potential is the
    // most it could. Potential is only required where the field rules say so,
    // which is why it is usually absent -- absent means "not required", never
    // "makes nothing", and the model must not read it as a dead well.
    deliverabilityMcfd: latest.daily_gas,
    openFlowPotentialMcfd: latest.potential || null,
    condensateBpd: latest.daily_cond,
    waterBpd: latest.daily_water,
    shutInWellheadPsi: latest.siwh_press,
    flowingPsi: latest.flow_press,
    gasGravity: latest.gas_gravity,
    gasLiquidRatio: latest.gas_liquid_ratio,
    shutIn: latest.shut_in_flag === "Y",
    shutInSince: latest.shut_in_date,
    lateFiling: latest.late_test === "Y",
    // The decline a person actually reasons with: deliverability falling test
    // over test is the well weakening, and these are years apart by design.
    deliverabilityHistory: tests
      .filter((t) => t.test_date && t.daily_gas != null)
      .slice(0, 8)
      .map((t) => ({ date: t.test_date, mcfd: t.daily_gas })),
  };
}

function slimH15(tests: H15Test[]) {
  const latest = tests[0];
  if (!latest) return null;
  return {
    filings: tests.length,
    lastTest: latest.test_date,
    status: H15_STATUS[latest.status ?? ""] ?? latest.status,
    testType: H15_TEST_TYPE[latest.test_type ?? ""] ?? null,
    method: h15Method(latest.test_type, latest.fluid_method, latest.mech_method),
    topOfFluidFt: latest.top_of_fluid,
    nextTestDue: latest.next_test_due,
    // The series a person actually reasons with: a fluid level climbing
    // toward the surface across tests is the well filling up.
    fluidLevelHistory: tests
      .filter((t) => t.test_date && t.top_of_fluid != null)
      .slice(0, 8)
      .map((t) => ({ date: t.test_date, topOfFluidFt: t.top_of_fluid })),
  };
}

/**
 * A lease's P-4, small enough to read aloud: who takes the product now, and the
 * handful of filings that changed it.
 */
function slimP4(p4: LeaseP4) {
  return {
    takenBy: p4.connections.map((c) => ({
      product: P4_PRODUCT[c.product_code ?? ""] ?? c.product_code,
      role: P4_ROLE[c.type_code ?? ""] ?? c.type_code,
      company: c.operator_name,
      operator_no: c.gpn_no,
      share: c.actual_percent,
      since: c.effective_date,
    })),
    changes: p4.filings.slice(0, 20).map((f) => ({
      effective: f.effective_date,
      changed: f.changes,
      operatorOnFiling: f.operator_name,
    })),
    changeCount: p4.filings.length,
    basis:
      "A P-4 is the transportation authority: who may MOVE each product off the lease, not who owns it and not the price. A new one is filed when the purchaser or the operator changes, so this history is often the first public sign of a lease trading hands — it moves before the schedule does. Filings that changed nothing named, and the RRC's own initialisation rows, are excluded.",
  };
}

/**
 * WHICH SCOUT MAP IS ON SCREEN, if any — read back out of the page context.
 *
 * `scout_set_view` drives a map that lives in the browser, and the tool runs on
 * the server, so it has exactly one honest way to know whether there is a map
 * to drive: the page context the chat sends with every turn. `scout-map.tsx`
 * publishes `Scout map (<mode> mode)` as its viewport slice's label for as long
 * as the map is mounted, and the route appends that block to the user's turn
 * (see `app/api/chat/route.ts`), which is what the tool is handed here.
 *
 * No slice means no map. Saying so is the whole point: an agent that reports it
 * has filtered a map the user is not looking at is worse than one that cannot
 * touch the map at all.
 */
function scoutMapOnScreen(messages: readonly ModelMessage[]): MapMode | null {
  let found: MapMode | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n");
    // Last one wins: the newest user turn describes the screen as it is now.
    for (const m of text.matchAll(/Scout map \((wells|permits|operators) mode\)/g)) {
      found = m[1] as MapMode;
    }
  }
  return found;
}

/** Said on every linked answer, because two sources are two measurements. */
const TWO_SOURCES =
  "An RRC figure and a Wildcat figure for the same month are two INDEPENDENT measurements, not one number with a discrepancy: the RRC's is a monthly lease-level filing that runs ~3 months behind and is missing on 18% of lease-months, ours is metered daily. Say which source each number came from; never reconcile them silently.";

export function rrcTools() {
  return {
    // ------------------------------------------------------------ resolvers
    rrc_search: tool({
      description:
        "Search the PUBLIC Texas Railroad Commission record (all of Texas — not this company's own wells) for an operator, lease, field, well or PERSON by name, and the county mineral rolls for a MINERAL OWNER (royalty, working or overriding interest holder; Archer County only today). START HERE: every other rrc_* tool needs a key, and this is what turns a name someone said out loud into one. Returns the operator number, the lease key (oil_gas_code/district/lease_no), the field number, the API number, or the P-5 officer name to pass on. A person's name is matched loosely, so a middle name, reversed order or a misspelling still finds them. Use it whenever a question is about someone else's wells, a competitor, a named individual, an operator you don't recognise, a permit, or Texas production generally.",
      inputSchema: z.object({
        query: z.string().describe("name or partial name, at least 2 characters"),
        kind: z
          .enum(["all", "operator", "lease", "field", "well", "person", "owner"])
          .optional()
          .describe("narrow the search; defaults to all six"),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async ({ query, kind, limit }) => {
        const denied = await guard();
        if (denied) return denied;
        const cap = limit ?? 8;
        /*
         * People are searched HERE rather than left to a separate tool the model
         * has to know to reach for.
         *
         * A user asked what a named person was doing in a county and got
         * nothing. The gather stage's first rule is "rrc_search first, for every
         * name the question mentions", so a person's name arrived here, and this
         * searched operators, leases, fields and wells. A person is none of
         * those: people do not hold wellbores, operating companies do, and a
         * person reaches them only through the P-5 officer file. Fixing the
         * instinct is better than writing an exception to it into the prompt.
         */
        const wantPerson = !kind || kind === "all" || kind === "person";
        // Owners the same way, and for the same reason: a royalty owner is
        // not an operator and not an officer, and a name someone says out
        // loud may be any of the three.
        const wantOwner = !kind || kind === "all" || kind === "owner";
        const [hits, people, owners] = await Promise.all([
          kind === "person" || kind === "owner" ? [] : search(query, cap),
          wantPerson ? resolveOfficerNames(query, Math.min(cap, 5)) : [],
          // A mirror without a roll loaded (the `cad` schema absent) must
          // not take the whole search down: owners are one kind of five.
          wantOwner ? searchOwners(query, Math.min(cap, 5)).catch(() => []) : [],
        ]);
        const filtered =
          !kind || kind === "all" ? hits : hits.filter((h) => h.kind === kind);
        return {
          hits: [
            ...filtered,
            ...people.map((p) => ({
              kind: "person" as const,
              // The name AS THE FILE SPELLS IT. That string is the key, and it
              // is not necessarily the one that was searched for.
              key: p.officer_name,
              label: p.officer_name,
              sub: `${p.operator_count} operator${p.operator_count === 1 ? "" : "s"}, matched by ${p.matched}`,
            })),
            ...owners.map((o) => ({
              kind: "owner" as const,
              key: `${o.county_no}/${o.tax_year}/${o.owner_id}`,
              label: o.name,
              sub: `mineral owner, ${o.lease_count} lease${o.lease_count === 1 ? "" : "s"}, appraised $${o.value_appraised.toLocaleString("en-US")}, ${cadCoverage(o.county_no)?.name ?? o.county_no} County ${o.tax_year} roll`,
            })),
          ],
          keyHint:
            "operator -> rrc_operator(operator_no=key); well -> rrc_well(api=key); lease -> rrc_lease, splitting key on '/' into oil_gas_code/district_no/lease_no; field -> rrc_field(field_no=key); person -> rrc_analyze({ fn: 'rrc_person_search', args: { name: key } }), which returns every operator they are filed on and can be narrowed to one county; owner -> rrc_mineral_owner, splitting key on '/' into county_no/tax_year/owner_id.",
        };
      },
    }),

    rrc_data_vintage: tool({
      description:
        "How current the Texas RRC public-records mirror is: the last cycle the RRC has actually published, and the last cycle loaded. Call this before saying anything about a recent trend in RRC data. The RRC runs roughly three months behind, and those unfiled months sit in the data as zeros — reading them as a collapse in production is the single easiest mistake to make with this dataset.",
      inputSchema: z.object({}),
      execute: async () => {
        const denied = await guard();
        if (denied) return denied;
        return vintage();
      },
    }),

    // ------------------------------------------------------- our wells <-> RRC
    get_well_rrc_record: tool({
      description:
        "The state of Texas's own record for one of THIS COMPANY'S wells, found by our well id — no API number or search needed. Use it whenever a question puts our well and the public record in the same sentence: 'is our Repass #2 in compliance', 'what has the state got on file for this well', 'how does our production compare to what we filed'. The connection is the API number stored on the well; the manifest marks which wells have one (rrc: true). A well without one says so rather than guessing. Never quote an RRC figure as our production, or ours as theirs — say which source each number came from.",
      inputSchema: z.object({
        well_id: z.string().describe("our well id, from the manifest"),
        months: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("recent months of RRC lease production (default 24)"),
      }),
      execute: async ({ well_id, months }) => {
        const denied = await guard();
        if (denied) return denied;

        const w = await getRrcWell(well_id);
        if (!w) {
          return {
            linked: false,
            wellId: well_id,
            note:
              "This well has no API number on file, so there is nothing to look it up by. A person adds it on the well's Info panel, where the app offers matching RRC records to confirm. Do NOT guess a lease number and call rrc_lease instead; that is how another operator's record gets attributed to us.",
          };
        }

        return {
          linked: true,
          wellId: well_id,
          api_number: w.api_number,
          onSchedule: w.current,
          header: w.header,
          status: w.status,
          compliance: w.compliance
            ? {
                flagged14b2: w.compliance.wb_14b2_flag === "Y",
                reasons: Object.entries(w.compliance.flags)
                  .filter(([, v]) => v)
                  .map(([k]) => k),
                surfaceEquipmentViolation: w.compliance.surf_eqp_viol,
                w3xViolation: w.compliance.w3x_viol,
              }
            : null,
          filings: w.filings,
          production: allocatedProduction(w, months ?? 24),
          caveat: w.current
            ? null
            : "This is a HISTORIC wellbore row. Production history is real; status, compliance and 14(b)(2) flags are blank on those rows and must not be reported as 'clean'.",
          twoSources: TWO_SOURCES,
          vintage: await vintage(),
        };
      },
    }),

    get_lease_rrc_record: tool({
      description:
        "The state of Texas's own record for one of THIS COMPANY'S leases, found by our lease id. This is the RIGHT grain for comparing filed production to ours: Texas accounts oil at the lease level, so a per-well RRC oil figure is always an allocation, while the lease figure is what was actually filed. The lease is resolved through its WELLS — whichever of them carry an API number — so a lease with no API numbers on any well says so.",
      inputSchema: z.object({
        lease_id: z.string().describe("our lease id (uuid)"),
        months: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("recent months of filed production (default 24)"),
      }),
      execute: async ({ lease_id, months }) => {
        const denied = await guard();
        if (denied) return denied;

        const d = await getRrcLease(lease_id);
        if (!d) {
          return {
            linked: false,
            leaseId: lease_id,
            note:
              "No well on this lease carries an API number, so the state's lease record cannot be reached. Adding one on any of its wells resolves the whole lease. Say so rather than searching for a lease that looks similar.",
          };
        }

        const t = tail(d.monthly.map(slimMonth), months ?? 24);
        return {
          linked: true,
          leaseId: lease_id,
          key: `${d.oil_gas_code}/${d.district_no}/${d.lease_no}`,
          lease_name: d.lease_name,
          operator: { number: d.operator_no, name: d.operator_name },
          field: { number: d.field_no, name: d.field_name, type: d.field_type },
          district: d.district_name ?? d.district_no,
          offSchedule: d.off_schedule,
          severance: d.severance,
          counties: d.counties,
          wellCount: d.wells.length,
          production: {
            months: t.rows,
            truncated: t.truncated,
            lifetime: totals(d.monthly),
          },
          twoSources: TWO_SOURCES,
          vintage: await vintage(),
        };
      },
    }),

    // -------------------------------------------------------------- records
    rrc_well: tool({
      description:
        "Everything the state of Texas holds on one wellbore, by API number (8 digits, county + unique). Header (lease, operator, field, county, district), current status and well type, plugging and shut-in dates, Statewide Rule 14(b)(2) compliance flags, W-2/G-1/W-3 filing dates, surface and bottomhole coordinates, the lease's production history, how the hole was BUILT (perforated intervals, casing strings, recompletion history), its H-15 inactive-well test record, and — when the hole injects — its UIC permit, permitted barrels per day and reported H-10 volumes. NOTE the oil: Texas reports oil per LEASE, never per well, so a well's volume is always an allocation estimate. `production.allocation.method` says how it was split, 'well-test' when the filed W-10 / G-10 tests weighted it (oil and gas take different shares) and 'even-split' when nothing could, and you must label the figure as allocated either way. For this company's OWN wells use get_well and get_production instead; this tool is the public record.",
      inputSchema: z.object({
        api: z.string().describe("8-digit API number, e.g. 11533824"),
        months: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("how many recent months of lease production to return (default 24)"),
      }),
      execute: async ({ api, months }) => {
        const denied = await guard();
        if (denied) return denied;
        const w = await getWellDossier(api.trim());
        if (!w) return { found: false, api };

        const flags = w.compliance
          ? Object.entries(w.compliance.flags)
              .filter(([, v]) => v)
              .map(([k]) => k)
          : [];
        return {
          found: true,
          api_number: w.api_number,
          onSchedule: w.current,
          header: w.header,
          status: w.status,
          location: w.location,
          compliance: w.compliance
            ? {
                flagged14b2: w.compliance.wb_14b2_flag === "Y",
                reasons: flags,
                surfaceEquipmentViolation: w.compliance.surf_eqp_viol,
                w3xViolation: w.compliance.w3x_viol,
              }
            : null,
          filings: w.filings,
          leaseAssignments: w.completions.length,
          injection: w.injection ? slimInjection(w.injection) : null,
          construction: w.construction ? slimConstruction(w.construction) : null,
          h15: slimH15(w.h15),
          g10: slimG10(w.g10),
          plugging: slimPlugging(w.plugging),
          production: allocatedProduction(w, months ?? 24),
          vintage: await vintage(),
        };
      },
    }),

    rrc_lease: tool({
      description:
        "A Texas lease's public record: name, operator, field, which counties it sits in, the wells on it, its reported production, and WHO TAKES ITS PRODUCT — the P-4 gatherer and purchaser, plus the dated history of every time either changed. Keyed on oil_gas_code + district_no + lease_no — take all three from rrc_search rather than assembling them yourself. IMPORTANT: district_no here is the RRC's INTERNAL code, which is not the district number an operator says out loud (internal 13 is District 09); the result carries district_name, and that is the one to use when you speak. Use granularity 'yearly' for anything spanning more than a couple of years.",
      inputSchema: z.object({
        oil_gas_code: z.enum(["O", "G"]).describe("O for an oil lease, G for gas"),
        district_no: z
          .string()
          .describe("the internal district code from rrc_search, e.g. '13'"),
        lease_no: z.string().describe("lease number, zero-padded exactly as returned"),
        granularity: z.enum(["monthly", "yearly"]).optional(),
        months: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("recent months to return when granularity is monthly (default 24)"),
      }),
      execute: async ({ oil_gas_code, district_no, lease_no, granularity, months }) => {
        const denied = await guard();
        if (denied) return denied;
        const l = await getLeaseDossier(oil_gas_code, district_no, lease_no);
        if (!l) return { found: false, key: `${oil_gas_code}/${district_no}/${lease_no}` };

        const wells = head(l.wells, 50);
        const production =
          granularity === "yearly"
            ? {
                years: await getLeaseYearly(oil_gas_code, district_no, lease_no),
                truncated: false,
              }
            : (() => {
                const t = tail(l.monthly.map(slimMonth), months ?? 24);
                return { months: t.rows, truncated: t.truncated };
              })();

        return {
          found: true,
          key: `${oil_gas_code}/${district_no}/${lease_no}`,
          lease_name: l.lease_name,
          operator: { number: l.operator_no, name: l.operator_name },
          field: { number: l.field_no, name: l.field_name, type: l.field_type },
          district_internal: l.district_no,
          district: l.district_name,
          offSchedule: l.off_schedule,
          severance: l.severance,
          counties: l.counties,
          purchaser: slimP4(l.p4),
          wells: wells.rows,
          wellCount: l.wells.length,
          wellsTruncated: wells.truncated,
          production: { ...production, lifetime: totals(l.monthly) },
          dispositionHint:
            "Where the product went is a separate lookup: rrc_disposition(grain='lease').",
          vintage: await vintage(),
        };
      },
    }),

    rrc_operator: tool({
      description:
        "An operator's public P-5 record and footprint: organisation status, address and phone, listed officers, their whole well fleet broken down by well type, plugged and 14(b)(2)-flagged counts with the reasons, their most productive leases and fields over the last year, their monthly production history, their live salt-water disposal capacity, and their H-15 inactive-well test standing. This is the tool for 'who is this operator', 'are they in good standing', 'how big are they', or sizing up a counterparty. Operator numbers come from rrc_search.",
      inputSchema: z.object({
        operator_no: z.string().describe("6-digit RRC operator number, e.g. 082999"),
        months: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("recent months of production to return (default 24)"),
        top: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("how many leases and fields to list (default 15)"),
      }),
      execute: async ({ operator_no, months, top }) => {
        const denied = await guard();
        if (denied) return denied;
        const o = await getOperatorDossier(operator_no.trim());
        if (!o) return { found: false, operator_no };

        const n = top ?? 15;
        const leases = head(o.leases, n);
        const fields = head(o.fields, n);
        const prod = tail(o.monthly.map(slimMonth), months ?? 24);

        return {
          found: true,
          record: o.record,
          officers: o.officers,
          wells: {
            total: o.wells.total,
            byType: o.wells.byType,
            plugged: o.wells.plugged,
            flagged14b2: o.wells.flagged14b2,
            flagReasons: o.wells.reasons,
            surfaceViolations: o.wells.surfaceViolations,
            w3xViolations: o.wells.w3xViolations,
            note: "Counts cover wells currently ON SCHEDULE to this operator.",
          },
          h15: {
            wellsTested: o.h15.wellsTested,
            delinquent: o.h15.delinquent,
            dueWithin90Days: o.h15.dueSoon,
            lastTest: o.h15.lastTest,
            note:
              o.h15.wellsTested === 0
                ? "No H-15 filings on file for this operator."
                : "Counted per WELL by its most recent filing, not per filing: a well delinquent in 2019 and current since is not a liability today. A pile of delinquent H-15s is the classic sign of an operator short of cash or attention — it is a counterparty risk flag and a plugging-liability estimate at once.",
          },
          disposal: {
            wells: o.disposal.wells,
            commercialWells: o.disposal.commercialWells,
            permittedBblPerDay: o.disposal.permittedBblPerDay,
            injectedBbl12m: o.disposal.injectedBbl12m,
            reportedThrough: o.disposal.reportedThrough,
            note:
              o.disposal.wells === 0
                ? "This operator holds no live salt-water disposal permits."
                : "Live UIC disposal permits only (types 1 and 2). Enhanced-recovery injection is excluded: that water goes back into a producing zone, not away. The injected total covers the twelve months to reportedThrough, because H-10 filing runs about a year behind.",
          },
          topLeases: leases.rows.map((l) => ({
            key: `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`,
            name: l.lease_name,
            field: l.field_name,
            district: l.district_no,
            oil_last12: l.oil_last12,
            gas_last12: l.gas_last12,
            offSchedule: l.off_schedule,
            severance: l.severance,
          })),
          topLeasesTruncated: leases.truncated,
          topFields: fields.rows,
          topFieldsTruncated: fields.truncated,
          production: {
            months: prod.rows,
            truncated: prod.truncated,
            lifetime: totals(o.monthly),
          },
          more: "rrc_operator_network for shared officers; rrc_disposition(grain='operator') for where the product went; rrc_permits for what they are drilling.",
          vintage: await vintage(),
        };
      },
    }),

    rrc_disposition: tool({
      description:
        "Where a lease's or an operator's product actually WENT, by RRC disposition code — sold to a purchaser, stock, lease use, injected, flared, and so on. Answers 'is this gas being sold or flared', 'who takes their oil', 'how much of this is stock movement'. Codes come back as the RRC's raw two-digit values with no label table behind them, so report the code alongside the volume rather than inventing a name for it. The operator grain reads every lease the operator has ever held and is SLOW (up to ~30 s) — only reach for it when the question is genuinely operator-wide.",
      inputSchema: z.object({
        grain: z.enum(["lease", "operator"]),
        operator_no: z.string().optional().describe("required when grain is operator"),
        oil_gas_code: z.enum(["O", "G"]).optional().describe("required when grain is lease"),
        district_no: z.string().optional().describe("required when grain is lease"),
        lease_no: z.string().optional().describe("required when grain is lease"),
        months: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("only total the last N months (default: all history)"),
      }),
      execute: async ({ grain, operator_no, oil_gas_code, district_no, lease_no, months }) => {
        const denied = await guard();
        if (denied) return denied;

        const from = months
          ? (() => {
              const d = new Date();
              d.setUTCMonth(d.getUTCMonth() - months);
              return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
            })()
          : undefined;

        if (grain === "operator") {
          if (!operator_no) return { ok: false, error: "operator_no is required when grain is 'operator'." };
          const d = await getOperatorDisposition(operator_no.trim());
          return { grain, operator_no, since: from ?? "all history", totalsByCode: dispositionTotals(d, from) };
        }

        if (!oil_gas_code || !district_no || !lease_no) {
          return {
            ok: false,
            error: "oil_gas_code, district_no and lease_no are all required when grain is 'lease'.",
          };
        }
        const l = await getLeaseDossier(oil_gas_code, district_no, lease_no);
        if (!l) return { found: false, key: `${oil_gas_code}/${district_no}/${lease_no}` };
        return {
          grain,
          key: `${oil_gas_code}/${district_no}/${lease_no}`,
          lease_name: l.lease_name,
          since: from ?? "all history",
          totalsByCode: dispositionTotals(l.disposition, from),
        };
      },
    }),

    // ------------------------------------------------------------- geography
    rrc_field: tool({
      description:
        "A producing field's public profile: its production history, lifetime volumes, how many leases are in it, and the operators producing the most out of it. Accepts a field number or a field name. Field NAMES are not unique — the RRC issues separate numbers for separate reservoirs that share a name (there are four 'SPRABERRY (TREND AREA)' fields), so when a name matches several this returns the candidates for you to pick from rather than silently choosing one.",
      inputSchema: z.object({
        field: z.string().describe("field number (8 digits) or field name"),
        months: z.number().int().min(1).max(400).optional().describe("default 24"),
      }),
      execute: async ({ field, months }) => {
        const denied = await guard();
        if (denied) return denied;
        const ref = field.trim();
        let fieldNo = ref;
        if (!/^\d{8}$/.test(ref)) {
          const matches = await resolveField(ref);
          if (matches.length === 0) return { found: false, field: ref };
          if (matches.length > 1) {
            return {
              found: false,
              ambiguous: true,
              candidates: matches,
              note: "Several fields carry this name and they are different reservoirs. Ask the user which, or call again with a field number.",
            };
          }
          fieldNo = matches[0].field_no;
        }
        const p = await getFieldProfile(fieldNo, months ?? 24);
        if (!p) return { found: false, field: ref };
        return { found: true, ...p, vintage: await vintage() };
      },
    }),

    rrc_county: tool({
      description:
        "A Texas county's public oil and gas profile: production history and lifetime volumes, how many wells are on schedule there, how many drilling permits were issued in the last year, and the top-producing leases. Takes a county name or an RRC county code. Use it for 'how active is X county', 'who is producing in X', or to size up an area before a deal.",
      inputSchema: z.object({
        county: z.string().describe("county name (e.g. 'Andrews') or RRC code (e.g. '003')"),
        months: z.number().int().min(1).max(400).optional().describe("default 24"),
      }),
      execute: async ({ county, months }) => {
        const denied = await guard();
        if (denied) return denied;
        const p = await getCountyProfile(county, months ?? 24);
        if (!p) {
          return {
            found: false,
            county,
            error: resolveCounty(county)
              ? "No production on record for that county."
              : "Not a Texas county name or RRC county code.",
          };
        }
        return { found: true, ...p, vintage: await vintage() };
      },
    }),

    rrc_wells_near: tool({
      description:
        "Find wells on the public record by WHERE they are: within a radius of a coordinate, or across a county, optionally narrowed to one operator or well type ('PRODUCING', 'INJECTION', 'SHUT IN', 'PLUGGED'). This is the offset-well tool — 'what else is around my lease', 'who else is injecting near here', 'how many producers in this county'. Radius results carry the distance in miles and come back nearest-first. You must give either a coordinate or a county; there is no statewide listing.",
      inputSchema: z.object({
        lat: z.number().optional().describe("decimal degrees, e.g. 32.0"),
        lon: z.number().optional().describe("decimal degrees, negative in Texas, e.g. -102.05"),
        radius_mi: z.number().min(0.1).max(100).optional().describe("default 5"),
        county: z.string().optional().describe("county name or RRC code"),
        operator_no: z.string().optional(),
        well_type: z.string().optional().describe("substring of RRC's well type, e.g. INJECTION"),
        limit: z.number().int().min(1).max(500).optional().describe("default 50"),
      }),
      execute: async ({ lat, lon, radius_mi, county, operator_no, well_type, limit }) => {
        const denied = await guard();
        if (denied) return denied;
        const cap = limit ?? 50;
        const wells = await findWells({
          lat,
          lon,
          radiusMi: radius_mi,
          county,
          operatorNo: operator_no,
          wellType: well_type,
          limit: cap,
        });
        if (wells.length === 0 && lat === undefined && !county && !operator_no) {
          return {
            ok: false,
            error: "Give a coordinate (lat + lon), a county, or an operator — an unfiltered well search is refused.",
          };
        }
        return {
          wells,
          count: wells.length,
          truncated: wells.length === cap,
          note:
            wells.length === cap
              ? `Cut off at ${cap}. There may be more — raise limit or tighten the radius before quoting this as a total.`
              : "Complete for the given filters. Covers wells currently on schedule that have surface coordinates on file.",
        };
      },
    }),

    rrc_survey: tool({
      description:
        "Look up a Texas land survey by abstract number ('A-64'), survey name ('T&P RR CO'), or block. Use it to make sense of a legal description on a lease or permit. CAVEAT worth stating out loud when you use it: the mirror's survey table has no county column, so an abstract number is not unique across Texas — treat a match as a candidate, not an identification.",
      inputSchema: z.object({
        abstract: z.string().optional().describe("abstract number, with or without the 'A-' prefix"),
        name: z.string().optional().describe("survey / grantee name"),
        block: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ abstract, name, block, limit }) => {
        const denied = await guard();
        if (denied) return denied;
        const rows = await findSurveys({ abstract, name, block, limit: limit ?? 25 });
        if (rows.length === 0 && !abstract && !name && !block) {
          return { ok: false, error: "Give an abstract number, a survey name, or a block." };
        }
        return { surveys: rows, count: rows.length };
      },
    }),

    // --------------------------------------------------------------- market
    rrc_market: tool({
      description:
        "Texas production over time from the RRC's own rollups — statewide, or broken out by district. Use it for the big picture: how Texas oil or gas is trending, how one district compares to another, whether the basin is growing. Every point carries a `reported` flag; points where that is false are months operators have not filed yet and MUST NOT be described as a decline. For a ranking rather than a trend, use rrc_leaderboard.",
      inputSchema: z.object({
        scope: z.enum(["statewide", "districts"]).optional().describe("default statewide"),
        months: z.number().int().min(1).max(400).optional().describe("default 60"),
        granularity: z.enum(["monthly", "yearly"]).optional().describe("default monthly"),
      }),
      execute: async ({ scope, months, granularity }) => {
        const denied = await guard();
        if (denied) return denied;
        const series = await getProductionTrend(
          scope ?? "statewide",
          months ?? 60,
          granularity ?? "monthly"
        );
        return {
          scope: scope ?? "statewide",
          granularity: granularity ?? "monthly",
          series,
          units: "oil/cond in barrels, gas/casinghead in MCF",
          vintage: await vintage(),
        };
      },
    }),

    rrc_leaderboard: tool({
      description:
        "Who is biggest in Texas right now: the top operators, fields, counties or leases by production over a trailing window. Answers 'who are the biggest operators in Texas', 'which counties are hottest', 'what are the top-producing leases'. Every row comes back with the key needed to open it — an operator number, a field number, a county code, or a lease key — so you can go straight from a ranking into a dossier without searching again.",
      inputSchema: z.object({
        kind: z.enum(["operators", "fields", "counties", "leases"]),
        months: z.number().int().min(1).max(120).optional().describe("trailing window, default 12"),
        limit: z.number().int().min(1).max(100).optional().describe("default 25"),
      }),
      execute: async ({ kind, months, limit }) => {
        const denied = await guard();
        if (denied) return denied;
        const rows = await getLeaderboard(kind, months ?? 12, limit ?? 25);
        return {
          kind,
          window: `${months ?? 12} months ending ${(await getCycleEdge()).loaded}`,
          rows,
          rankedBy: "oil volume, gas as the tiebreak",
          vintage: await vintage(),
        };
      },
    }),

    // ------------------------------------------------------- mineral rolls
    rrc_lease_minerals: tool({
      description:
        "WHO OWNS THE MINERALS under one Texas lease, from the county appraisal district's mineral roll: every royalty, working and overriding interest the county taxes, with the owner's name, type and mailing city, the decimal interest, and the appraised value. The RRC record never says this; the roll does. Keyed like rrc_lease (oil_gas_code + internal district_no + lease_no from rrc_search) plus the county. Loaded for Archer County (2025 roll) only — outside it the answer is 'not covered', not 'unowned'. Interests are what the county taxes and do NOT sum to one: quote the per-type sums as sums. Appraised value is a county valuation, not a price, and a roll is not a title opinion.",
      inputSchema: z.object({
        oil_gas_code: z.enum(["O", "G"]),
        district_no: z.string().describe("the internal district code from rrc_search, e.g. '13'"),
        lease_no: z.string().describe("lease number, zero-padded exactly as returned"),
        county: z
          .string()
          .optional()
          .describe("county name or RRC code the lease sits in; defaults to the one loaded roll"),
      }),
      execute: async ({ oil_gas_code, district_no, lease_no, county }) => {
        const denied = await guard();
        if (denied) return denied;
        const loaded = cadCoverageList();
        const ref = county
          ? (resolveCounty(county)?.county_no ?? county)
          : loaded.length === 1
            ? loaded[0].countyNo
            : null;
        const cov = cadCoverage(ref);
        if (!cov) {
          return {
            found: false,
            notCovered: true,
            county: county ?? null,
            coverage: cadCoverageSentence(),
          };
        }
        const m = await getLeaseMinerals(oil_gas_code, district_no, lease_no, cov.countyNo);
        if (!m) return { found: false, notCovered: true, coverage: cadCoverageSentence() };
        return {
          found: true,
          key: `${oil_gas_code}/${district_no}/${lease_no}`,
          county: m.county_name,
          taxYear: m.tax_year,
          onRoll: m.interests.length > 0,
          totals: interestTotals(m.interests).map((t) => ({
            type: t.label,
            owners: t.count,
            sumOfInterests: t.sum,
          })),
          appraisedValue: m.value_appraised,
          interests: m.interests.map((i) => ({
            ownerKey: `${m.county_no}/${m.tax_year}/${i.owner_id}`,
            owner: i.owner_name,
            ownerType: i.owner_type,
            type: i.interest_type,
            interest: i.interest,
            appraisedValue: i.value_appraised,
            city: i.owner_city,
            state: i.owner_state,
          })),
          countyRecord: {
            operatorAsFiled: m.cad_operator_name,
            firstCycle: m.cad_first_cycle,
            lastCycle: m.cad_last_cycle,
            note: "The county's own copy of the RRC record, for reconciliation: the operator and production per RRC are in rrc_lease. Where they disagree, the RRC is current and the roll is stale.",
          },
          vintage: await vintage(),
        };
      },
    }),

    rrc_mineral_owner: tool({
      description:
        "One MINERAL OWNER's holdings from a Texas county appraisal roll: who they are, their mailing address, every lease they hold a taxed royalty, working or overriding interest in (with the RRC's lease name and operator, the interest, the appraised value and the lease's last twelve reported months of oil and gas), and the other owners who share those leases. Key comes from rrc_search (kind 'owner'): county_no / tax_year / owner_id. Archer County 2025 roll only. A roll is a valuation, not a title opinion.",
      inputSchema: z.object({
        county_no: z.string().describe("3-digit RRC county code from the search key, e.g. '009'"),
        tax_year: z.number().int().describe("from the search key, e.g. 2025"),
        owner_id: z.string().describe("the roll's owner id from the search key"),
      }),
      execute: async ({ county_no, tax_year, owner_id }) => {
        const denied = await guard();
        if (denied) return denied;
        const o = await getOwner(county_no, tax_year, owner_id);
        if (!o) {
          return {
            found: false,
            key: `${county_no}/${tax_year}/${owner_id}`,
            coverage: cadCoverageSentence(),
          };
        }
        const netOil = o.interests.reduce((s, i) => s + i.interest * i.oil_12mo, 0);
        const netGas = o.interests.reduce((s, i) => s + i.interest * i.gas_12mo, 0);
        const leases = head(o.interests, 60);
        return {
          found: true,
          key: `${o.county_no}/${o.tax_year}/${o.owner_id}`,
          name: o.name,
          ownerType: o.owner_type,
          secondOwner: o.owner2_name,
          address: o.address,
          county: o.county_name,
          taxYear: o.tax_year,
          appraisedValue: o.interests.reduce((s, i) => s + (i.value_appraised ?? 0), 0),
          leaseCount: new Set(o.interests.map((i) => `${i.oil_gas_code}/${i.district_no}/${i.lease_no}`)).size,
          totals: interestTotals(o.interests).map((t) => ({
            type: t.label,
            interests: t.count,
            sumOfInterests: t.sum,
          })),
          netOil12mo: Math.round(netOil),
          netGas12mo: Math.round(netGas),
          reportedThrough: o.reportedThrough,
          interests: leases.rows.map((i) => ({
            leaseKey: `${i.oil_gas_code}/${i.district_no}/${i.lease_no}`,
            lease: i.lease_name,
            district: i.district_name,
            operator: { number: i.operator_no, name: i.operator_name },
            type: i.interest_type,
            interest: i.interest,
            appraisedValue: i.value_appraised,
            oil12mo: i.oil_12mo,
            gas12mo: i.gas_12mo,
            monthsReported: i.months,
          })),
          truncated: leases.truncated,
          coOwners: head(o.coOwners, 25).rows.map((c) => ({
            ownerKey: `${o.county_no}/${o.tax_year}/${c.owner_id}`,
            name: c.name,
            ownerType: c.owner_type,
            sharedLeases: c.shared_leases,
          })),
          note:
            "netOil12mo / netGas12mo are interest x the LEASE's whole reported volume over the twelve months to reportedThrough — a gross share before costs, taxes or the operator's deductions, not income. Volumes are the RRC's; ownership and value are the county's.",
        };
      },
    }),

    rrc_owners_near: tool({
      description:
        "WHO OWNS THE MINERALS around a point in Texas: the owners on the county mineral roll for every lease with an on-schedule well inside the radius, ranked by their share of those leases' last twelve months of oil. This is 'who would we be dealing with', 'who holds royalty around our lease', 'is there a WI partner behind these wells'. Pass a latitude and longitude (or take them from rrc_well's location). Archer County 2025 roll only — a point outside it returns nothing, which means 'no roll loaded here', not 'no owners'.",
      inputSchema: z.object({
        lat: z.number().describe("decimal degrees"),
        lon: z.number().describe("decimal degrees, negative in Texas"),
        radius_mi: z.number().min(0.1).max(50).optional().describe("default 5"),
        limit: z.number().int().min(1).max(100).optional().describe("default 25"),
      }),
      execute: async ({ lat, lon, radius_mi, limit }) => {
        const denied = await guard();
        if (denied) return denied;
        const owners = await findOwnersNear({ lat, lon, radiusMi: radius_mi, limit });
        return {
          count: owners.length,
          radiusMi: radius_mi ?? 5,
          coverage: cadCoverageSentence(),
          owners: owners.map((o) => ({
            ownerKey: `${o.county_no}/${o.tax_year}/${o.owner_id}`,
            name: o.name,
            ownerType: o.owner_type,
            leases: o.lease_count,
            netOil12mo: o.net_oil_12mo,
            netGas12mo: o.net_gas_12mo,
            appraisedValue: o.value_appraised,
          })),
          note:
            owners.length === 0
              ? "No loaded mineral roll covers a lease with an on-schedule well inside this radius."
              : "netOil12mo is interest x each lease's whole reported twelve months, summed over the owner's leases here — a gross share, not income.",
        };
      },
    }),

    // ------------------------------------------------------------- activity
    rrc_permits: tool({
      description:
        "Drilling permits on file with the RRC — who has permission to drill what, where, and how deep, with the filed, issued and expiry dates. This is the leading indicator in the whole dataset: a permit appears months before a well produces, so it is how you answer 'who is drilling near me', 'is anyone active in this county', or 'what is this operator up to'. Filter by operator, county, district, lease name, or issue-date window. Give the district the way a Texan says it ('8A', '09') — the translation to the RRC's internal code is handled for you, and results carry both.",
      inputSchema: z.object({
        operator_no: z.string().optional(),
        county: z.string().optional().describe("county name or RRC code"),
        district: z.string().optional().describe("district as spoken, e.g. '8A' or '09'"),
        lease_name: z.string().optional().describe("substring match"),
        since: z.string().optional().describe("earliest issue date, YYYY-MM-DD"),
        until: z.string().optional().describe("latest issue date, YYYY-MM-DD"),
        limit: z.number().int().min(1).max(500).optional().describe("default 50"),
      }),
      execute: async ({ operator_no, county, district, lease_name, since, until, limit }) => {
        const denied = await guard();
        if (denied) return denied;
        if (!operator_no && !county && !district && !lease_name && !since && !until) {
          return {
            ok: false,
            error:
              "Narrow the search first — by operator, county, district, lease name, or a date window. There are 950,665 permits on file.",
          };
        }
        const cap = limit ?? 50;
        const permits = await listPermits({
          operatorNo: operator_no,
          county,
          district,
          leaseName: lease_name,
          since,
          until,
          limit: cap,
        });
        return {
          permits,
          count: permits.length,
          truncated: permits.length === cap,
          note:
            permits.length === cap
              ? `Cut off at ${cap} — do not quote this as a total. Narrow the window or raise limit.`
              : "Complete for the given filters. Sorted newest issue date first.",
        };
      },
    }),

    rrc_completion: tool({
      description:
        "The completion report (W-2 / G-1) filed for a wellbore: spud and completion dates, wellbore profile, acreage, the legal survey description, and the detail rows — every formation encountered with its depth and whether it was isolated, plus the casing string with sizes, set depths, hole sizes and cement. This is the closest thing to a public frac/completion design for a well, and it is how you compare an offset operator's approach to yours. Keyed on API number. Recompletions file their own report, so a hole can have several; they come back newest first.",
      inputSchema: z.object({
        api: z.string().describe("8-digit API number"),
        limit: z.number().int().min(1).max(20).optional().describe("how many reports (default 3)"),
      }),
      execute: async ({ api, limit }) => {
        const denied = await guard();
        if (denied) return denied;
        const reports = await getCompletionReports(api.trim(), limit ?? 3);
        return {
          api,
          count: reports.length,
          reports,
          note:
            reports.length === 0
              ? "No completion report on file for that API. Older wells predate the electronic filing set."
              : "otherSections lists the further W-2 sections filed (tubing, production interval, treatment) that this mirror stores only as counts.",
        };
      },
    }),

    rrc_disposal: tool({
      description:
        "Salt-water disposal wells, with what each is PERMITTED to take (barrels per day) and what it has actually been taking. Two ways to ask, and it answers both: BY PLACE — 'where can we take this water', 'who has disposal capacity near the lease', 'is there a commercial SWD close by' — pass an 8-digit API number (its coordinates are looked up for you) or a latitude and longitude; or BY OWNER — 'does this operator own any disposal', 'what water infrastructure comes with the package', 'how much disposal does our competitor control' — pass their 6-digit operator number from rrc_search. You can pass both to ask what one operator has near a point. Returns only LIVE disposal permits: enhanced-recovery injection wells are excluded, because that water goes back into a producing zone rather than away. Set commercial_only when the water is somebody else's to place — a non-commercial well may only take its own operator's water.",
      inputSchema: z.object({
        api: z
          .string()
          .optional()
          .describe("8-digit API number to search around"),
        lat: z.number().optional().describe("latitude, WGS84"),
        lon: z.number().optional().describe("longitude, WGS84 (negative in Texas)"),
        radius_miles: z.number().min(0.1).max(100).optional().describe("default 25"),
        operator_no: z
          .string()
          .optional()
          .describe("6-digit RRC operator number, to list what they own"),
        commercial_only: z
          .boolean()
          .optional()
          .describe("only wells permitted to accept third-party water"),
        limit: z.number().int().min(1).max(50).optional().describe("default 15"),
      }),
      execute: async ({
        api,
        lat,
        lon,
        radius_miles,
        operator_no,
        commercial_only,
        limit,
      }) => {
        const denied = await guard();
        if (denied) return denied;

        let point = lat != null && lon != null ? { lat, lon } : null;
        if (!point && api) {
          // Resolve the API to a surface location rather than making the model
          // invent coordinates for a well it was just told about.
          const w = await getWellDossier(api.trim());
          if (w?.location.lat != null && w.location.lon != null) {
            point = { lat: w.location.lat, lon: w.location.lon };
          }
        }
        if (!point && !operator_no) {
          return {
            ok: false,
            error:
              "No filter given. Pass an operator number, or a location as lat/lon or an API number the mirror has coordinates for. Do not guess coordinates, and do not ask for the whole state.",
          };
        }

        const radius = radius_miles ?? 25;
        const rows = await findDisposal({
          ...(point ?? {}),
          radiusMi: radius,
          operatorNo: operator_no,
          commercialOnly: commercial_only,
          limit: limit ?? 15,
        });
        const edge = await getInjectionEdge();
        return {
          searchedFrom: point,
          radiusMiles: point ? radius : null,
          operator_no: operator_no ?? null,
          commercialOnly: Boolean(commercial_only),
          count: rows.length,
          wells: rows.map((r) => ({
            uic_no: r.uic_no,
            api_number: r.api_number,
            lease: r.lease_name,
            wellNo: r.well_no,
            operator: r.operator_name,
            operator_no: r.operator_no,
            county: r.county_name,
            distanceMiles: r.distance_mi,
            commercial: r.is_commercial,
            injectionType: injTypeLabel(r.inj_type, null),
            permittedBblPerDay: r.max_bbl_per_day,
            reportedBblPerDay:
              r.recentBblPerDay != null ? Math.round(r.recentBblPerDay) : null,
            utilisation:
              r.utilisation != null ? Math.round(r.utilisation * 100) / 100 : null,
            permittedInterval:
              r.top_inj_zone && r.bot_inj_zone
                ? { topFt: r.top_inj_zone, bottomFt: r.bot_inj_zone }
                : null,
          })),
          reportedThrough: edge.reported,
          caveat:
            "Permitted volume is a legal ceiling, not an offer: whether a well will take your water, and at what price, is a commercial matter the state record says nothing about. `utilisation` is reported volume over permitted volume, and it is measured to " +
            edge.reported +
            " because H-10 filing runs about a year behind. A well with no reported volume may be new, idle, or simply late filing.",
        };
      },
    }),

    rrc_operator_network: tool({
      description:
        "The people behind an operator, and the other Texas operators they also run: the officers listed on the P-5, plus every other operator sharing a named officer, with that operator's P-5 status. Use it to see whether a small operator is one of several entities behind the same people — the usual question before doing business with one, or when a company appears to have walked away from wells under a different name.",
      inputSchema: z.object({
        operator_no: z.string().describe("6-digit RRC operator number"),
      }),
      execute: async ({ operator_no }) => {
        const denied = await guard();
        if (denied) return denied;
        const net = await getOperatorNetwork(operator_no.trim());
        if (!net) return { found: false, operator_no };
        return {
          found: true,
          ...net,
          relatedCount: new Set(net.related.map((r) => r.operator_number)).size,
          caveat:
            "Matched on the officer NAME as filed. Common names can link unrelated companies, so treat a link as a lead to check, not a proven relationship.",
        };
      },
    }),
  };
}

/**
 * The one Scout tool that WRITES — to the screen, not to any database.
 *
 * Registered on its own rather than inside `rrcTools()` because that set has a
 * second consumer: the public-record GATHER stage takes it wholesale
 * (`pipeline/rrc-gather.ts`) and runs unattended, behind the answer. A research
 * stage that can move the user's map would move it while the user is reading
 * something else, and `rrc-gather.test.ts` guards the boundary by name.
 */
export function scoutViewTool() {
  return {
    scout_set_view: tool({
      description:
        "Drive the Scout map the user is looking at: set its filters and move its camera. Use it when the user asks to SEE something on the map (\"show me shut-in wells in Andrews county deeper than 8,000 feet\", \"zoom to this lease\", \"switch to permits\"), rather than describing what they would have to click. The filters you set are ordinary filters: they appear in the filter bar and the user can clear them by hand, so set only what they asked for and never clear a filter they did not mention. It reads nothing and returns nothing about wells; call the rrc_* tools for facts. Works ONLY while a Scout map is on the user's screen. After it succeeds, tell the user in one short line which filters you set.",
      inputSchema: z.object({
        filters: z
          .looseObject({
            mode: z
              .enum(MAP_MODES)
              .optional()
              .describe("which map: wells, permits or operators. Switching mode CLEARS the other filters, exactly as the mode buttons do, so send the whole filter set in the same call"),
            oilGas: z.enum(["all", "O", "G"]).optional().describe("wells mode: O = oil, G = gas"),
            status: z
              .enum(["all", "active", "inactive", "plugged"])
              .optional()
              .describe("wells mode: the activity bucket"),
            district: z
              .union([z.literal("all"), z.number().int().min(1).max(14)])
              .optional()
              .describe("wells mode: RRC district 1-14"),
            county: z
              .union([z.literal("all"), z.string(), z.number().int()])
              .optional()
              .describe("county name (\"Andrews\") or RRC county code"),
            wellType: z
              .enum(WELL_TYPE_VALUES)
              .nullable()
              .optional()
              .describe("wells mode: the RRC well type, e.g. SHUT IN. null for any"),
            minDepth: z.number().nullable().optional().describe("wells mode: total depth in feet"),
            maxDepth: z.number().nullable().optional(),
            minOilRate: z
              .number()
              .nullable()
              .optional()
              .describe(
                "wells mode: the well's own oil in BARRELS PER MONTH, averaged over the last 12 filed months. Allocated from the lease by W-10 test share, not a meter reading. A well with no rate on file fails any minimum above 0"
              ),
            maxOilRate: z.number().nullable().optional(),
            minGasRate: z
              .number()
              .nullable()
              .optional()
              .describe(
                "wells mode: the well's own gas in MCF PER MONTH over the same window. Gas is reported per well by the RRC, so it is not allocated"
              ),
            maxGasRate: z.number().nullable().optional(),
            minCompletionYear: z.number().int().nullable().optional(),
            maxCompletionYear: z.number().int().nullable().optional(),
            permitPurpose: z
              .array(z.string())
              .optional()
              .describe("permits mode: filing purposes to draw, verbatim. [] = all"),
            operator: z
              .object({
                operator_number: z.number().int(),
                operator_name: z.string(),
              })
              .nullable()
              .optional()
              .describe("both fields, from rrc_search: the bar's chip shows the name"),
            person: z.string().nullable().optional().describe("P-5 officer name, as filed"),
            minWells: z.number().int().nullable().optional().describe("operators mode"),
            maxWells: z.number().int().nullable().optional(),
            minOil12: z.number().nullable().optional().describe("operators mode: bbl per month"),
            maxOil12: z.number().nullable().optional(),
            minGas12: z.number().nullable().optional().describe("operators mode: MCF per month"),
            maxGas12: z.number().nullable().optional(),
            minRevenue: z.number().nullable().optional().describe("operators mode: $ per month"),
            maxRevenue: z.number().nullable().optional(),
            excludePlugged: z.boolean().optional(),
            showSurveys: z.boolean().optional(),
            showPipelines: z.boolean().optional(),
          })
          .optional(),
        camera: z
          .object({
            bbox: z
              .object({
                west: z.number(),
                south: z.number(),
                east: z.number(),
                north: z.number(),
              })
              .optional()
              .describe("fly to this extent; must be in Texas"),
            lat: z.number().optional().describe("or centre here"),
            lon: z.number().optional(),
            zoom: z
              .number()
              .optional()
              .describe(`with lat/lon: ${MIN_ZOOM} (statewide) to ${MAX_ZOOM} (one lease)`),
          })
          .optional(),
      }),
      /*
       * Not `guard()`: nothing here touches the mirror, so `hasRrcDb()` is not
       * the right gate — the tile layer and the filter bar work without it. The
       * signed-in check is the one that matters and it is the same one every
       * neighbouring tool opens with.
       */
      execute: async (input, options) => {
        await assertSignedIn();

        /*
         * The Realtime voice loop calls `execute(args)` with no options at all
         * (`runRealtimeTool`), so there is no page context to read and no chat
         * surface to apply the directive when it comes back. Say that, rather
         * than reporting a map that will not move: this tool is typed-chat only
         * until the voice hook dispatches directives too.
         */
        const messages = options?.messages;
        if (!messages || messages.length === 0) {
          return {
            ok: false as const,
            error:
              "Map control is not available in this conversation, only in the typed chat.",
            expected:
              "Answer the question itself from the rrc_* tools, and if the user wants the map moved, say it has to be asked in the typed chat.",
          };
        }

        const mode = scoutMapOnScreen(messages);
        if (!mode) {
          return {
            ok: false as const,
            error:
              "There is no Scout map on this page to drive. This tool moves the map the user is actually looking at, and they are not looking at one.",
            expected:
              "Tell the user to open Scout (the map page) and ask again there. Answer the question itself from the rrc_* tools in the meantime; do not claim anything was filtered.",
          };
        }

        const directive = normalizeScoutView(input, { mode });

        /*
         * ALL OR NOTHING. A directive with one bad key is a directive whose
         * meaning is not understood, and half of it applied is a map the user
         * cannot account for. Refusing the whole call costs one round trip and
         * hands the model the exact reason, which is what it needs to re-issue.
         */
        if (directive.rejected.length > 0) {
          return {
            ok: false as const,
            error: `Nothing was changed. ${directive.rejected.join("; ")}.`,
            expected:
              "Fix the named fields and call again, or tell the user plainly that the map cannot filter on what they asked for. The map was NOT touched.",
          };
        }
        if (directive.applied.length === 0) {
          return {
            ok: false as const,
            error: "That directive set nothing, so the map was left alone.",
            expected: "Pass the filters or the camera you actually want changed.",
          };
        }

        return {
          ok: true as const,
          mapMode: mode,
          directive,
          note:
            "The map has been set. `directive.applied` is what changed: say it back to the user in one short line, because these are ordinary filters they can now see in the bar and clear by hand. The next turn's page context reports how many wells the new filter actually found; do not guess at a count now.",
        };
      },
    }),
  };
}
