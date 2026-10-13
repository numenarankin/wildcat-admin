"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type {
  Contractor,
  Employee,
  Gatherer,
  RoyaltyOwner,
  ServiceProvider,
} from "@/lib/people/people";

export type EmployeeInput = Omit<Employee, "id">;
export type ContractorInput = Omit<Contractor, "id">;
export type ServiceProviderInput = Omit<ServiceProvider, "id">;
// Owner↔asset linking is not set here — royalty owners are a directory; their
// interest in a lease is granted on the lease Interest tab. `leaseIds` is
// therefore derived (read-only) and omitted from the create/update input.
export type RoyaltyOwnerInput = Omit<RoyaltyOwner, "id" | "leaseIds">;
export type GathererInput = Omit<Gatherer, "id">;

/**
 * Pages that surface people data and should re-fetch after a write. `/agenda`
 * is included because the task board's assignee list is built from the
 * contractors table; `/production` because tank settings pick a gatherer from
 * this same list.
 */
const PEOPLE_PATHS = ["/people", "/agenda", "/production"];

function revalidatePeople(): void {
  for (const path of PEOPLE_PATHS) revalidatePath(path);
}

/** Create an employee. */
export async function createEmployee(input: EmployeeInput): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("employees").insert({
    name: input.name,
    role: input.role || null,
    salary: input.salary,
    payment_schedule: input.paymentSchedule || null,
    phone: input.phone || null,
    email: input.email || null,
    status: input.status,
    description: input.description || null,
  });
  if (error) throw new Error(`createEmployee: ${error.message}`);
  revalidatePeople();
}

/** Update an existing employee. */
export async function updateEmployee(
  id: string,
  input: EmployeeInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("employees")
    .update({
      name: input.name,
      role: input.role || null,
      salary: input.salary,
      payment_schedule: input.paymentSchedule || null,
      phone: input.phone || null,
      email: input.email || null,
      status: input.status,
      description: input.description || null,
    })
    .eq("id", id);
  if (error) throw new Error(`updateEmployee: ${error.message}`);
  revalidatePeople();
}

/** Create a contractor. */
export async function createContractor(
  input: ContractorInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("contractors").insert({
    name: input.name,
    company: input.company || null,
    trade: input.trade || null,
    phone: input.phone || null,
    email: input.email || null,
    status: input.status,
    description: input.description || null,
  });
  if (error) throw new Error(`createContractor: ${error.message}`);
  revalidatePeople();
}

/** Update an existing contractor. */
export async function updateContractor(
  id: string,
  input: ContractorInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("contractors")
    .update({
      name: input.name,
      company: input.company || null,
      trade: input.trade || null,
      phone: input.phone || null,
      email: input.email || null,
      status: input.status,
      description: input.description || null,
    })
    .eq("id", id);
  if (error) throw new Error(`updateContractor: ${error.message}`);
  revalidatePeople();
}

/** Create a service provider. */
export async function createServiceProvider(
  input: ServiceProviderInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("service_providers").insert({
    company: input.company,
    service: input.service || null,
    contact: input.contact || null,
    phone: input.phone || null,
    email: input.email || null,
    status: input.status,
    description: input.description || null,
  });
  if (error) throw new Error(`createServiceProvider: ${error.message}`);
  revalidatePeople();
}

/** Update an existing service provider. */
export async function updateServiceProvider(
  id: string,
  input: ServiceProviderInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("service_providers")
    .update({
      company: input.company,
      service: input.service || null,
      contact: input.contact || null,
      phone: input.phone || null,
      email: input.email || null,
      status: input.status,
      description: input.description || null,
    })
    .eq("id", id);
  if (error) throw new Error(`updateServiceProvider: ${error.message}`);
  revalidatePeople();
}

/**
 * Create a gatherer; returns the created row so a caller (e.g. the tank-settings
 * quick-add) can select it immediately without a refetch.
 */
export async function createGatherer(input: GathererInput): Promise<Gatherer> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("gatherers")
    .insert({
      name: input.name,
      phone: input.phone || null,
      email: input.email || null,
      status: input.status,
      description: input.description || null,
    })
    .select("id, name, phone, email, status, description")
    .single();
  if (error) throw new Error(`createGatherer: ${error.message}`);
  revalidatePeople();
  return {
    id: data.id,
    name: data.name,
    phone: data.phone ?? "",
    email: data.email ?? "",
    status: data.status,
    description: data.description ?? "",
  };
}

/** Update an existing gatherer. */
export async function updateGatherer(
  id: string,
  input: GathererInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("gatherers")
    .update({
      name: input.name,
      phone: input.phone || null,
      email: input.email || null,
      status: input.status,
      description: input.description || null,
    })
    .eq("id", id);
  if (error) throw new Error(`updateGatherer: ${error.message}`);
  revalidatePeople();
}

/** Create a royalty owner (a directory entry; interest is granted per lease). */
export async function createRoyaltyOwner(
  input: RoyaltyOwnerInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("royalty_owners").insert({
    name: input.name,
    phone: input.phone || null,
    email: input.email || null,
    mailing_address: input.mailingAddress || null,
    last_payment: input.lastPayment,
    description: input.description || null,
  });
  if (error) throw new Error(`createRoyaltyOwner: ${error.message}`);
  revalidatePeople();
}

/** Update an existing royalty owner's directory fields. */
export async function updateRoyaltyOwner(
  id: string,
  input: RoyaltyOwnerInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("royalty_owners")
    .update({
      name: input.name,
      phone: input.phone || null,
      email: input.email || null,
      mailing_address: input.mailingAddress || null,
      last_payment: input.lastPayment,
      description: input.description || null,
    })
    .eq("id", id);
  if (error) throw new Error(`updateRoyaltyOwner: ${error.message}`);
  revalidatePeople();
}

// --- Deletes ---------------------------------------------------------------
// Each removes one directory row. The request-scoped client enforces the
// `manage_people` capability via RLS (matching create/update), so a
// caller without it deletes nothing rather than bypassing the check. FKs from
// dependent rows are `on delete set null`/`cascade`, so a delete never orphans.

/** Delete an employee. */
export async function deleteEmployee(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("employees").delete().eq("id", id);
  if (error) throw new Error(`deleteEmployee: ${error.message}`);
  revalidatePeople();
}

/** Delete a contractor. */
export async function deleteContractor(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("contractors").delete().eq("id", id);
  if (error) throw new Error(`deleteContractor: ${error.message}`);
  revalidatePeople();
}

/** Delete a service provider (vendor). */
export async function deleteServiceProvider(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("service_providers").delete().eq("id", id);
  if (error) throw new Error(`deleteServiceProvider: ${error.message}`);
  revalidatePeople();
}

/** Delete a gatherer (purchaser). */
export async function deleteGatherer(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("gatherers").delete().eq("id", id);
  if (error) throw new Error(`deleteGatherer: ${error.message}`);
  revalidatePeople();
}

/** Delete a royalty owner. Any lease interest granted to them is removed by the
 *  owner-to-lease FK's cascade; the leases themselves are untouched. */
export async function deleteRoyaltyOwner(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("royalty_owners").delete().eq("id", id);
  if (error) throw new Error(`deleteRoyaltyOwner: ${error.message}`);
  revalidatePeople();
}
