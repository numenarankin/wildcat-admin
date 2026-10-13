import "server-only";

import { z } from "zod";

import { rrcQuery } from "@/lib/scout/rrc-db";
import {
  getCycleEdge,
  getInjectionEdge,
  getLeaseDossier,
  getOperatorDossier,
  getWellDossier,
  resolveCounty,
} from "@/lib/scout/rrc-queries";
import type { LeaseMonth } from "@/lib/scout/rrc-types";
import { daysInCycle, monthsBetween, sum } from "../math";
import { defineTool, type RrcTool } from "../tool";

/**
 * Provenance and coverage: how this system says what it cannot see.
 *
 * Every other file in this catalog produces numbers. These four say where a
 * number came from, where the record is thin, and what a screen actually
 * returned, which is the difference between an answer an operator can act on
 * and one they have to take on faith.
 *
 * A system that never says "I cannot see here" gets trusted exactly once.
 *
 * ## Stateless on purpose
 *
 * `rrc_case_file` formats what the caller passes plus fresh reads of the
 * mirror. It writes nothing and remembers nothing between calls. Persisting an
 * investigation is a table, a migration and a tenancy question, and none of
 * those belong in a read-only public-record tool.
 */

function fail(error: string) {
  return { ok: false as const, error };
}

/** `oil_gas_code/district_no/lease_no`, the one lease key a model can type. */
const LEASE_KEY = /^\s*([OGog])\s*\/\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/;

function parseLeaseKey(key: string) {
  const m = LEASE_KEY.exec(key);
  if (!m) return null;
  return { oil_gas_code: m[1].toUpperCase() as "O" | "G", district_no: m[2], lease_no: m[3] };
}

/** What a key IS, decided by its shape, so one target list can mix kinds. */
type TargetKind = "lease" | "well" | "operator" | "unknown";

function classify(key: string): TargetKind {
  const k = key.trim();
  if (parseLeaseKey(k)) return "lease";
  if (/^\d{8,14}$/.test(k)) return "well";
  if (/^\d{6}$/.test(k)) return "operator";
  return "unknown";
}

// ------------------------------------------------------------------ 70

const PROVENANCE = {
  production: {
    table: "rrc.lease_production",
    form: "Form PR (monthly production report), as loaded into the RRC's PDQ lease cycle file",
    grain: "one row per lease per cycle; OIL IS FILED PER LEASE and allocated to wells, never metered per well",
  },
  well_test: {
    table: "rrc.w10_test",
    form: "Form W-10 (oil well status report)",
    grain: "one row per test: a single measured day for one wellbore",
  },
  injection: {
    table: "rrc.uic_h10",
    form: "Form H-10 (annual disposal/injection report)",
    grain: "one row per permit per cycle",
  },
} as const;

