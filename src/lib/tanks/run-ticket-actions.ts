"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { signRunTicketFile } from "@/lib/tanks/run-ticket-file";
import { userCan } from "@/lib/auth/permissions";
import {
  createRunTicket,
  createRunTickets,
  listAllRunTickets,
  listPurchasers,
  listTankTickets,
  softDeleteRunTicket,
  updateRunTicket,
  type Purchaser,
  type RunTicket,
  type RunTicketInput,
  type RunTicketPatch,
} from "@/lib/tanks/run-tickets";

/**
 * Server actions for run tickets — thin wrappers over `@/lib/tanks/run-tickets`
 * that run through the request-scoped RLS client (org ownership enforced by
 * RLS). The tank UI (via the run-tickets panel) and the reports View modal call
 * these; the data-access layer stays client-injectable for tests.
 */

/** A tank's run tickets, newest first (for the tank-detail panel). */
export async function getTankTickets(tankId: string): Promise<RunTicket[]> {
  const sb = await getSupabaseServer();
  return listTankTickets(sb, tankId);
}

/**
 * Every run ticket in the org — backs the Transport Tickets View modal.
 * Capability-gated (`view_well_production`); returns [] when not permitted.
 */
export async function getAllRunTickets(): Promise<RunTicket[]> {
  if (!(await userCan("view_well_production"))) return [];
  const sb = await getSupabaseServer();
  return listAllRunTickets(sb);
}

/** Purchasers in the org, for the ticket form's suggestions. */
export async function getPurchasers(): Promise<Purchaser[]> {
  const sb = await getSupabaseServer();
  return listPurchasers(sb);
}

/** Create a run ticket; revalidates the tank's well pages when supplied. */
export async function addRunTicket(
  input: RunTicketInput,
  wellIds: string[] = []
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await createRunTicket(sb, input);
  await clearCalledInIfRun(sb, input.tankId, [input.ticketType]);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
  return result;
}

/**
 * A run ticket IS the pickup the queue was waiting on, so logging one against a
 * called-in tank takes it back out of the queue automatically (the pumper never
 * has to remember to clear it). Only a `run` (sale) clears it — transfers and
 * dispositions don't fulfil a purchaser call-in. `ticketType` defaults to
 * `run`, matching `createRunTicket`. No-ops (and skips revalidation) when the
 * tank wasn't in the queue.
 */
async function clearCalledInIfRun(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  tankId: string,
  ticketTypes: (RunTicketInput["ticketType"] | undefined)[]
): Promise<void> {
  const hasRun = ticketTypes.some((t) => (t ?? "run") === "run");
  if (!hasRun) return;
  const { data } = await sb
    .from("tanks")
    .update({
      called_in_at: null,
      called_in_by: null,
      called_in_purchaser_id: null,
    })
    .eq("id", tankId)
    .not("called_in_at", "is", null)
    .select("id");
  if (data && data.length > 0) {
    revalidatePath("/production");
    revalidatePath("/reports");
  }
}

/**
 * Create several run tickets in one round-trip — backs the add-run-ticket modal,
 * where the user reviews a batch (manual or AI-extracted from one uploaded
 * document) before saving. `tankId` is stamped onto every input so callers pass
 * only the per-ticket fields. Revalidates the tank's well page once at the end.
 */
export async function addRunTickets(
  tankId: string,
  inputs: Omit<RunTicketInput, "tankId">[],
  wellIds: string[] = []
): Promise<{ created: number }> {
  const sb = await getSupabaseServer();
  const { created } = await createRunTickets(
    sb,
    inputs.map((i) => ({ ...i, tankId }))
  );
  await clearCalledInIfRun(
    sb,
    tankId,
    inputs.map((i) => i.ticketType)
  );
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
  return { created };
}

/** Update a run ticket (stamps the audit `updated_by`). */
export async function editRunTicket(
  tankId: string,
  id: string,
  patch: RunTicketPatch,
  wellIds: string[] = []
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await updateRunTicket(sb, tankId, id, { ...patch, updatedBy: user?.id ?? null });
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
}

/**
 * A short-lived signed URL for the ticket's attached photo/PDF — the audit path
 * back to the primary source. The ticket is read through the RLS client (so a
 * ticket outside the caller's org is simply not found) and the stored key is
 * re-checked against the caller's org prefix before the admin client (which
 * bypasses RLS) touches the bytes. Returns null when there is no attachment.
 */
export async function getRunTicketFileUrl(
  ticketId: string
): Promise<string | null> {
  const sb = await getSupabaseServer();
  return signRunTicketFile(sb, getSupabaseAdmin(), ticketId);
}

/** Soft-delete (void) a run ticket, keeping the audit trail intact. */
export async function removeRunTicket(
  tankId: string,
  id: string,
  wellIds: string[] = []
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await softDeleteRunTicket(sb, tankId, id, user?.id ?? null);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
}
