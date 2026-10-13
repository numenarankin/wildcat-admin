"use server";

import { z } from "zod";
import { getSupabaseServer, getSupabaseAdmin } from "@/lib/supabase/server";
import { userCan } from "@/lib/auth/permissions";
import type { PermissionKey } from "@/lib/settings/org";
import { INGEST_TYPE_META, type IngestType } from "@/lib/ai/ingest/types";
import { canonical, canonicalId } from "@/lib/ai/ingest/normalize";
import {
  contractorKey,
  providerKey,
  nameKey as ownerKey,
  inventoryKey,
  txnKey,
  normHhmm,
  readingKey,
  downtimeKey,
  serviceKey,
  equipmentKey,
  meterVolumeKey,
  shotKey,
  noteKey,
  stmtKey,
  settleKey,
  runTicketKey,
} from "@/lib/ai/ingest/dedup-keys";
import { groupRunsIntoStatements } from "@/lib/ai/ingest/oil-run-statement";
import { groupInvoiceLines } from "@/lib/ai/ingest/vendor-invoice";
import { writeInvoiceDrafts } from "@/lib/invoices/write";
import {
  relinkInvoiceProperties,
  relinkInvoiceVendors,
} from "@/lib/invoices/relink";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";
import {
  contractorRow,
  gathererRow,
  purchaserRow,
  employeeRow,
  inventoryRow,
  productionRow,
  royaltyOwnerRow,
  serviceProviderRow,
  serviceRow,
  transactionRow,
  wellEquipmentRow,
  wellRow,
  injectionWellRow,
  leaseRow,
  leaseInterestRow,
  leaseUseGasRow,
  tankRow,
  tankReadingRow,
  runTicketRow,
  batteryRow,
  meterRow,
  meterReadingRow,
  downtimeRow,
  wellTestRow,
  shotRow,
  wellNoteRow,
  gasTestRow,
  meterVolumeRow,
  disposalReadingRow,
  oilRunStatementRow,
  vendorInvoiceRow,
  gasSettlementStatementRow,
  liftReadingTime,
} from "@/lib/ai/ingest/schemas";
import {
  createContractor,
  createRoyaltyOwner,
  createServiceProvider,
  createGatherer,
  createEmployee,
} from "@/lib/people/actions";
import { createInventoryItem } from "@/lib/inventory/actions";
import { createTransactions } from "@/lib/accounting/actions";
import {
  addWellEquipment,
  updateWellEquipment,
  addWellService,
  addWellShotRow,
  fetchWellShots,
  writeProductionReadings,
  createWell,
} from "@/lib/wells/actions";
import { createNote, saveNote } from "@/lib/notes/actions";
import { listNotesForTarget } from "@/lib/notes/notes";
import { htmlFromPlainText, snippetFromHtml } from "@/lib/notes/format";
import {
  getWellGasTestTargets,
  recordWellGasShutIn,
} from "@/lib/meters/actions";
import { spanDays } from "@/lib/wells/well-tests";
import {
  getContractors,
  getRoyaltyOwners,
  getServiceProviders,
  getGatherers,
  getEmployees,
  type Gatherer,
} from "@/lib/people/people";
import { getInventory } from "@/lib/inventory/inventory";
import { getTransactions } from "@/lib/accounting/ledger";
import { getWells } from "@/lib/wells/wells";
import type { ProductionWritePoint } from "@/lib/wells/wells";
import { addRunTickets } from "@/lib/tanks/run-ticket-actions";
import { listTanks } from "@/lib/tanks/tanks";
import { revalidatePath } from "next/cache";
import { addTank } from "@/lib/tanks/actions";
import { addTankReading, addTankReadings, type TankReadingInput } from "@/lib/tanks/tanks";
import { addMeterReading, addMeterReadings, type MeterReadingInput } from "@/lib/meters/meters";
import { addWellEvent } from "@/lib/wells/well-events";
import { createWellTest } from "@/lib/wells/well-tests-actions";
import {
  addMeterVolumeStatement,
  listMeterVolumeStatements,
} from "@/lib/meters/volume-statements";
import { listMeters } from "@/lib/meters/meters";
import { addMeter, editMeter } from "@/lib/meters/actions";
import { addBattery, getBatteries } from "@/lib/batteries/actions";
import {
  getLeases,
  addLease,
  assignTankToLease,
  assignMeterToLease,
} from "@/lib/leases/actions";
import {
  addLeaseInterest,
  addWiOwnerInterest,
  upsertOperatorInterest,
} from "@/lib/interest/interest";
import { listOrgWiOwners } from "@/lib/settings/wi-owners";
import { setLeaseUseGas } from "@/lib/rrc/lease-use-gas";
import { createInjectionWell, addDisposalReadings } from "@/lib/disposal/actions";
import {
  createStatement,
  replaceStatementLines,
  updateStatement,
  getOrCreatePurchaser,
  upsertPurchaserContact,
  listStatements,
  type LineItemInput,
} from "@/lib/statements/statements";
import {
  leaseIsOnFile,
  leaseKey,
  matchLease,
  type MatchTarget,
} from "@/lib/statements/matching";
import { STATEMENT_UPLOAD_BUCKET } from "@/lib/statements/storage";

/** A proposal as the client modal consumes it. */
export interface IngestProposal {
  id: string;
  type: IngestType;
  fileName: string;
  wellId: string | null;
  /** Pinned tank id (entity-scoped uploads); writes land here, no name-resolution. */
  tankId: string | null;
  /** Pinned meter id (entity-scoped uploads); writes land here, no name-resolution. */
  meterId: string | null;
  rows: unknown[];
  status: string;
  createdAt: string;
  /**
   * 1-based source pages these rows were read from, ascending. Null when the
   * document had no page structure. Provenance for the approval UI.
   */
  sourcePages?: number[] | null;
}

interface ProposalRow {
  id: string;
  type: string;
  file_name: string | null;
  well_id: string | null;
  tank_id: string | null;
  meter_id: string | null;
  rows: unknown;
  status: string;
  created_at: string;
}

function mapProposal(r: ProposalRow): IngestProposal {
  return {
    id: r.id,
    type: r.type as IngestType,
    fileName: r.file_name ?? "",
    wellId: r.well_id,
    tankId: r.tank_id ?? null,
    meterId: r.meter_id ?? null,
    rows: Array.isArray(r.rows) ? (r.rows as unknown[]) : [],
    status: r.status,
    createdAt: r.created_at,
  };
}

/** The uploader's open (pending) proposals, oldest first. */
export async function getPendingProposals(): Promise<IngestProposal[]> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("ingest_proposals")
    .select(
      "id, type, file_name, well_id, tank_id, meter_id, rows, status, created_at"
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("getPendingProposals failed", error.message);
    return [];
  }
  return ((data ?? []) as ProposalRow[]).map(mapProposal);
}

/** Wells the approval modal offers when a production/equipment row has no match. */
export interface WellOption {
  id: string;
  name: string;
}

/** Well {id,name} options for the modal's well picker (RLS-scoped to the org). */
export async function getIngestWellOptions(): Promise<WellOption[]> {
  const wells = await getWells();
  return wells.map((w) => ({ id: w.id, name: w.name }));
}

export interface ApproveResult {
  ok: boolean;
  added?: number;
  /** Existing rows corrected in place — only the merging types (production)
   *  report this; everywhere else a key match is still a skip. */
  updated?: number;
  skipped?: number;
  error?: string;
}

// Dedup keys (canonical: "Tank No. 7" == "Tank #7" == "tank 7") are shared with
// the scan-time suppression pass — see `@/lib/ai/ingest/dedup-keys`.

/**
 * Resolve a printed device identifier (a tank/meter number, else its name) to a
 * real device id, using canonical matching so "No. 7" / "#7" / "7" all match.
 * Number match wins over name match; no match → null.
 */
function resolveDevice(
  ref: string,
  devices: { id: string; name: string; no: string }[]
): string | null {
  const r = canonical(ref);
  if (!r) return null;
  const rid = canonicalId(ref);
  const hit =
    devices.find((d) => d.no && (canonical(d.no) === r || canonicalId(d.no) === rid)) ??
    devices.find((d) => canonical(d.name) === r);
  return hit?.id ?? null;
}

type Sb = Awaited<ReturnType<typeof getSupabaseServer>>;

/**
 * Resolve a printed tank ref to an existing tank, or CREATE a minimal tank when
 * none matches (create-or-resolve). This is what lets a first bulk upload of
 * gauge readings / run tickets self-bootstrap instead of silently dropping rows
 * for a tank that has not been set up yet. Returns null only for a blank ref.
 */
async function resolveOrCreateTank(
  sb: Sb,
  ref: string,
  product: "oil" | "water"
): Promise<string | null> {
  if (!canonical(ref)) return null;
  const tanks = (await listTanks(sb)).map((t) => ({
    id: t.id,
    name: t.name,
    no: t.tankNo ?? "",
  }));
  const hit = resolveDevice(ref, tanks);
  if (hit) return hit;
  // A tank has no stored name, so the printed ref survives only as its number —
  // which is what names it ("Roach T123") once it lands on a lease.
  const created = await addTank({
    product,
    tankNo: ref,
    bblPerInch: 1,
  });
  return created.id;
}

/**
 * Resolve a printed tank ref to an EXISTING tank id only — never creates. Blank
 * ref or no match returns null. This is the pinned (tank-scoped Add History)
 * path's matcher: a file uploaded from one tank's workspace can still hold
 * sections for OTHER tanks, so a row whose printed ref names a different real
 * tank is routed there; a row the source doesn't clearly tie to a known tank
 * falls back to the pinned workspace tank rather than spawning a stray tank.
 */