const provenance = defineTool(
  "rrc_provenance",
  "Trace one reported number back to the filing, table and cycle it came from, with the reporting edge that bounds it.",
  {
    oil_gas_code: z.enum(["O", "G"]),
    district_no: z.string(),
    lease_no: z.string(),
    stream: z.enum(["oil", "gas", "cond", "csgd"]).optional(),
    cycle: z.string().optional(),
  },
  async ({ oil_gas_code, district_no, lease_no, stream, cycle }) => {
    const which = stream ?? "oil";
    const [edge, lease] = await Promise.all([
      getCycleEdge(),
      getLeaseDossier(oil_gas_code, district_no, lease_no),
    ]);
    if (!lease) return fail(`No lease ${oil_gas_code}/${district_no}/${lease_no}.`);

    const reported = lease.monthly.filter((m) => m.reported);
    const row = cycle
      ? lease.monthly.find((m) => m.cycle === cycle)
      : reported[reported.length - 1];
    if (!row) {
      return fail(
        cycle
          ? `Cycle ${cycle} is not in the mirror for this lease. It holds ${lease.monthly[0]?.cycle ?? "nothing"} through ${lease.monthly[lease.monthly.length - 1]?.cycle ?? "nothing"}.`
          : "This lease has no reported cycle."
      );
    }

    const volume =
      which === "oil"
        ? row.oil_prod_vol
        : which === "gas"
          ? row.gas_prod_vol
          : which === "cond"
            ? row.cond_prod_vol
            : row.csgd_prod_vol;

    const buyers = lease.p4.connections.filter((c) => c.type_code === "H");
    const lastFiling = lease.p4.filings[0] ?? null;

    return {
      ok: true as const,
      lease: `${oil_gas_code}/${district_no}/${lease_no}`,
      lease_name: lease.lease_name,
      operator_no: lease.operator_no,
      operator_name: lease.operator_name,
      field_no: lease.field_no,
      field_name: lease.field_name,
      stream: which,
      cycle: row.cycle,
      value: volume,
      daily_rate: volume / daysInCycle(row.cycle),
      basis: row.reported && row.prod_report_filed === "Y" ? "filed" : "not filed",
      source: {
        ...PROVENANCE.production,
        key: { oil_gas_code, district_no, lease_no, cycle: row.cycle },
        prod_report_filed: row.prod_report_filed,
        reported: row.reported,
      },
      reporting_edge: {
        production_reported_through: edge.reported,
        production_loaded_through: edge.loaded,
        cycles_behind: edge.reported && edge.loaded ? monthsBetween(edge.reported, edge.loaded) : null,
      },
      related_filings: {
        p4_last_filing: lastFiling,
        purchasers: buyers.map((b) => ({
          operator_name: b.operator_name,
          gpn_no: b.gpn_no,
          product_code: b.product_code,
          actual_percent: b.actual_percent,
          effective_date: b.effective_date,
        })),
      },
      caveats: [
        row.prod_report_filed === "Y"
          ? "This cycle is marked filed, so the volume is the operator's own reported figure."
          : "This cycle is NOT marked filed. The zero or partial volume beside it is an absence of paperwork, not a measurement of nothing.",
        !row.reported
          ? `Cycle ${row.cycle} is past the RRC's publication edge of ${edge.reported}. It is unpublished, not zero.`
          : `Published: the RRC has released cycles through ${edge.reported}.`,
        "Lease production is a FILING, not a meter reading. It can be amended in later loads, and per-well figures anywhere in this system are allocations of it.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 71

/** Missing lease-months, the number every production answer is built over. */
function missingMonths(months: readonly LeaseMonth[]) {
  const reported = months.filter((m) => m.reported);
  const missing = reported.filter((m) => m.prod_report_filed !== "Y");
  return {
    reported_months: reported.length,
    missing_months: missing.length,
    missing_share: reported.length ? missing.length / reported.length : null,
    missing_cycles: missing.map((m) => m.cycle).slice(0, 60),
    missing_truncated: missing.length > 60,
    first_cycle: reported[0]?.cycle ?? null,
    last_cycle: reported[reported.length - 1]?.cycle ?? null,
  };
}

const coverage = defineTool(
  "rrc_coverage",
  "Where the record is thin for one lease, operator or county: unfiled lease-months, wells with no coordinates, and the reporting lags.",
  {
    scope: z.enum(["lease", "operator", "county"]),
    oil_gas_code: z.enum(["O", "G"]).optional(),
    district_no: z.string().optional(),
    lease_no: z.string().optional(),
    operator_no: z.string().optional(),
    county: z.string().optional(),
  },
  async (args) => {
    const [edge, injection] = await Promise.all([getCycleEdge(), getInjectionEdge()]);
    const lags = {
      production_reported_through: edge.reported,
      production_loaded_through: edge.loaded,
      production_lag_months: edge.reported && edge.loaded ? monthsBetween(edge.reported, edge.loaded) : null,
      h10_reported_through: injection.reported,
      h10_loaded_through: injection.loaded,
      h10_lag_months:
        injection.reported && injection.loaded ? monthsBetween(injection.reported, injection.loaded) : null,
    };
    const standing = [
      "The survey table carries NO county column, so an abstract number is not unique statewide: two counties can both hold an A-64 and a survey match is a candidate, never an identification.",
      "The RRC publishes no lease boundaries, no ownership, and no prices. Any answer needing one of those is outside what this record can support.",
      "Status columns (well type, 14(b)(2) flags, inactivity clocks) are populated only on CURRENT schedule rows. A historic wellbore is blank rather than clean.",
    ];

    if (args.scope === "lease") {
      if (!args.oil_gas_code || !args.district_no || !args.lease_no) {
        return fail("scope 'lease' needs oil_gas_code, district_no and lease_no.");
      }
      const lease = await getLeaseDossier(args.oil_gas_code, args.district_no, args.lease_no);
      if (!lease) return fail(`No lease ${args.oil_gas_code}/${args.district_no}/${args.lease_no}.`);
      const wells = lease.wells ?? [];
      const noCoords = wells.filter((w) => w.lat == null || w.lon == null);
      const production = missingMonths(lease.monthly);
      return {
        ok: true as const,
        scope: args.scope,
        lease: `${args.oil_gas_code}/${args.district_no}/${args.lease_no}`,
        lease_name: lease.lease_name,
        production,
        unpublished_tail: lease.monthly.filter((m) => !m.reported).map((m) => m.cycle),
        wells: wells.length,
        wells_without_coordinates: noCoords.length,
        wells_without_coordinates_share: wells.length ? noCoords.length / wells.length : null,
        wells_missing_coordinates: noCoords.slice(0, 40).map((w) => ({ api_number: w.api_number, well_no: w.well_no })),
        counties: lease.counties.map((c) => c.county_name),
        lags,
        caveats: [
          production.missing_months > 0
            ? `${production.missing_months} of ${production.reported_months} published months on this lease were never filed. Those cycles read as zero and must not be averaged through.`
            : "Every published cycle on this lease carries a filing.",
          noCoords.length > 0
            ? `${noCoords.length} well(s) on this lease have no surface coordinate, so they cannot appear on a map or in any radius search.`
            : "Every well on this lease is geocoded.",
          ...standing,
        ],
      };
    }

    if (args.scope === "operator") {
      const op = args.operator_no?.trim();
      if (!op) return fail("scope 'operator' needs operator_no.");
      const dossier = await getOperatorDossier(op);
      if (!dossier) return fail(`No operator ${op}.`);
      const filings = await rrcQuery<{ lease_months: number; filed: number; leases: number }>(
        `select count(*)::int as lease_months,
                count(*) filter (where prod_report_filed = 'Y')::int as filed,
                count(distinct (oil_gas_code, district_no, lease_no))::int as leases
           from rrc.lease_production
          where operator_no = $1
            and cycle > (date_trunc('month', now()) - interval '60 months')`,
        [op]
      );
      const row = filings[0] ?? { lease_months: 0, filed: 0, leases: 0 };
      const missing = row.lease_months - row.filed;
      return {
        ok: true as const,
        scope: args.scope,
        operator_no: op,
        operator_name: dossier.record.operator_name,
        window_months: 60,
        leases: row.leases,
        lease_months: row.lease_months,
        filed_lease_months: row.filed,
        missing_lease_months: missing,
        missing_share: row.lease_months ? missing / row.lease_months : null,
        wells_on_schedule: dossier.wells.total,
        h15_wells_tested: dossier.h15.wellsTested,
        h15_never_tested: Math.max(0, dossier.wells.total - dossier.h15.wellsTested),
        lags,
        caveats: [
          row.lease_months === 0
            ? "This operator has no lease-production rows in the last 60 cycles, so nothing about their production can be read from this record."
            : `${missing} of ${row.lease_months} lease-months in the window were never filed (${((missing / Math.max(1, row.lease_months)) * 100).toFixed(1)}%).`,
          "The lease and field lists on an operator dossier are their CURRENT footprint. Leases they have sold or let go are invisible here and their history sits under whoever holds it now.",
          ...standing,
        ],
      };
    }

    const resolved = resolveCounty(args.county?.trim() ?? "");
    if (!resolved) return fail("scope 'county' needs a Texas county.");
    const rows = await rrcQuery<{ wells: number; no_coords: number; no_completion: number }>(
      `select count(distinct w.api_number)::int as wells,
              count(distinct w.api_number) filter (where l.api_number is null)::int as no_coords,
              count(distinct w.api_number) filter (where nullif(btrim(w.completion_date), '') is null
                                               and nullif(btrim(w.orig_completion_dt), '') is null)::int as no_completion
         from rrc.wellbore w
         left join rrc.well_location l on l.api_number = w.api_number
        where w.county_code = $1 and w.on_schedule = 'Y'`,
      [resolved.county_no]
    );
    const row = rows[0] ?? { wells: 0, no_coords: 0, no_completion: 0 };
    return {
      ok: true as const,
      scope: "county" as const,
      county: resolved.county_name,
      county_no: resolved.county_no,
      wells_on_schedule: row.wells,
      wells_without_coordinates: row.no_coords,
      wells_without_coordinates_share: row.wells ? row.no_coords / row.wells : null,
      wells_without_completion_date: row.no_completion,
      lags,
      caveats: [
        row.no_coords > 0
          ? `${row.no_coords} of ${row.wells} wells on schedule in ${resolved.county_name} have no coordinate, so every radius search in this county silently misses them.`
          : "Every well on schedule in this county is geocoded.",
        row.no_completion > 0
          ? `${row.no_completion} wells carry no completion date, so they drop out of any vintage or survival analysis.`
          : "Every well on schedule carries a completion date.",
        "Historic wellbores (not on the current schedule) are excluded from these counts entirely.",
        ...standing,
      ],
    };
  }
);

// ------------------------------------------------------------------ 72

const MAX_TARGETS = 200;

const targetList = defineTool(
  "rrc_target_list",
  "Turn a screen result into a ranked table with the key needed to reopen each row, plus CSV.",
  {
    title: z.string().optional(),
    items: z
      .array(
        z.object({
          key: z.string(),
          label: z.string().optional(),
          score: z.number().optional(),
          metrics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
        })
      )
      .min(1),
    sort_by: z.string().optional(),
    descending: z.boolean().optional(),
    limit: z.number().int().optional(),
  },
  async ({ title, items, sort_by, descending, limit }) => {
    const wanted = Math.min(MAX_TARGETS, Math.max(1, Math.floor(limit ?? 50)));
    const sortKey = sort_by ?? "score";
    const desc = descending ?? true;

    const rows = items.map((item, i) => {
      const kind = classify(item.key);
      const key = item.key.trim();
      const parsed = kind === "lease" ? parseLeaseKey(key) : null;
      return {
        rank: 0,
        key,
        kind,
        label: item.label ?? key,
        score: item.score ?? null,
        metrics: item.metrics ?? {},
        // The argument object that reopens this row, so a follow-up question
        // does not need the model to remember how each entity is keyed.
        reopen: parsed
          ? { entity: "lease", oil_gas_code: parsed.oil_gas_code, district_no: parsed.district_no, lease_no: parsed.lease_no }
          : kind === "well"
            ? { entity: "well", api: key }
            : kind === "operator"
              ? { entity: "operator", operator_no: key }
              : null,
        input_order: i,
      };
    });

    const value = (row: (typeof rows)[number]): number | string | null => {
      if (sortKey === "score") return row.score;
      if (sortKey === "label") return row.label;
      const m = row.metrics[sortKey];
      return m === undefined ? null : m;
    };
    const sorted = [...rows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      // Rows with no value for the sort key go last in either direction: a null
      // sorted as zero would rank an unmeasured target above a measured one.
      if (av == null && bv == null) return a.input_order - b.input_order;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return desc ? -cmp : cmp;
    });

    const kept = sorted.slice(0, wanted).map((r, i) => ({ ...r, rank: i + 1 }));
    const metricKeys = [...new Set(kept.flatMap((r) => Object.keys(r.metrics)))].sort();
    const header = ["rank", "key", "kind", "label", "score", ...metricKeys];
    const csv = [
      header.join(","),
      ...kept.map((r) =>
        [
          r.rank,
          r.key,
          r.kind,
          r.label,
          r.score ?? "",
          ...metricKeys.map((k) => {
            const v = r.metrics[k];
            return v == null ? "" : v;
          }),
        ]
          .map((cell) => {
            const s = String(cell);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      ),
    ].join("\n");

    return {
      ok: true as const,
      title: title ?? "RRC target list",
      sorted_by: sortKey,
      descending: desc,
      total_items: items.length,
      rows: kept,
      unrecognised_keys: kept.filter((r) => r.kind === "unknown").map((r) => r.key),
      columns: header,
      csv,
      truncated: items.length > kept.length,
      notes: [
        'Keys are classified by shape: "O/08/12345" is a lease, 8 to 14 digits is an API, 6 digits is a P-5 operator number. Anything else is passed through as unknown and carries no reopen arguments.',
        "Rows missing the sort key are placed last rather than treated as zero.",
        "This tool formats what it is given. It does not verify that the keys exist in the mirror; use rrc_provenance or rrc_case_file for that.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 73

const MAX_CASE_TARGETS = 20;

/** One target, re-read from the mirror right now. */
async function readTarget(key: string, since: string | null) {
  const kind = classify(key);
  if (kind === "lease") {
    const parsed = parseLeaseKey(key)!;
    const lease = await getLeaseDossier(parsed.oil_gas_code, parsed.district_no, parsed.lease_no);
    if (!lease) return { key, kind, found: false as const, error: `No lease ${key}.` };
    const reported = lease.monthly.filter((m) => m.reported);
    const latest = reported[reported.length - 1] ?? null;
    const then = since ? reported.find((m) => m.cycle === since) ?? null : null;
    const rate = (m: LeaseMonth | null) => (m ? m.oil_prod_vol / daysInCycle(m.cycle) : null);
    const now = rate(latest);
    const before = rate(then);
    return {
      key,
      kind,
      found: true as const,
      label: lease.lease_name,
      operator_name: lease.operator_name,
      field_name: lease.field_name,
      wells: lease.wells?.length ?? 0,
      severance: lease.severance,
      off_schedule: lease.off_schedule,
      latest_cycle: latest?.cycle ?? null,
      latest_oil_bbl_per_day: now,
      since_cycle: then?.cycle ?? null,
      since_oil_bbl_per_day: before,
      change: now != null && before != null && before > 0 ? now / before - 1 : null,
      last_12mo_oil: sum(reported.slice(-12).map((m) => m.oil_prod_vol)),
    };
  }
  if (kind === "operator") {
    const dossier = await getOperatorDossier(key.trim());
    if (!dossier) return { key, kind, found: false as const, error: `No operator ${key}.` };
    const reported = dossier.monthly.filter((m) => m.reported);
    return {
      key,
      kind,
      found: true as const,
      label: dossier.record.operator_name,
      p5_status: dossier.record.p5_status,
      last_p5_date: dossier.record.last_p5_date,
      wells: dossier.wells.total,
      flagged_14b2: dossier.wells.flagged14b2,
      plugged: dossier.wells.plugged,
      h15_delinquent: dossier.h15.delinquent,
      leases: dossier.leases.length,
      latest_cycle: reported[reported.length - 1]?.cycle ?? null,
      last_12mo_oil: sum(reported.slice(-12).map((m) => m.oil_prod_vol)),
    };
  }
  if (kind === "well") {
    const well = await getWellDossier(key.trim());
    if (!well) return { key, kind, found: false as const, error: `No wellbore ${key}.` };
    return {
      key,
      kind,
      found: true as const,
      label: well.header.lease_name,
      operator_name: well.header.operator_name,
      well_type: well.status?.well_type_name ?? null,
      current: well.current,
      plug_date: well.status?.plug_date ?? null,
      shut_in_date: well.status?.wb_shut_in_date ?? null,
      flagged_14b2: well.compliance?.wb_14b2_flag === "Y",
      lease: well.header.lease_number,
    };
  }
  return { key, kind, found: false as const, error: `Unrecognised key "${key}".` };
}

const caseFile = defineTool(
  "rrc_case_file",
  "Format an investigation: the targets re-read from the mirror right now, what has been checked, and what moved since a stated cycle.",
  {
    title: z.string(),
    targets: z.array(z.object({ key: z.string(), note: z.string().optional() })).min(1),
    checked: z.array(z.string()).optional(),
    open_questions: z.array(z.string()).optional(),
    since: z.string().optional(),
  },
  async ({ title, targets, checked, open_questions, since }) => {
    const capped = targets.slice(0, MAX_CASE_TARGETS);
    const sinceCycle = since?.trim() && /^\d{4}-\d{2}$/.test(since.trim()) ? since.trim() : null;
    if (since?.trim() && !sinceCycle) return fail(`since must be a cycle like "2025-06".`);

    const [edge, reads] = await Promise.all([
      getCycleEdge(),
      Promise.all(capped.map((t) => readTarget(t.key, sinceCycle))),
    ]);
    const noteBy = new Map(capped.map((t) => [t.key, t.note ?? null]));
    const rows = reads.map((r) => ({ ...r, note: noteBy.get(r.key) ?? null }));

    const movers = rows
      .filter((r): r is Extract<typeof r, { found: true; change?: number | null }> => r.found === true)
      .map((r) => ({ key: r.key, label: "label" in r ? r.label : null, change: "change" in r ? r.change : null }))
      .filter((r) => r.change != null)
      .sort((a, b) => Math.abs(b.change as number) - Math.abs(a.change as number));

    const checkedNames = checked ?? [];
    // Imported at CALL time, not at module load: the registry imports this file
    // to build the catalog, and a static import back would be a cycle that
    // leaves one of the two holding an undefined tool list.
    const { rrcToolNames } = await import("../registry");
    const known = new Set(rrcToolNames());
    return {
      ok: true as const,
      title,
      as_of: {
        production_reported_through: edge.reported,
        production_loaded_through: edge.loaded,
      },
      since: sinceCycle,
      targets: rows,
      found: rows.filter((r) => r.found).length,
      missing: rows.filter((r) => !r.found).map((r) => r.key),
      movers,
      checked: checkedNames.map((name) => ({ name, is_catalog_tool: known.has(name) })),
      open_questions: open_questions ?? [],
      truncated: targets.length > capped.length,
      notes: [
        "STATELESS. This formats what you passed plus a fresh read of each target; it stores nothing and remembers nothing between calls. Pass the same targets and checks back in to carry an investigation forward.",
        sinceCycle
          ? `Change is the latest reported cycle against ${sinceCycle}, both from the same lease-production filings.`
          : "No `since` cycle was given, so no change was computed.",
        `Everything here is measured to the RRC's publication edge of ${edge.reported}; more recent cycles are unpublished, not zero.`,
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [provenance, coverage, targetList, caseFile];
