import { hasSupabase } from "@/lib/env";
import { getRequestSupabase } from "@/lib/supabase/request-client";

/** The person categories shown on the People page. */
export type PeopleCategory =
  | "employees"
  | "contractors"
  | "service-providers"
  | "royalty-owners"
  | "gatherers";

/**
 * A person on the operator's payroll (pumper, foreman, office staff, etc.).
 * People-domain only — no asset links; salary + payment schedule are payroll
 * fields, distinct from a 1099 contractor.
 */
export interface Employee {
  id: string;
  name: string;
  /** Job title / role, e.g. "Lease Operator", "Foreman". */
  role: string;
  /** Salary in US dollars. */
  salary: number;
  /** Payroll cadence, e.g. "Biweekly", "Monthly" (free text). */
  paymentSchedule: string;
  phone: string;
  email: string;
  status: "Active" | "Inactive";
  /** Free-form notes about the employee. */
  description: string;
}

/**
 * An independent contractor who performs field work for the operator
 * (pumpers, roustabouts, welders, electricians, etc.).
 */
export interface Contractor {
  id: string;
  name: string;
  company: string;
  /** Trade / specialty, e.g. "Pumper", "Welder". */
  trade: string;
  phone: string;
  email: string;
  status: "Active" | "Inactive";
  /** Free-form notes about the contractor. */
  description: string;
}

/**
 * A company the operator buys services from (well servicing, trucking,
 * chemical, wireline, etc.).
 */
export interface ServiceProvider {
  id: string;
  company: string;
  /** Category of service provided. */
  service: string;
  /** Primary contact name. */
  contact: string;
  phone: string;
  email: string;
  status: "Active" | "Inactive";
  /** Free-form notes about the service provider. */
  description: string;
}

/**
 * A holder of a royalty / mineral interest who receives revenue payments.
 */
export interface RoyaltyOwner {
  id: string;
  name: string;
  /** IDs of the leases the owner holds an interest in (derived from the interest
   * join; set on the lease Interest tab, read-only here). */
  leaseIds: string[];
  /** Contact phone number. */
  phone: string;
  /** Contact email address. */
  email: string;
  /** Mailing address for revenue checks and correspondence. */
  mailingAddress: string;
  /** Most recent monthly payment, in US dollars. */
  lastPayment: number;
  /** Free-form notes about the royalty owner. */
  description: string;
}

/**
 * A gathering / hauling company that collects product off a tank. Selectable on
 * the tank-settings modal and managed on the People page's Gatherers tab; tanks
 * reference it by id (`tanks.gatherer_id`).
 */
export interface Gatherer {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: "Active" | "Inactive";
  /** Free-form notes about the gatherer. */
  description: string;
}

export async function getEmployees(): Promise<Employee[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("employees")
    .select(
      "id, name, role, salary, payment_schedule, phone, email, status, description"
    )
    .order("name");
  if (error) throw new Error(`getEmployees: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role ?? "",
    salary: r.salary ?? 0,
    paymentSchedule: r.payment_schedule ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    status: r.status,
    description: r.description ?? "",
  }));
}

export async function getGatherers(): Promise<Gatherer[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("gatherers")
    .select("id, name, phone, email, status, description")
    .order("name");
  if (error) throw new Error(`getGatherers: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone ?? "",
    email: r.email ?? "",
    status: r.status,
    description: r.description ?? "",
  }));
}

export async function getContractors(): Promise<Contractor[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("contractors")
    .select("id, name, company, trade, phone, email, status, description")
    .order("name");
  if (error) throw new Error(`getContractors: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    company: r.company ?? "",
    trade: r.trade ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    status: r.status,
    description: r.description ?? "",
  }));
}

export async function getServiceProviders(): Promise<ServiceProvider[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("service_providers")
    .select("id, company, service, contact, phone, email, status, description")
    .order("company");
  if (error) throw new Error(`getServiceProviders: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    company: r.company,
    service: r.service ?? "",
    contact: r.contact ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    status: r.status,
    description: r.description ?? "",
  }));
}

interface RoyaltyOwnerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  mailing_address: string | null;
  last_payment: number | null;
  description: string | null;
  royalty_owner_wells: { lease_id: string | null }[] | null;
}

function mapRoyaltyOwner(r: RoyaltyOwnerRow): RoyaltyOwner {
  return {
    id: r.id,
    name: r.name,
    leaseIds: (r.royalty_owner_wells ?? [])
      .map((w) => w.lease_id)
      .filter((id): id is string => id != null),
    phone: r.phone ?? "",
    email: r.email ?? "",
    mailingAddress: r.mailing_address ?? "",
    lastPayment: r.last_payment ?? 0,
    description: r.description ?? "",
  };
}

export async function getRoyaltyOwners(): Promise<RoyaltyOwner[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("royalty_owners")
    .select(
      "id, name, phone, email, mailing_address, last_payment, description, royalty_owner_wells(lease_id)"
    )
    .order("name");
  if (error) throw new Error(`getRoyaltyOwners: ${error.message}`);
  return ((data ?? []) as RoyaltyOwnerRow[]).map(mapRoyaltyOwner);
}

/** Returns the royalty owners that hold an interest in a given lease. */
export async function getLeaseRoyaltyOwners(
  leaseId: string
): Promise<RoyaltyOwner[]> {
  const owners = await getRoyaltyOwners();
  return owners.filter((owner) => owner.leaseIds.includes(leaseId));
}