async function resolveExistingTank(sb: Sb, ref: string): Promise<string | null> {
  if (!canonical(ref)) return null;
  const tanks = (await listTanks(sb)).map((t) => ({
    id: t.id,
    name: t.name,
    no: t.tankNo ?? "",
  }));
  return resolveDevice(ref, tanks);
}

/**
 * The identity keys (`runTicketKey`) of a tank's tickets already on file, for
 * the write-time duplicate skip. `run_tickets` has no unique constraint, so
 * this is the only guard against a re-approved or re-uploaded statement
 * doubling the barrels that feed the tank-level series. Voided (soft-deleted)
 * tickets don't count — re-filing a run whose ticket was deliberately voided
 * is a correction, not a duplicate.
 */
async function existingRunTicketKeys(
  sb: Sb,
  tankId: string
): Promise<Set<string>> {
  const { data } = await sb
    .from("run_tickets")
    .select("ticket_no, ticket_date, net_bbls, gross_bbls")
    .eq("tank_id", tankId)
    .is("deleted_at", null);
  return new Set(
    (
      (data ?? []) as {
        ticket_no: string | null;
        ticket_date: string;
        net_bbls: number | null;
        gross_bbls: number | null;
      }[]
    ).map((t) => runTicketKey(t.ticket_no, t.ticket_date, t.net_bbls ?? t.gross_bbls))
  );
}

/** Resolve a printed meter ref to an existing meter, or create a minimal one. */
async function resolveOrCreateMeter(
  sb: Sb,
  ref: string
): Promise<string | null> {
  if (!canonical(ref)) return null;
  const meters = (await listMeters(sb)).map((m) => ({
    id: m.id,
    name: m.name,
    no: m.meterNo ?? "",
  }));
  const hit = resolveDevice(ref, meters);
  if (hit) return hit;
  // A meter has no stored name, so the printed ref survives only as its number
  // — which is what names it ("Dofflemeyer M1234") once it lands on a lease.
  const created = await addMeter({
    meterNo: ref,
  });
  return created.id;
}

/**
 * Best-effort copy of the data-entry upload (which lives in the `files` bucket)
 * into the statement-uploads bucket, so a statement filed from Data Entry
 * carries the original PDF — the revenue page views it from that bucket. Returns
 * the storage metadata, or null when there is no file or the copy fails (the
 * statement is still filed, just without an attached document; the failure is
 * logged, never thrown).
 */
async function attachUploadToStatements(
  sb: Sb,
  fileId: string | null
): Promise<{
  storageKey: string;
  fileName: string | null;
  mime: string | null;
  size: number | null;
} | null> {
  if (!fileId) return null;
  const { data: file } = await sb
    .from("files")
    .select("name, mime, size, storage_key")
    .eq("id", fileId)
    .maybeSingle();
  const f = file as {
    name: string | null;
    mime: string | null;
    size: number | null;
    storage_key: string | null;
  } | null;
  if (!f?.storage_key) return null;
  const { data: orgId } = await sb.rpc("current_org_id");
  if (!orgId) return null;
  try {
    const admin = getSupabaseAdmin();
    const { data: blob, error: dlErr } = await admin.storage
      .from("files")
      .download(f.storage_key);
    if (dlErr || !blob) throw new Error(dlErr?.message ?? "file not in storage");
    const buf = Buffer.from(await blob.arrayBuffer());
    const dest = `${orgId as string}/${crypto.randomUUID()}`;
    const { error: upErr } = await admin.storage
      .from(STATEMENT_UPLOAD_BUCKET)
      .upload(dest, buf, { contentType: f.mime ?? undefined, upsert: false });
    if (upErr) throw new Error(upErr.message);
    return { storageKey: dest, fileName: f.name, mime: f.mime, size: f.size };
  } catch (err) {
    ierr("write oilRunStatement: attach file FAILED", errorInfo(err));
    return null;
  }
}

/**
 * File approved oil-run-statement rows into the revenue/statements domain: ONE
 * statement per document (purchaser × statement number, grouped from the flat
 * run rows), with one settlement line PER RUN and the lease carried on each
 * line, the uploaded PDF attached, each run's tank/meter tied to its lease, a
 * run ticket created on the tank for every haul (so the tank's Runs tab
 * populates), and the purchaser's contact saved. Dedups against statements
 * already on file (keyed purchaser + statement/period), so re-approving the same
 * document is a no-op. `added` counts run lines written; `skipped` counts runs
 * on statements that already existed or carried no usable date.
 *
 * Tank creation, the lease-tie, and run-ticket creation are best-effort (each is
 * separately RLS-gated) so an accounting-only user still files the statement —
 * an unresolved tank just keeps its printed ref for a human to match on the
 * revenue page.
 */
/**
 * The ingest-approval entry point for vendor invoices: flat suggestion rows in,
 * PIDX rows out. Folds the rows into documents and hands them to the shared
 * writer, which is also what the Invoices page's reader uses — see
 * `writeInvoiceDrafts` for what actually gets stored and why.
 */
async function writeVendorInvoices(
  rawRows: unknown[],
  fileId: string | null
): Promise<{ added: number; skipped: number }> {
  const rows = z.array(vendorInvoiceRow).parse(rawRows);
  const drafts = groupInvoiceLines(rows);
  ilog("write vendorInvoice: begin", {
    lineRows: rows.length,
    invoices: drafts.length,
    groups: drafts.map((d) => ({
      vendor: d.vendor,
      invoiceNo: d.invoiceNo || "(derived)",
      lines: d.lines.length,
      total: d.invoiceTotal,
      taxLabel: d.taxLabelVerdict,
    })),
    fileId,
  });
  return writeInvoiceDrafts(drafts, fileId, { sourceRows: rows.length });
}

