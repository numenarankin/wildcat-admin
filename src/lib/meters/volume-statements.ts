import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Meter SETTLEMENTS — the gatherer's gas settlement for a meter. On a POP
 * (percentage-of-proceeds) plant statement the producer is paid for TWO revenue
 * streams — residue gas and plant products (NGLs) — minus plant fees, netting to
 * the total producer payment; the statement also reports gross wellhead vs
 * residue-sold volumes. DOCUMENTATION ONLY: settlements never feed production
 * math (the pumper's daily MCF readings are the source of truth); they're kept
 * for reconciliation against the gatherer's statement.
 *
 * Same client-injected RLS idiom as the rest of `@/lib/meters/*`. Soft-deleted
 * rather than hard-deleted so a voided settlement leaves a record.
 */

/** A gatherer / purchaser gas settlement for a meter. All money/volume figures
 * are nullable — a given statement may not print every one. */
export interface VolumeStatement {
  id: string;
  meterId: string;
  /** Statement date as an ISO `YYYY-MM-DD` string (period end). */
  date: string;
  statementNo: string;
  /** Gatherer / purchaser named on the statement. */
  purchaser: string;
  /** Gross wellhead gas, MCF. */
  grossMcf: number | null;
  /** Gross wellhead energy, MMBtu. */
  grossMmbtu: number | null;
  /** Residue gas actually SOLD, MCF. */
  residueMcf: number | null;
  /** Residue gas actually SOLD, MMBtu. */
  residueMmbtu: number | null;
  /** Residue price, $/MMBtu. */
  residuePrice: number | null;
  /** Residue gas value, $. */
  residueValue: number | null;
  /** Plant products (NGL) total value, $. */
  nglValue: number | null;
  /** Plant fees / deducts, $. */
  fees: number | null;
  /** Total producer payment (net), $ = residue + NGL − fees. */
  netValue: number | null;
}

/** A settlement as supplied by the UI / import, before it has a row id. */
export interface VolumeStatementInput {
  date: string;
  statementNo?: string;
  purchaser?: string;
  grossMcf?: number | null;
  grossMmbtu?: number | null;
  residueMcf?: number | null;
  residueMmbtu?: number | null;
  residuePrice?: number | null;
  residueValue?: number | null;
  nglValue?: number | null;
  fees?: number | null;
  netValue?: number | null;
}

type Sb = SupabaseClient;

const STATEMENT_COLS =
  "id, meter_id, statement_date, statement_no, purchaser, " +
  "gross_mcf, gross_mmbtu, residue_mcf, residue_mmbtu, residue_price, " +
  "residue_value, ngl_value, fees, net_value, " +
  // Legacy columns, read for back-compat and mapped forward below.
  "volume_mcf, mmbtu, value";

interface StatementRow {
  id: string;
  meter_id: string;
  statement_date: string;
  statement_no: string | null;
  purchaser: string | null;
  gross_mcf: number | null;
  gross_mmbtu: number | null;
  residue_mcf: number | null;
  residue_mmbtu: number | null;
  residue_price: number | null;
  residue_value: number | null;
  ngl_value: number | null;
  fees: number | null;
  net_value: number | null;
  // Legacy.
  volume_mcf: number | null;
  mmbtu: number | null;
  value: number | null;
}

function mapStatement(r: StatementRow): VolumeStatement {
  return {
    id: r.id,
    meterId: r.meter_id,
    date: r.statement_date,
    statementNo: r.statement_no ?? "",
    purchaser: r.purchaser ?? "",
    grossMcf: r.gross_mcf,
    grossMmbtu: r.gross_mmbtu,
    // Legacy rows stored the sold volume/energy in volume_mcf/mmbtu and the net
    // in value; surface them as residue/net when the new columns are unset.
    residueMcf: r.residue_mcf ?? r.volume_mcf,
    residueMmbtu: r.residue_mmbtu ?? r.mmbtu,
    residuePrice: r.residue_price,
    residueValue: r.residue_value,
    nglValue: r.ngl_value,
    fees: r.fees,
    netValue: r.net_value ?? r.value,
  };
}

/** A meter's volume statements (excluding soft-deleted), newest first. */
export async function listMeterVolumeStatements(
  sb: Sb,
  meterId: string
): Promise<VolumeStatement[]> {
  const { data, error } = await sb
    .from("meter_volume_statements")
    .select(STATEMENT_COLS)
    .eq("meter_id", meterId)
    .is("deleted_at", null)
    .order("statement_date", { ascending: false });
  if (error) throw new Error(`listMeterVolumeStatements: ${error.message}`);
  return ((data ?? []) as unknown as StatementRow[]).map(mapStatement);
}

/** Record a settlement on a meter; returns its id. Net defaults to
 * residue + NGL − fees when not supplied but the parts are. */
export async function addMeterVolumeStatement(
  sb: Sb,
  meterId: string,
  input: VolumeStatementInput
): Promise<{ id: string }> {
  const net =
    input.netValue ??
    (input.residueValue != null || input.nglValue != null
      ? (input.residueValue ?? 0) + (input.nglValue ?? 0) - (input.fees ?? 0)
      : null);
  const { data, error } = await sb
    .from("meter_volume_statements")
    .insert({
      meter_id: meterId,
      statement_date: input.date,
      statement_no: input.statementNo?.trim() || null,
      purchaser: input.purchaser?.trim() || null,
      gross_mcf: input.grossMcf ?? null,
      gross_mmbtu: input.grossMmbtu ?? null,
      residue_mcf: input.residueMcf ?? null,
      residue_mmbtu: input.residueMmbtu ?? null,
      residue_price: input.residuePrice ?? null,
      residue_value: input.residueValue ?? null,
      ngl_value: input.nglValue ?? null,
      fees: input.fees ?? null,
      net_value: net,
    })
    .select("id")
    .single();
  if (error) throw new Error(`addMeterVolumeStatement: ${error.message}`);
  return { id: data.id };
}

/** Soft-delete a volume statement (stamps `deleted_at/by`), scoped to its meter. */
export async function softDeleteMeterVolumeStatement(
  sb: Sb,
  meterId: string,
  id: string,
  deletedBy: string | null = null
): Promise<void> {
  const { error } = await sb
    .from("meter_volume_statements")
    .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
    .eq("id", id)
    .eq("meter_id", meterId);
  if (error) throw new Error(`softDeleteMeterVolumeStatement: ${error.message}`);
}