async function writeOilRunStatements(
  rawRows: unknown[],
  fileId: string | null
): Promise<{ added: number; skipped: number }> {
  const rows = z.array(oilRunStatementRow).parse(rawRows);
  const drafts = groupRunsIntoStatements(rows);
  ilog("write oilRunStatement: begin", {
    runRows: rows.length,
    statements: drafts.length,
    groups: drafts.map((d) => ({
      purchaser: d.purchaser,
      statementNo: d.statementNo,
      leases: new Set(d.lines.map((l) => l.leaseRef)).size,
      runs: d.lines.length,
      period: `${d.periodStart}..${d.periodEnd}`,
    })),
    fileId,
  });
  if (drafts.length === 0) return { added: 0, skipped: 0 };

  const sb = await getSupabaseServer();

  // Matchable leases and the current tank→lease map, loaded once for the batch.
  const leases = await getLeases();
  const leaseTargets: MatchTarget[] = leases.map((l) => ({
    id: l.id,
    number: l.leaseNo,
    name: l.name,
  }));
  const tankLeaseById = new Map(
    (await listTanks(sb)).map((t) => [t.id, t.leaseId] as const)
  );

  // Dedup: statements already on file, keyed purchaser + statement no (or +
  // period when no number is printed). A statement is one document (it may
  // settle many leases via its line items), so one key per statement.
  // `stmtKey` is shared with the scan-time suppression pass.
  const seen = new Set(
    (await listStatements(sb)).map((s) =>
      stmtKey(s.purchaser, s.statementNo, s.periodStart, s.periodEnd)
    )
  );

  const attachment = await attachUploadToStatements(sb, fileId);
  ilog("write oilRunStatement: file attach", {
    attached: Boolean(attachment),
    storageKey: attachment?.storageKey ?? null,
  });

  let added = 0;
  let skipped = 0;
  for (const d of drafts) {
    if (!d.periodStart || !d.periodEnd) {
      // No usable date anywhere in the group → can't file a dated statement.
      ierr("write oilRunStatement: group has no date, skipped", {
        purchaser: d.purchaser,
        runs: d.lines.length,
      });
      skipped += d.lines.length;
      continue;
    }
    const key = stmtKey(d.purchaser, d.statementNo, d.periodStart, d.periodEnd);
    if (seen.has(key)) {
      ilog("write oilRunStatement: duplicate statement skipped", {
        purchaser: d.purchaser,
        statementNo: d.statementNo,
        runs: d.lines.length,
      });
      skipped += d.lines.length;
      continue;
    }
    seen.add(key);

    // Purchaser + contact (contact fill is non-destructive).
    const purchaserId = d.purchaser
      ? await getOrCreatePurchaser(sb, d.purchaser)
      : null;
    if (purchaserId) {
      await upsertPurchaserContact(sb, purchaserId, {
        phone: d.purchaserPhone,
        email: d.purchaserEmail,
      });
    }

    const { id: statementId } = await createStatement(sb, {
      purchaser: d.purchaser,
      statementNo: d.statementNo,
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      product: "oil",
      storageKey: attachment?.storageKey ?? null,
      fileName: attachment?.fileName ?? null,
      mime: attachment?.mime ?? null,
      size: attachment?.size ?? null,
    });

    // One settlement line per run; resolve refs, tie the tank to its lease, and
    // stage a run ticket per haul (grouped by tank) so the tank's Runs tab fills.
    const lines: LineItemInput[] = [];
    const ticketsByTank = new Map<
      string,
      Omit<Parameters<typeof addRunTickets>[1][number], never>[]
    >();
    for (const run of d.lines) {
      const leaseId = matchLease(run.leaseRef, leaseTargets);
      let tankId: string | null = null;
      try {
        tankId = await resolveOrCreateTank(sb, run.tankRef, "oil");
      } catch (err) {
        ierr("write oilRunStatement: tank resolve failed", {
          tankRef: run.tankRef,
          ...errorInfo(err),
        });
      }
      // Tie the tank to the lease when both are known and it has no lease yet.
      if (tankId && leaseId && !tankLeaseById.get(tankId)) {
        try {
          await assignTankToLease(tankId, leaseId);
          tankLeaseById.set(tankId, leaseId);
        } catch (err) {
          ierr("write oilRunStatement: lease-tie failed", {
            tankId,
            leaseId,
            ...errorInfo(err),
          });
        }
      }
      lines.push({
        leaseId,
        tankId,
        meterId: null,
        leaseRef: run.leaseRef,
        tankRef: run.tankRef,
        meterRef: "",
        product: "oil",
        volume: run.volume,
        price: run.price,
        grossValue: run.gross ?? 0,
        deducts: 0,
        taxes: run.taxes ?? 0,
        netValue: run.net ?? (run.gross ?? 0) - (run.taxes ?? 0),
        mmbtu: null,
        allocatedQty: null,
        producerPct: null,
        settleQty: null,
        fees: 0,
        raw: {
          transporter: run.transporter || undefined,
          runDate: run.runDate || undefined,
          ticketNo: run.ticketNo || undefined,
          sourceText: run.sourceText || undefined,
        },
      });
      // A haul on a resolved tank becomes a run ticket for its VOLUME only. The
      // money for this run lives on the statement line above (the revenue source
      // of truth), so the run ticket no longer carries $ — that split is what
      // stops the barrels and dollars from double-counting (Phase 4). Transporter
      // stays: it's a physical haul attribute. Needs a date (falls back to the
      // statement period end).
      if (tankId) {
        const list = ticketsByTank.get(tankId) ?? [];
        list.push({
          date: run.runDate || d.periodEnd,
          ticketNo: run.ticketNo || undefined,
          ticketType: run.ticketType,
          grossBbls: run.volume,
          netBbls: run.volume,
          apiGravity: run.gravity ?? null,
          purchaser: d.purchaser || undefined,
          product: "oil",
          transporter: run.transporter || undefined,
        });
        ticketsByTank.set(tankId, list);
      }
    }

    await replaceStatementLines(sb, statementId, lines);
    // The runs were reviewed and approved in the modal, so the statement is
    // ready to reconcile on the revenue page.
    await updateStatement(sb, statementId, { status: "reviewed" });

    // Create the run tickets on each tank (best-effort; a failure logs and
    // leaves the statement filed). Skip hauls whose `runTicketKey` is already
    // on the tank — the statement-level dedup above misses the case where the
    // same runs arrive on a differently-keyed document (a corrected statement
    // number, or tickets first filed from another upload path).
    let tickets = 0;
    for (const [tankId, inputs] of ticketsByTank) {
      try {
        const seenTickets = await existingRunTicketKeys(sb, tankId);
        const fresh = inputs.filter((i) => {
          const k = runTicketKey(i.ticketNo, i.date, i.netBbls ?? i.grossBbls);
          if (seenTickets.has(k)) return false;
          seenTickets.add(k);
          return true;
        });
        if (fresh.length < inputs.length) {
          ilog("write oilRunStatement: duplicate tickets skipped", {
            tankId,
            skipped: inputs.length - fresh.length,
          });
        }
        if (fresh.length > 0) {
          const { created } = await addRunTickets(tankId, fresh);
          tickets += created;
        }
      } catch (err) {
        ierr("write oilRunStatement: run-ticket create failed", {
          tankId,
          count: inputs.length,
          ...errorInfo(err),
        });
      }
    }

    ilog("write oilRunStatement: statement created", {
      statementId,
      purchaser: d.purchaser,
      statementNo: d.statementNo,
      leases: new Set(d.lines.map((l) => l.leaseRef)).size,
      lines: lines.length,
      runTickets: tickets,
      matchedLeases: lines.filter((l) => l.leaseId).length,
      matchedTanks: lines.filter((l) => l.tankId).length,
    });
    added += lines.length;
  }

  ilog("write oilRunStatement: done", { added, skipped });
  return { added, skipped };
}

/**
 * Resolve a gatherer name to an id, creating the (minimal) People→Gatherers
 * record on first use. `cache` is the org's current gatherers, extended in place
 * so a batch of settlements naming the same gatherer creates it once. Returns
 * null for a blank name. Canonical match so "Targa" / "TARGA" collapse.
 */
async function resolveOrCreateGatherer(
  cache: Gatherer[],
  name: string,
  phone: string,
  email: string
): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;
  const hit = cache.find((g) => canonical(g.name) === canonical(clean));
  if (hit) return hit.id;
  const created = await createGatherer({
    name: clean,
    phone: phone.trim(),
    email: email.trim(),
    status: "Active",
    description: "",
  });
  cache.push(created);
  return created.id;
}

/**
 * File approved gas-settlement rows two ways, mirroring the oil flow: (1) one
 * settlement per meter on the meter's Settlements tab (gross vs residue volumes
 * and the residue + NGL − fees economics), and (2) a STATEMENT on the revenue
 * page (`/revenue`) per (gatherer × statement number) with the PDF attached and
 * one line per meter — so a gas settlement reconciles alongside oil statements.
 * Also creates + assigns the gatherer to the meter and ties the meter to its
 * lease. Dedups against settlements already on the meter and statements already
 * on file, so re-approving the same document is a no-op. `added` counts meter
 * settlements filed.
 *
 * Meter/gatherer creation, the lease-tie, and the revenue statement are
 * best-effort (each is separately RLS-gated) so an accounting-only user still
 * files what they can. The gatherer directory record and the meter/lease records
 * also come through their own approval cards; this resolves-or-creates so the
 * settlement doesn't depend on the order the cards are approved in.
 */
async function writeGasSettlements(
  rawRows: unknown[],
  fileId: string | null
): Promise<{ added: number; skipped: number }> {
  const rows = z.array(gasSettlementStatementRow).parse(rawRows);
  ilog("write gasSettlement: begin", {
    rows: rows.length,
    fileId,
    settlements: rows.map((r) => ({
      meter: r.meterRef || r.meterName,
      lease: r.leaseName,
      gatherer: r.gatherer,
      net: r.netValue,
    })),
  });
  if (rows.length === 0) return { added: 0, skipped: 0 };

  const sb = await getSupabaseServer();

  const leases = await getLeases();
  const leaseTargets: MatchTarget[] = leases.map((l) => ({
    id: l.id,
    number: l.leaseNo,
    name: l.name,
  }));
  const gatherers = await getGatherers();
  const meters = await listMeters(sb);
  const meterLeaseById = new Map(meters.map((m) => [m.id, m.leaseId] as const));
  const meterGathererById = new Map(
    meters.map((m) => [m.id, m.gathererId] as const)
  );

  // Dedup: existing settlements per meter, keyed date + gatherer (`settleKey`),
  // loaded lazily.
  const seenByMeter = new Map<string, Set<string>>();

  // Revenue-page statement(s): one per (gatherer × statement number), lines per
  // meter. Attach the uploaded PDF once and reuse it for each statement.
  const attachment = await attachUploadToStatements(sb, fileId);
  const stmtSeen = new Set(
    (await listStatements(sb)).map((s) =>
      stmtKey(s.purchaser, s.statementNo, s.periodStart, s.periodEnd)
    )
  );
  interface GasStmtGroup {
    gatherer: string;
    statementNo: string;
    dates: string[];
    lines: LineItemInput[];
  }
  const stmtGroups = new Map<string, GasStmtGroup>();

  let added = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.statementDate) {
      ierr("write gasSettlement: row has no date, skipped", {
        meter: r.meterRef || r.meterName,
      });
      skipped++;
      continue;
    }

    let meterId: string | null = null;
    try {
      meterId = await resolveOrCreateMeter(sb, r.meterRef || r.meterName);
    } catch (err) {
      ierr("write gasSettlement: meter resolve failed", {
        meterRef: r.meterRef,
        ...errorInfo(err),
      });
    }
    if (!meterId) {
      skipped++;
      continue;
    }

    if (!seenByMeter.has(meterId)) {
      const existing = await listMeterVolumeStatements(sb, meterId);
      seenByMeter.set(
        meterId,
        new Set(existing.map((s) => settleKey(s.date, s.purchaser)))
      );
    }
    const seen = seenByMeter.get(meterId)!;
    const key = settleKey(r.statementDate, r.gatherer);
    if (seen.has(key)) {
      ilog("write gasSettlement: duplicate settlement skipped", {
        meter: r.meterRef || r.meterName,
        date: r.statementDate,
      });
      skipped++;
      continue;
    }
    seen.add(key);

    // Resolve-or-create the gatherer and assign it to the meter (if unset).
    let gathererId: string | null = null;
    try {
      gathererId = await resolveOrCreateGatherer(
        gatherers,
        r.gatherer,
        r.gathererPhone,
        r.gathererEmail
      );
    } catch (err) {
      ierr("write gasSettlement: gatherer resolve failed", {
        gatherer: r.gatherer,
        ...errorInfo(err),
      });
    }
    if (gathererId && !meterGathererById.get(meterId)) {
      try {
        await editMeter(meterId, { gathererId });
        meterGathererById.set(meterId, gathererId);
      } catch (err) {
        ierr("write gasSettlement: gatherer-assign failed", {
          meterId,
          gathererId,
          ...errorInfo(err),
        });
      }
    }

    // Tie the meter to its lease (if known and it has none yet).
    const leaseId = matchLease(r.leaseName, leaseTargets);
    if (leaseId && !meterLeaseById.get(meterId)) {
      try {
        await assignMeterToLease(meterId, leaseId);
        meterLeaseById.set(meterId, leaseId);
      } catch (err) {
        ierr("write gasSettlement: lease-tie failed", {
          meterId,
          leaseId,
          ...errorInfo(err),
        });
      }
    }

    await addMeterVolumeStatement(sb, meterId, {
      date: r.statementDate,
      statementNo: r.statementNo || undefined,
      purchaser: r.gatherer || undefined,
      grossMcf: r.grossMcf,
      grossMmbtu: r.grossMmbtu,
      residueMcf: r.residueMcf,
      residueMmbtu: r.residueMmbtu,
      residuePrice: r.residuePrice,
      residueValue: r.residueValue,
      nglValue: r.nglValue,
      fees: r.fees,
      netValue: r.netValue,
    });
    added++;

    // Stage the revenue-page statement line for this meter (one line per meter,
    // grouped into the gatherer's statement). gross = residue + NGL value; the
    // plant fees are the deduction, so gross − deducts = net.
    const grossValue = (r.residueValue ?? 0) + (r.nglValue ?? 0);
    const gk = `${canonical(r.gatherer)}|${canonicalId(r.statementNo)}`;
    let group = stmtGroups.get(gk);
    if (!group) {
      group = { gatherer: r.gatherer.trim(), statementNo: r.statementNo.trim(), dates: [], lines: [] };
      stmtGroups.set(gk, group);
    }
    group.dates.push(r.statementDate);
    group.lines.push({
      leaseId,
      tankId: null,
      meterId,
      leaseRef: r.leaseName,
      tankRef: "",
      meterRef: r.meterRef || r.meterName,
      product: "gas",
      volume: r.grossMcf ?? r.residueMcf ?? 0,
      price: r.residuePrice,
      grossValue,
      deducts: r.fees ?? 0,
      taxes: 0,
      netValue: r.netValue ?? grossValue - (r.fees ?? 0),
      mmbtu: r.residueMmbtu ?? r.grossMmbtu,
      allocatedQty: null,
      producerPct: r.producerPct,
      settleQty: r.residueMmbtu,
      fees: r.fees ?? 0,
      raw: {
        residueValue: r.residueValue ?? undefined,
        nglValue: r.nglValue ?? undefined,
        contractType: r.contractType || undefined,
        statementNo: r.statementNo || undefined,
      },
    });

    ilog("write gasSettlement: filed", {
      meter: r.meterRef || r.meterName,
      lease: r.leaseName,
      gatherer: r.gatherer,
      net: r.netValue,
      tiedLease: Boolean(leaseId),
      assignedGatherer: Boolean(gathererId),
    });
  }

  // Create the revenue-page statement(s) with the PDF attached (best-effort).
  let statements = 0;
  for (const g of stmtGroups.values()) {
    const dates = g.dates.filter(Boolean).slice().sort();
    const periodStart = dates[0] ?? "";
    const periodEnd = dates[dates.length - 1] ?? periodStart;
    if (!periodStart) continue; // can't file a dated statement
    const key = stmtKey(g.gatherer, g.statementNo, periodStart, periodEnd);
    if (stmtSeen.has(key)) {
      ilog("write gasSettlement: duplicate revenue statement skipped", {
        gatherer: g.gatherer,
        statementNo: g.statementNo,
      });
      continue;
    }
    stmtSeen.add(key);
    try {
      const { id: statementId } = await createStatement(sb, {
        purchaser: g.gatherer,
        statementNo: g.statementNo,
        periodStart,
        periodEnd,
        product: "gas",
        storageKey: attachment?.storageKey ?? null,
        fileName: attachment?.fileName ?? null,
        mime: attachment?.mime ?? null,
        size: attachment?.size ?? null,
      });
      await replaceStatementLines(sb, statementId, g.lines);
      await updateStatement(sb, statementId, { status: "reviewed" });
      statements++;
      ilog("write gasSettlement: revenue statement created", {
        statementId,
        gatherer: g.gatherer,
        statementNo: g.statementNo,
        lines: g.lines.length,
      });
    } catch (err) {
      ierr("write gasSettlement: revenue statement FAILED", {
        gatherer: g.gatherer,
        statementNo: g.statementNo,
        ...errorInfo(err),
      });
    }
  }

  ilog("write gasSettlement: done", { added, skipped, statements });
  return { added, skipped };
}

/**
 * Fold a separate date and clock time into the UTC timestamp a measurement
 * window is stored as. Blank time means midnight. Mirrors `combine()` in the
 * well page's Gas test modal — including its explicit `Z` — so a window typed by
 * hand and one read off a scanned sheet land on the same instant.
 */
function combineStamp(date: string, time: string): string {
  if (!date) return "";
  return `${date}T${(time || "00:00").slice(0, 5)}:00Z`;
}

/** True for a Postgres unique-constraint violation surfaced through a domain error. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    err instanceof Error && /duplicate key value|23505/i.test(err.message)
  );
}

/**
 * Write one proposal's (edited) rows to the real tables, deduping against
 * existing records first. Returns how many were added versus skipped as
 * duplicates, plus — for the types that merge rather than skip (production) —
 * how many existing rows were `updated` in place. Each branch validates rows
 * with the type's schema, so an edited row that no longer fits is rejected
 * loudly rather than written malformed.
 * `fileId` is the source upload (for types like oilRunStatement that attach the
 * original document); null for proposals with no backing file.
 */
async function dispatchWrite(
  type: IngestType,
  rawRows: unknown[],
  wellId: string | null,
  fileId: string | null,
  pinnedTankId: string | null = null,
  pinnedMeterId: string | null = null
): Promise<{ added: number; skipped: number; updated?: number }> {
  switch (type) {
    case "contractors": {
      const rows = z.array(contractorRow).parse(rawRows);
      const seen = new Set(
        (await getContractors()).map((c) => contractorKey(c.name, c.phone))
      );
      let skipped = 0;
      for (const r of rows) {
        const key = contractorKey(r.name, r.phone);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await createContractor(r);
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "serviceProviders": {
      const rows = z.array(serviceProviderRow).parse(rawRows);
      const seen = new Set(
        (await getServiceProviders()).map((p) => providerKey(p.company))
      );
      let skipped = 0;
      for (const r of rows) {
        const key = providerKey(r.company);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await createServiceProvider(r);
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "royaltyOwners": {
      const rows = z.array(royaltyOwnerRow).parse(rawRows);
      const seen = new Set(
        (await getRoyaltyOwners()).map((o) => ownerKey(o.name))
      );
      let skipped = 0;
      for (const r of rows) {
        const key = ownerKey(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        // Ingest creates the owner directory entry only; interest in a lease is
        // granted later on the lease's Interest tab.
        await createRoyaltyOwner(r);
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "inventory": {
      const rows = z.array(inventoryRow).parse(rawRows);
      const seen = new Set(
        (await getInventory()).map((i) => inventoryKey(i.name, i.location))
      );
      let skipped = 0;
      for (const r of rows) {
        const key = inventoryKey(r.name, r.location);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await createInventoryItem(r);
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "transactions": {
      const rows = z.array(transactionRow).parse(rawRows);
      // Sanitize wellId: the model sometimes puts a well NAME (or a guess) in it,
      // which violates transactions_well_id_fkey. Keep it only when it's a real
      // well id; resolve a well NAME to its id; otherwise blank it (untied).
      const wells = await getWells();
      const wellIds = new Set(wells.map((w) => w.id));
      const wellByName = new Map(
        wells.map((w) => [canonical(w.name), w.id] as const)
      );
      for (const r of rows) {
        if (!r.wellId || wellIds.has(r.wellId)) continue;
        r.wellId = wellByName.get(canonical(r.wellId)) ?? "";
      }
      // Only dedup rows that carry an invoice number; recurring expenses with no
      // invoice are legitimately identical and must not be dropped.
      const existing = await getTransactions();
      const seen = new Set(
        existing
          .filter((t) => t.invoiceNumber)
          .map((t) => txnKey(t.invoiceNumber, t.amount, t.date))
      );
      const toWrite = rows.filter((r) => {
        if (!r.invoiceNumber) return true;
        return !seen.has(txnKey(r.invoiceNumber, r.amount, r.date));
      });
      if (toWrite.length > 0) await createTransactions(toWrite);
      return { added: toWrite.length, skipped: rows.length - toWrite.length };
    }

    case "production": {
      if (!wellId) throw new Error("A well is required for production.");
      const rows = z.array(productionRow).parse(rawRows);
      // Nulls pass through UNFLATTENED. `productionRow` is careful to keep "the
      // document did not report this" distinct from a reported zero, and the
      // write path's field-level merge is built on that distinction — collapsing
      // it to 0 here would let a gas-only report zero out the day's oil.
      const points: ProductionWritePoint[] = rows.map((r) => ({
        date: r.date,
        time: r.time,
        oilProduction: r.oilProduction,
        oilStock: r.oilStock,
        oilSales: r.oilSales,
        gasProduction: r.gasProduction,
        saltWater: r.saltWater,
        // GBC-7 gas-measurement fields: pass through (undefined when unmeasured).
        orifice: r.orifice ?? undefined,
        differential: r.differential ?? undefined,
        chm: r.chm ?? undefined,
        casingPressure: r.casingPressure ?? undefined,
        tubingPressure: r.tubingPressure ?? undefined,
        flowPressure: r.flowPressure ?? undefined,
        choke: r.choke ?? undefined,
        remarks: r.remarks || undefined,
      }));
      // Documents report oil in barrels, so bypass the gauge-inch strapping
      // conversion. Last-wins at the DB (upsert on well+date+time), so a
      // corrected reading overwrites the stale one field by field.
      const { added, updated, skipped } = await writeProductionReadings(
        wellId,
        points,
        { oilInBarrels: true }
      );
      return { added, updated, skipped };
    }

    case "wellEquipment": {
      if (!wellId) throw new Error("A well is required for equipment.");
      const rows = z.array(wellEquipmentRow).parse(rawRows);
      const sb = await getSupabaseServer();
      // Same label + same value → skip (the fact is already recorded). Same
      // label + DIFFERENT value → update that row in place: equipment rows are
      // the well's CURRENT spec and the Info sheet keys them by label, so a
      // pump swap must replace the pump row's value, not stack a second
      // "Downhole pump" row the sheet would hide. Only a genuinely new label
      // inserts.
      const { data: existing } = await sb
        .from("well_equipment")
        .select("id, label, value")
        .eq("well_id", wellId);
      const seen = new Set<string>();
      // First row per canonical label — the row the Info sheet renders for it.
      const byLabel = new Map<string, { id: string; value: string }>();
      for (const e of (existing ?? []) as {
        id: string;
        label: string | null;
        value: string | null;
      }[]) {
        seen.add(equipmentKey(e.label ?? "", e.value ?? ""));
        const lk = canonical(e.label ?? "");
        if (lk && !byLabel.has(lk)) byLabel.set(lk, { id: e.id, value: e.value ?? "" });
      }
      const toInsert: { label: string; value: string }[] = [];
      let updated = 0;
      let skipped = 0;
      for (const r of rows) {
        const key = equipmentKey(r.label, r.value);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        const lk = canonical(r.label);
        const hit = lk ? byLabel.get(lk) : undefined;
        if (hit?.id) {
          await updateWellEquipment(wellId, hit.id, { value: r.value });
          byLabel.set(lk, { id: hit.id, value: r.value });
          updated++;
        } else if (hit) {
          // The label was already inserted earlier IN THIS BATCH with another
          // value — one document proposing two values for one slot. Keep the
          // first; a second write would just flap the row.
          skipped++;
        } else {
          toInsert.push({ label: r.label, value: r.value });
          if (lk) byLabel.set(lk, { id: "", value: r.value });
        }
      }
      if (toInsert.length > 0) {
        await addWellEquipment(wellId, toInsert, { fileId });
      }
      return { added: toInsert.length, skipped, updated };
    }

    case "service": {
      if (!wellId) throw new Error("A well is required for service history.");
      const rows = z.array(serviceRow).parse(rawRows);
      const sb = await getSupabaseServer();
      // Dedup on date + job: the same service event must not be recorded twice.
      const { data: existing } = await sb
        .from("well_service")
        .select("date, job")
        .eq("well_id", wellId);
      const seen = new Set(
        ((existing ?? []) as { date: string; job: string | null }[]).map((e) =>
          serviceKey(e.date, e.job ?? "")
        )
      );
      const toWrite = rows.filter((r) => {
        const key = serviceKey(r.date, r.job);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (toWrite.length > 0) {
        await addWellService(
          wellId,
          toWrite.map((r) => ({
            date: r.date,
            job: r.job,
            vendor: r.vendor,
            cost: r.cost,
            notes: r.notes,
          })),
          // Link every row to the document it was read from — the ticket/invoice
          // IS the primary source for a service entry
          // (russell-feedback-one.md:28), and this path already knows which file
          // the rows came from, so the user never has to attach it by hand.
          { fileId }
        );
      }
      return { added: toWrite.length, skipped: rows.length - toWrite.length };
    }

    case "runTickets": {
      const rows = z.array(runTicketRow).parse(rawRows);
      const sb = await getSupabaseServer();
      // Group by resolved tank so each tank's tickets go in one batch write.
      const byTank = new Map<
        string,
        Omit<Parameters<typeof addRunTickets>[1][number], never>[]
      >();
      // Route each row by its printed ref, resolving each distinct ref once. A
      // pinned (tank-scoped Add History) upload honors a ref that names a
      // DIFFERENT existing tank and falls back to the pinned workspace tank for
      // blank/unknown refs; it never auto-creates a tank.
      const tankIdCache = new Map<string, string | null>();
      const resolveTank = async (
        ref: string,
        product: "oil" | "water"
      ): Promise<string | null> => {
        const ck = `${canonical(ref)}|${product}`;
        if (tankIdCache.has(ck)) return tankIdCache.get(ck) ?? null;
        const id = pinnedTankId
          ? (await resolveExistingTank(sb, ref)) ?? pinnedTankId
          : await resolveOrCreateTank(sb, ref, product);
        tankIdCache.set(ck, id);
        return id;
      };
      // Already-on-file keys per resolved tank, loaded once each. The same
      // `runTicketKey` the scan-time suppression pass uses, so "not shown" and
      // "not written" agree; it also collapses in-batch duplicates.
      const seenByTank = new Map<string, Set<string>>();
      const seenFor = async (tankId: string): Promise<Set<string>> => {
        let s = seenByTank.get(tankId);
        if (!s) {
          s = await existingRunTicketKeys(sb, tankId);
          seenByTank.set(tankId, s);
        }
        return s;
      };
      let skipped = 0;
      for (const r of rows) {
        const tankId = await resolveTank(r.tankRef, r.product);
        if (!tankId) {
          skipped++;
          continue;
        }
        const seen = await seenFor(tankId);
        const key = runTicketKey(r.ticketNo, r.date, r.netBbls ?? r.grossBbls);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        // A run REMOVES oil, so the opening (pre-haul) gauge must be >= the
        // closing (post-haul) gauge. If the source inverted them, swap so the
        // derived level drop (and production) is never spuriously negative.
        let openingGauge = r.openingGauge;
        let closingGauge = r.closingGauge;
        if (
          openingGauge != null &&
          closingGauge != null &&
          openingGauge < closingGauge
        ) {
          [openingGauge, closingGauge] = [closingGauge, openingGauge];
        }
        const list = byTank.get(tankId) ?? [];
        list.push({
          date: r.date,
          departureTime: r.departureTime || undefined,
          ticketNo: r.ticketNo || undefined,
          ticketType: r.ticketType,
          grossBbls: r.grossBbls,
          netBbls: r.netBbls,
          apiGravity: r.apiGravity,
          bsW: r.bsW,
          openingGauge,
          closingGauge,
          purchaser: r.purchaser || undefined,
          transporter: r.transporter || undefined,
          product: r.product,
        });
        byTank.set(tankId, list);
      }
      let added = 0;
      for (const [tankId, inputs] of byTank) {
        const { created } = await addRunTickets(tankId, inputs);
        added += created;
      }
      return { added, skipped };
    }

    case "downtime": {
      if (!wellId) throw new Error("A well is required for downtime.");
      const rows = z.array(downtimeRow).parse(rawRows);
      const sb = await getSupabaseServer();
      // Dedup on start + end + type: the same downtime/shut-in period must not be
      // recorded twice.
      const { data: existing } = await sb
        .from("well_events")
        .select("event_type, start_date, end_date")
        .eq("well_id", wellId);
      const seen = new Set(
        (
          (existing ?? []) as {
            event_type: string;
            start_date: string;
            end_date: string | null;
          }[]
        ).map((e) => downtimeKey(e.start_date, e.end_date, e.event_type))
      );
      let skipped = 0;
      for (const r of rows) {
        const key = downtimeKey(r.startDate, r.endDate || null, r.eventType);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        await addWellEvent(sb, wellId, {
          eventType: r.eventType,
          startDate: r.startDate,
          endDate: r.endDate || null,
          daysApplied: r.daysApplied,
          reason: r.reason,
        });
      }
      return { added: rows.length - skipped, skipped };
    }

    case "wellTests": {
      if (!wellId) throw new Error("A well is required for well tests.");
      const rows = z.array(wellTestRow).parse(rawRows);
      const sb = await getSupabaseServer();
      // well_tests is unique on (well_id, test_date); skip dates already present
      // so one duplicate row doesn't abort the whole batch.
      const { data: existing } = await sb
        .from("well_tests")
        .select("test_date")
        .eq("well_id", wellId);
      const seen = new Set(
        ((existing ?? []) as { test_date: string }[]).map((e) => e.test_date)
      );
      let skipped = 0;
      for (const r of rows) {
        if (seen.has(r.testDate)) {
          skipped++;
          continue;
        }
        // Documents carry a test date + duration, not clock times; convert to a
        // start/end span (midnight to midnight + duration) at the write boundary.
        const days = r.durationDays && r.durationDays > 0 ? r.durationDays : 1;
        const startAt = `${r.testDate}T00:00:00Z`;
        const endAt = new Date(
          Date.parse(startAt) + days * 86_400_000
        ).toISOString();
        await createWellTest(wellId, {
          startAt,
          endAt,
          oilBbls: r.oilBbls,
          gasMcf: r.gasMcf,
          waterBbls: r.waterBbls,
          preTestShutInDays: r.preTestShutInDays,
          notes: r.notes,
        });
        seen.add(r.testDate);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "shots": {
      if (!wellId) throw new Error("A well is required for fluid-level shots.");
      const rows = z.array(shotRow).parse(rawRows);
      // well_shots has no unique constraint, so dedup is entirely ours: date +
      // time + level (see shotKey — two same-day shots at different levels are
      // two shots, not a duplicate).
      const existing = await fetchWellShots(wellId);
      const seen = new Set(
        existing.map((s) => shotKey(s.date, s.time, s.fluidLevelFt))
      );
      let skipped = 0;
      for (const r of rows) {
        const key = shotKey(r.date, r.time, r.fluidLevelFt);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        // The pump depth `shotRow` may have read off the document is dropped
        // here. A shot no longer carries one: the depth is resolved from
        // `well_pumping` in force on the shot's date
        // (`2026083000100_well_pumping.sql`), and writing a one-off pump depth
        // from a document would be a second answer to what that table answers.
        await addWellShotRow(wellId, {
          date: r.date,
          time: r.time,
          fluidLevelFt: r.fluidLevelFt,
          notes: r.notes,
        });
      }
      return { added: rows.length - skipped, skipped };
    }

    case "wellNotes": {
      if (!wellId) throw new Error("A well is required for notes.");
      const rows = z.array(wellNoteRow).parse(rawRows);
      const sb = await getSupabaseServer();
      const well = (await getWells()).find((w) => w.id === wellId);
      // Existing notes are compared on their PLAIN TEXT, since the stored body
      // is HTML and the proposed one is not. `snippet` is capped at 200 chars,
      // so the comparison is on the same prefix on both sides.
      const existingNotes = await listNotesForTarget(sb, "well", wellId);
      const seen = new Set(
        existingNotes.map((n) => noteKey(n.title, n.snippet))
      );
      let skipped = 0;
      for (const r of rows) {
        const body = r.body.trim();
        if (!body) {
          skipped++;
          continue;
        }
        // A blank title falls back to the note's own first line, so the notes
        // list never shows a wall of "Untitled" cards from one upload.
        const title =
          r.title.trim() || body.split("\n")[0].trim().slice(0, 80) || "Untitled";
        const content = htmlFromPlainText(
          r.date ? `${r.date}\n\n${body}` : body
        );
        const key = noteKey(title, snippetFromHtml(content));
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        // Two calls by necessity: `createNote` always seeds an empty note (the
        // editor creates lazily and fills in afterwards), so the title and body
        // land via `saveNote`.
        const { id } = await createNote([
          {
            type: "well",
            id: wellId,
            label: well?.name ?? wellId,
            kind: "facility",
          },
        ]);
        await saveNote(id, { title, content });
      }
      revalidatePath(`/wells/${wellId}`);
      return { added: rows.length - skipped, skipped };
    }

    case "gasTests": {
      if (!wellId) throw new Error("A well is required for gas tests.");
      const rows = z.array(gasTestRow).parse(rawRows);
      // A gas test is a reading on a METER's campaign, not a standalone well
      // record: it needs a gas meter this well feeds, that meter's open (draft)
      // campaign, and that campaign's all-wells-online baseline. The baseline is
      // a property of the meter and is recorded on the meter page, so a row with
      // nowhere to land is SKIPPED rather than written into a half-formed
      // campaign the allocation engine could not use.
      const targets = await getWellGasTestTargets(wellId);
      let skipped = 0;
      let added = 0;
      for (const r of rows) {
        const ref = canonical(r.meterRef);
        const target = ref
          ? (targets.find((t) => canonical(t.meterName) === ref) ??
            targets.find((t) => canonicalId(t.meterName) === canonicalId(r.meterRef)))
          : // No meter named: unambiguous only when the well feeds exactly one.
            (targets.length === 1 ? targets[0] : undefined);
        if (!target?.openCampaignId || target.baselineRate == null) {
          skipped++;
          continue;
        }
        const startAt = combineStamp(r.startDate, r.startTime);
        const endAt = combineStamp(r.endDate, r.endTime);
        const span = startAt && endAt ? spanDays(startAt, endAt) : null;
        if (span == null) {
          skipped++;
          continue;
        }
        // Same two modes the well page's Gas test modal offers: a printed rate,
        // or one derived from the meter's open/close reading over the window.
        const rate =
          r.mcfPerDay ??
          (r.openReading != null && r.closeReading != null
            ? (r.closeReading - r.openReading) / span
            : null);
        if (rate == null || !Number.isFinite(rate)) {
          skipped++;
          continue;
        }
        // Replaces this well's existing reading on the campaign rather than
        // appending, so re-filing a corrected sheet fixes it instead of
        // double-counting.
        await recordWellGasShutIn(wellId, target.meterId, target.openCampaignId, {
          startAt,
          endAt,
          mcfPerDay: rate,
        });
        added++;
      }
      if (skipped > 0) {
        ilog("write: gas tests skipped", {
          wellId,
          skipped,
          reason: "no open campaign with a baseline, or an unusable window/rate",
        });
      }
      return { added, skipped };
    }

    case "meterVolumes": {
      const rows = z.array(meterVolumeRow).parse(rawRows);
      const sb = await getSupabaseServer();
      // Dedup on date + purchaser per meter (same grain as the gas-settlement
      // import's `settleKey`): the same volume settlement must not be filed
      // twice. Existing keys are loaded once per resolved meter.
      const seenByMeter = new Map<string, Set<string>>();
      const seenFor = async (meterId: string): Promise<Set<string>> => {
        let seen = seenByMeter.get(meterId);
        if (!seen) {
          const existing = await listMeterVolumeStatements(sb, meterId);
          seen = new Set(existing.map((s) => meterVolumeKey(s.date, s.purchaser)));
          seenByMeter.set(meterId, seen);
        }
        return seen;
      };
      let added = 0;
      let skipped = 0;
      for (const r of rows) {
        const meterId = await resolveOrCreateMeter(sb, r.meterRef);
        if (!meterId) {
          skipped++;
          continue;
        }
        const seen = await seenFor(meterId);
        const key = meterVolumeKey(r.date, r.purchaser || "");
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        // The thin generic meterVolumes row carries the sold volume/energy and a
        // single net value; map them onto the settlement's residue + net fields.
        // (The richer gas-settlement import fills gross/NGL/fees separately.)
        await addMeterVolumeStatement(sb, meterId, {
          date: r.date,
          statementNo: r.statementNo || undefined,
          purchaser: r.purchaser || undefined,
          residueMcf: r.volumeMcf,
          residueMmbtu: r.mmbtu,
          netValue: r.value,
        });
        added++;
      }
      return { added, skipped };
    }

    // --- People (directory) --------------------------------------------------

    case "gatherers": {
      const rows = z.array(gathererRow).parse(rawRows);
      const seen = new Set((await getGatherers()).map((g) => canonical(g.name)));
      let skipped = 0;
      for (const r of rows) {
        const key = canonical(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await createGatherer(r);
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "purchasers": {
      const rows = z.array(purchaserRow).parse(rawRows);
      // The app's buyer directory IS the gatherers table — the People page shows
      // it under the "Purchasers" tab, and it's where a gas gatherer lands too.
      // File the crude purchaser there so it actually shows up in the app (the
      // statement's own purchaser_id is created separately when the runs are
      // filed). Dedup by name against existing gatherers.
      const seen = new Set((await getGatherers()).map((g) => canonical(g.name)));
      let skipped = 0;
      for (const r of rows) {
        const key = canonical(r.name);
        if (!key || seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        await createGatherer({
          name: r.name.trim(),
          phone: r.phone,
          email: r.email,
          status: "Active",
          description: r.contactName ? `Contact: ${r.contactName}` : "",
        });
      }
      return { added: rows.length - skipped, skipped };
    }

    case "employees": {
      const rows = z.array(employeeRow).parse(rawRows);
      const seen = new Set((await getEmployees()).map((e) => canonical(e.name)));
      let skipped = 0;
      for (const r of rows) {
        const key = canonical(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await createEmployee(r);
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    // --- Leases & interest ---------------------------------------------------

    case "leases": {
      const rows = z.array(leaseRow).parse(rawRows);
      /*
       * Dedup through the SHARED matcher (`leaseIsOnFile`), on both the lease
       * number and the name. Gas leases have no printed number, so they would
       * all collide on lease_no = "" (the unique constraint is (org_id,
       * lease_no)); the name is the identifier that survives.
       *
       * Asking the matcher rather than a private key is the point. When the two
       * differed, "Johnson #2" failed to match at extraction, was proposed as a
       * card, and was then skipped here as a duplicate: a card that created
       * nothing (docs/plans/statement-lease-matching.md, phase 3).
       */
      const onFile: MatchTarget[] = (await getLeases()).map((l) => ({
        id: l.id,
        number: l.leaseNo,
        name: l.name,
      }));
      let skipped = 0;
      for (const r of rows) {
        const leaseNo = r.leaseNo.trim() || r.name.trim();
        if (!leaseKey(leaseNo) && !leaseKey(r.name)) {
          skipped++; // nothing to identify the lease by
          continue;
        }
        if (leaseIsOnFile({ leaseNo, name: r.name }, onFile)) {
          skipped++;
          continue;
        }
        const created = await addLease({
          leaseNo,
          name: r.name,
          county: r.county,
          active: r.active,
        });
        // In-batch, so a document naming one lease twice creates it once.
        onFile.push({ id: created.id, number: leaseNo, name: r.name });
      }
      return { added: rows.length - skipped, skipped };
    }

    case "leaseInterest": {
      const rows = z.array(leaseInterestRow).parse(rawRows);
      const sb = await getSupabaseServer();
      const leases = await getLeases();
      const owners = await getRoyaltyOwners();
      // The org's own companies are matched BEFORE the People directory: a
      // statement that names one of the user's entities is recording the
      // user's own interest, and resolving it to a same-named royalty owner
      // would schedule a distribution to the user themselves.
      const wiOwners = await listOrgWiOwners();
      let added = 0;
      let skipped = 0;
      for (const r of rows) {
        const refC = canonical(r.leaseRef);
        const lease = leases.find(
          (l) => canonical(l.leaseNo) === refC || canonical(l.name) === refC
        );
        if (!lease) {
          skipped++;
          continue;
        }
        if (r.isOperator || !r.ownerName.trim()) {
          await upsertOperatorInterest(sb, lease.id, {
            workingInterest: r.workingInterest,
            netRevenueInterest: r.netRevenueInterest,
          });
          added++;
          continue;
        }
        const values = {
          interestType: r.interestType,
          workingInterest: r.workingInterest,
          netRevenueInterest: r.netRevenueInterest,
        };
        const wiOwner = wiOwners.find(
          (o) => canonical(o.name) === canonical(r.ownerName)
        );
        if (wiOwner) {
          await addWiOwnerInterest(sb, lease.id, wiOwner.id, values);
          added++;
          continue;
        }
        const owner = owners.find(
          (o) => canonical(o.name) === canonical(r.ownerName)
        );
        if (!owner) {
          skipped++;
          continue;
        }
        await addLeaseInterest(sb, lease.id, owner.id, values);
        added++;
      }
      return { added, skipped };
    }

    case "leaseUseGas": {
      if (!wellId) throw new Error("A well is required for lease-use gas.");
      const rows = z.array(leaseUseGasRow).parse(rawRows);
      const sb = await getSupabaseServer();
      for (const r of rows) {
        await setLeaseUseGas(sb, wellId, r.month, r.leaseUseMcf);
      }
      return { added: rows.length, skipped: 0 };
    }

    // --- Wells (entities) ----------------------------------------------------

    case "wells": {
      const rows = z.array(wellRow).parse(rawRows);
      const seen = new Set((await getWells()).map((w) => canonical(w.name)));
      let skipped = 0;
      for (const r of rows) {
        const key = canonical(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await createWell({
          name: r.name,
          type: "producer",
          formation: r.formation,
          county: r.county,
          depth: r.depth,
          perforations: r.perforations,
          dateDrilled: r.dateDrilled,
          coordinates: r.coordinates,
        });
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "injectionWells": {
      const rows = z.array(injectionWellRow).parse(rawRows);
      const seen = new Set((await getWells()).map((w) => canonical(w.name)));
      let skipped = 0;
      for (const r of rows) {
        const key = canonical(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await createInjectionWell(r.name);
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    // --- Tanks & meters (entities) -------------------------------------------

    case "tanks": {
      const rows = z.array(tankRow).parse(rawRows);
      const sb = await getSupabaseServer();
      const seen = new Set(
        (await listTanks(sb)).map((t) =>
          t.tankNo ? canonicalId(t.tankNo) : canonical(t.name)
        )
      );
      let skipped = 0;
      // Resolved once for the batch, as the gas-settlement write does it: the
      // lease NAMES the tank ("Roach T123") and the gatherer is who buys off
      // it, so a card that shows both must land both. Leases are matched, never
      // created here — an unresolved lease leaves the tank unassigned, which is
      // the recoverable outcome and the one the `leases` card exists to fix.
      const leaseTargets: MatchTarget[] = (await getLeases()).map((l) => ({
        id: l.id,
        number: l.leaseNo,
        name: l.name,
      }));
      const gathererCache = await getGatherers();
      for (const r of rows) {
        const key = r.tankNo ? canonicalId(r.tankNo) : canonical(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        const gathererId = r.gatherer
          ? await resolveOrCreateGatherer(gathererCache, r.gatherer, "", "")
          : null;
        await addTank({
          product: r.product,
          // No stored name: an extracted row that carried only a name keeps it
          // as the tank's number, which is the half of the name we do store.
          tankNo: r.tankNo || r.name || undefined,
          leaseId: r.lease ? matchLease(r.lease, leaseTargets) : null,
          gathererId,
          battery: r.battery || undefined,
          bblPerInch: r.bblPerInch || 1,
          capacityBbls: r.capacityBbls,
          active: r.active,
        });
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "meters": {
      const rows = z.array(meterRow).parse(rawRows);
      const sb = await getSupabaseServer();
      const seen = new Set(
        (await listMeters(sb)).map((m) =>
          m.meterNo ? canonicalId(m.meterNo) : canonical(m.name)
        )
      );
      let skipped = 0;
      // Resolved once for the batch, the same way the gas-settlement write
      // does it, so a settlement's meters all land under one gatherer record.
      const gathererCache = await getGatherers();
      // The lease is the other half of a meter's name ("Dofflemeyer M1234"), so
      // it lands the same way a tank's does: matched, never created.
      const leaseTargets: MatchTarget[] = (await getLeases()).map((l) => ({
        id: l.id,
        number: l.leaseNo,
        name: l.name,
      }));
      for (const r of rows) {
        const key = r.meterNo ? canonicalId(r.meterNo) : canonical(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        // `meterRow` has always carried the gatherer and the write had always
        // dropped it, so a card showing "Targa Midstream" created a meter
        // belonging to nobody — and the field the user could correct on the
        // card was the one that did not land.
        const gathererId = r.gatherer
          ? await resolveOrCreateGatherer(gathererCache, r.gatherer, "", "")
          : null;
        await addMeter({
          // No stored name: an extracted row that carried only a name keeps it
          // as the meter's number, which is the half of the name we do store.
          meterNo: r.meterNo || r.name || undefined,
          leaseId: r.lease ? matchLease(r.lease, leaseTargets) : null,
          gathererId,
          active: r.active,
        });
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    case "batteries": {
      const rows = z.array(batteryRow).parse(rawRows);
      const seen = new Set((await getBatteries()).map((b) => canonical(b.name)));
      let skipped = 0;
      for (const r of rows) {
        const key = canonical(r.name);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        await addBattery({ name: r.name, active: r.active });
        seen.add(key);
      }
      return { added: rows.length - skipped, skipped };
    }

    // --- Device readings (create-or-resolve the device) ----------------------

    case "tankReadings": {
      // A combined "date time" cell (edited grid or non-tabular extraction) keeps
      // its clock time via liftReadingTime before the schema strips it off `date`.
      const rows = z.array(tankReadingRow).parse((rawRows as unknown[]).map(liftReadingTime));
      const sb = await getSupabaseServer();
      // tank_readings is unique on (tank_id, reading_date, reading_time); skip a
      // reading already present (in the DB or earlier in this batch) so one
      // duplicate doesn't abort the whole approval. Existing keys are loaded once
      // per resolved tank.
      const seenByTank = new Map<string, Set<string>>();
      const seenFor = async (tankId: string): Promise<Set<string>> => {
        let seen = seenByTank.get(tankId);
        if (!seen) {
          const { data } = await sb
            .from("tank_readings")
            .select("reading_date, reading_time")
            .eq("tank_id", tankId)
            .is("deleted_at", null);
          seen = new Set(
            (
              (data ?? []) as {
                reading_date: string;
                reading_time: string | null;
              }[]
            ).map((e) => `${e.reading_date}|${normHhmm(e.reading_time)}`)
          );
          seenByTank.set(tankId, seen);
        }
        return seen;
      };
      // Resolve each distinct tank ONCE (re-listing tanks per row is wasteful).
      // A pinned (tank-scoped Add History) upload can still hold sections for
      // several tanks, so route each row by its printed ref: a ref that names a
      // DIFFERENT existing tank wins; a blank/unknown ref falls back to the
      // pinned workspace tank. Pinned uploads never auto-create a tank.
      const tankIdCache = new Map<string, string | null>();
      const resolveTank = async (ref: string): Promise<string | null> => {
        const ck = canonical(ref);
        if (tankIdCache.has(ck)) return tankIdCache.get(ck) ?? null;
        const id = pinnedTankId
          ? (await resolveExistingTank(sb, ref)) ?? pinnedTankId
          : await resolveOrCreateTank(sb, ref, "oil");
        tankIdCache.set(ck, id);
        return id;
      };

      // Build the insert set, deduping against the DB and within this batch, then
      // write it in bulk (one round trip per chunk) instead of row-by-row.
      const toInsert: { tankId: string; reading: TankReadingInput }[] = [];
      let skipped = 0;
      for (const r of rows) {
        const tankId = await resolveTank(r.tankRef);
        if (!tankId) {
          skipped++;
          continue;
        }
        const seen = await seenFor(tankId);
        const key = `${r.date}|${normHhmm(r.time)}`;
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        toInsert.push({
          tankId,
          reading: {
            date: r.date,
            time: r.time || undefined,
            gauge: r.gauge,
            pulledBottom: r.pulledBottom ?? undefined,
            waterHauled: r.waterHauled ?? undefined,
            hotOil: r.hotOil ?? undefined,
          },
        });
      }

      let added = 0;
      try {
        added = await addTankReadings(sb, toInsert);
      } catch (err) {
        // Backstop for a slot taken concurrently: a chunk's bulk insert hit a
        // duplicate key. Fall back to per-row inserts, skipping the duplicates.
        if (!isDuplicateKeyError(err)) throw err;
        added = 0;
        for (const item of toInsert) {
          try {
            await addTankReading(sb, item.tankId, item.reading);
            added++;
          } catch (e) {
            if (isDuplicateKeyError(e)) skipped++;
            else throw e;
          }
        }
      }
      return { added, skipped };
    }

    case "meterReadings": {
      // A combined "date time" cell (edited grid or non-tabular extraction) keeps
      // its clock time via liftReadingTime before the schema strips it off `date`.
      const rows = z.array(meterReadingRow).parse((rawRows as unknown[]).map(liftReadingTime));
      const sb = await getSupabaseServer();
      // meter_readings is unique on (meter_id, reading_date, reading_time); skip
      // a reading already present (DB or earlier in this batch) so one duplicate
      // doesn't abort the whole approval. Existing keys load once per meter.
      const seenByMeter = new Map<string, Set<string>>();
      const seenFor = async (meterId: string): Promise<Set<string>> => {
        let seen = seenByMeter.get(meterId);
        if (!seen) {
          const { data } = await sb
            .from("meter_readings")
            .select("reading_date, reading_time")
            .eq("meter_id", meterId)
            .is("deleted_at", null);
          seen = new Set(
            (
              (data ?? []) as {
                reading_date: string;
                reading_time: string | null;
              }[]
            ).map((e) => `${e.reading_date}|${normHhmm(e.reading_time)}`)
          );
          seenByMeter.set(meterId, seen);
        }
        return seen;
      };
      // Resolve each distinct meter ONCE, then dedup + bulk-insert (one round trip
      // per chunk) rather than a sequential insert per row. A pinned meter (meter
      // Add History) skips resolution entirely so the write can't land on a
      // different meter or auto-create a stray one.
      const meterIdCache = new Map<string, string | null>();
      const resolveMeter = async (ref: string): Promise<string | null> => {
        if (pinnedMeterId) return pinnedMeterId;
        const ck = canonical(ref);
        if (meterIdCache.has(ck)) return meterIdCache.get(ck) ?? null;
        const id = await resolveOrCreateMeter(sb, ref);
        meterIdCache.set(ck, id);
        return id;
      };

      const toInsert: { meterId: string; reading: MeterReadingInput }[] = [];
      const touched = new Set<string>();
      let skipped = 0;
      for (const r of rows) {
        const meterId = await resolveMeter(r.meterRef);
        if (!meterId) {
          skipped++;
          continue;
        }
        const seen = await seenFor(meterId);
        const key = `${r.date}|${normHhmm(r.time)}`;
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        touched.add(meterId);
        // A row with none of the three numbers is not a reading: it would pin a
        // timestamp on the meter, contribute nothing, and cut whatever span it
        // landed in.
        if (r.mcf == null && r.cumulativeMcf == null && r.yesterdayMcf == null) {
          skipped++;
          continue;
        }
        toInsert.push({
          meterId,
          reading: {
            date: r.date,
            time: r.time || undefined,
            mcf: r.mcf,
            cumulativeMcf: r.cumulativeMcf,
            yesterdayMcf: r.yesterdayMcf,
          },
        });
      }

      let added = 0;
      try {
        added = await addMeterReadings(sb, toInsert);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        added = 0;
        for (const item of toInsert) {
          try {
            await addMeterReading(sb, item.meterId, item.reading);
            added++;
          } catch (e) {
            if (isDuplicateKeyError(e)) skipped++;
            else throw e;
          }
        }
      }
      // Revalidate each affected meter once (bulk insert skipped the per-row
      // revalidation the single-row helper did).
      for (const meterId of touched) {
        revalidatePath("/production");
        revalidatePath("/production/meters", "layout");
      }
      return { added, skipped };
    }

    // --- Disposal ------------------------------------------------------------

    case "disposalReadings": {
      if (!wellId) throw new Error("A well is required for disposal readings.");
      const rows = z.array(disposalReadingRow).parse(rawRows);
      const sb = await getSupabaseServer();
      // Skip readings already on file BEFORE the insert. `disposal_readings` is
      // unique on (well, date, time), so without this an approval overlapping
      // existing rows didn't skip them — it threw the constraint error and
      // failed the whole batch. `readingKey` also folds a blank time to 00:00,
      // which the DB index cannot (two NULL times don't collide in Postgres),
      // so same-date-no-time repeats are caught here too.
      const { data: existing } = await sb
        .from("disposal_readings")
        .select("reading_date, reading_time")
        .eq("injection_well_id", wellId);
      const seen = new Set(
        (
          (existing ?? []) as {
            reading_date: string;
            reading_time: string | null;
          }[]
        ).map((e) => readingKey(e.reading_date, e.reading_time))
      );
      const wells = await getWells();
      const inputs = [];
      for (const r of rows) {
        // `skipped` in the return is derived from `added`, so a row the insert
        // itself declines is counted the same as one deduped here.
        const key = readingKey(r.date, r.time);
        if (seen.has(key)) continue;
        seen.add(key);
        const src = r.sourceWellRef.trim()
          ? wells.find((w) => canonical(w.name) === canonical(r.sourceWellRef))
          : null;
        inputs.push({
          date: r.date,
          time: r.time || undefined,
          injectedBbls: r.injectedBbls,
          injectionPressure: r.injectionPressure,
          casingPressure: r.casingPressure,
          meterReading: r.meterReading,
          sourceWellId: src?.id ?? null,
          notes: r.notes || undefined,
        });
      }
      const added = inputs.length > 0 ? await addDisposalReadings(wellId, inputs) : 0;
      return { added, skipped: rows.length - added };
    }

    // --- Dedicated documents -------------------------------------------------

    case "oilRunStatement":
      return writeOilRunStatements(rawRows, fileId);

    case "gasSettlementStatement":
      return writeGasSettlements(rawRows, fileId);
    case "vendorInvoice":
      return writeVendorInvoices(rawRows, fileId);
  }
}

/**
 * Approve a proposal: write its (possibly edited) rows to the real tables. The
 * capability for the type is re-checked here as defense in depth (RLS enforces
 * it again on the write). Well-types need a resolved well — from the verbatim
 * match, or the picker the user set in the modal (`wellId`).
 */
export async function approveIngestProposal(
  id: string,
  input: { rows: unknown[]; wellId?: string | null }
): Promise<ApproveResult> {
  const sb = await getSupabaseServer();
  const { data: p, error } = await sb
    .from("ingest_proposals")
    .select("id, type, well_id, tank_id, meter_id, file_id, status")
    .eq("id", id)
    .maybeSingle();
  if (error || !p) return { ok: false, error: "Proposal not found." };
  if (p.status !== "pending") {
    return { ok: false, error: "This proposal is no longer pending." };
  }

  const type = p.type as IngestType;
  const meta = INGEST_TYPE_META[type];
  if (!(await userCan(meta.capability as PermissionKey))) {
    return { ok: false, error: "You don't have permission to add these." };
  }

  const wellId = (input.wellId ?? (p.well_id as string | null)) || null;
  if (meta.needsWell && !wellId) {
    return { ok: false, error: "Choose a well before approving." };
  }

  const fileId = (p.file_id as string | null) ?? null;
  const tankId = (p.tank_id as string | null) ?? null;
  const meterId = (p.meter_id as string | null) ?? null;
  const rowCount = Array.isArray(input.rows) ? input.rows.length : 0;
  ilog("approve: begin", {
    id,
    type,
    rows: rowCount,
    wellId,
    fileId,
    tankId,
    meterId,
  });
  const approveStart = Date.now();
  try {
    const { added, updated, skipped } = await dispatchWrite(
      type,
      input.rows,
      wellId,
      fileId,
      tankId,
      meterId
    );
    await sb
      .from("ingest_proposals")
      .update({ status: "approved" })
      .eq("id", id);

    // A record other rows were waiting on now exists, so the invoices that
    // could not resolve it when they were filed are re-pointed at it here. See
    // `relinkInvoiceVendors` / `relinkInvoiceProperties`: without this, the
    // vendor sits in People while the invoice it came from still reads as
    // unresolved.
    try {
      if (type === "serviceProviders") await relinkInvoiceVendors(sb);
      if (type === "wells" || type === "injectionWells" || type === "leases") {
        await relinkInvoiceProperties(sb);
      }
    } catch (err) {
      ierr("approve: invoice relink failed", { id, type, ...errorInfo(err) });
    }
    ilog("approve: done", {
      id,
      type,
      added,
      updated,
      skipped,
      ms: Date.now() - approveStart,
    });
    return { ok: true, added, updated, skipped };
  } catch (err) {
    ierr("approve: FAILED", {
      id,
      type,
      ms: Date.now() - approveStart,
      ...errorInfo(err),
    });
    const message =
      err instanceof Error ? err.message : "Failed to add the records.";
    return { ok: false, error: message };
  }
}

/** Dismiss a proposal without writing anything. */
export async function dismissIngestProposal(
  id: string
): Promise<{ ok: boolean }> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("ingest_proposals")
    .update({ status: "dismissed" })
    .eq("id", id);
  if (error) {
    console.error("dismissIngestProposal failed", error.message);
    return { ok: false };
  }
  return { ok: true };
}
