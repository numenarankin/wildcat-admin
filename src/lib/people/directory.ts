import {
  getContractors,
  getEmployees,
  getGatherers,
  getRoyaltyOwners,
  getServiceProviders,
} from "@/lib/people/people";
import { getOrgMembers } from "@/lib/settings/org-data";
import type { OrgMember } from "@/lib/settings/org";

/** One labelled section of the people picker. */
export interface PersonGroup {
  /** Section heading, e.g. "Employees". */
  label: string;
  /** Display names, sorted, already deduped against earlier groups. */
  names: string[];
}

/**
 * One display name per member, keyed on WHO they are rather than on how their
 * name happens to be spelled.
 *
 * `org_members` holds a row per membership, not per person: an invite row
 * carries the name typed on the invite, the joined row resolves to the profile
 * name, and offboarding leaves the old row behind as `removed` (see
 * `removeOrgMember`). One person with two rows spelled even slightly
 * differently — "Rankin" and "Rankin Poage" — is two entries in every picker
 * fed from here, which is how the viewer ends up listed twice in their own
 * agenda filter. Email is the identity that survives all of it.
 *
 * Removed members are dropped outright: they cannot be assigned work or invited
 * to a job, so offering them is offering a dead option.
 */
export function memberNames(members: OrgMember[]): string[] {
  const byEmail = new Map<string, { name: string; real: boolean }>();
  for (const member of members) {
    if (member.status === "removed") continue;
    const key = member.email.trim().toLowerCase() || member.id;
    const name = member.name.trim();
    const next = { name: name || member.email, real: name !== "" };
    const prev = byEmail.get(key);
    // A real name beats the email fallback, and between two real names the
    // longer wins: the profile's full name over a first name off an invite.
    if (
      prev == null ||
      (next.real && !prev.real) ||
      (next.real === prev.real && next.name.length > prev.name.length)
    ) {
      byEmail.set(key, next);
    }
  }
  return [...byEmail.values()].map((m) => m.name);
}

/**
 * Everyone the app knows by name, for picking attendees on a calendar event.
 *
 * The agenda used to offer `org_members` alone — the people with LOGINS. That
 * is the wrong set for an event: an operator's pumper, foreman or workover
 * contractor is someone you put on a job without ever giving them an account,
 * and they live in the `/people` directory instead. So this reads the whole
 * directory and the member roster together.
 *
 * Grouped rather than flattened. A single alphabetical list of every employee,
 * contractor, service company, royalty owner and gatherer is long and, worse,
 * ambiguous — two people called Jim, one a welder and one a royalty owner, are
 * indistinguishable in it.
 *
 * Order is deliberate: the people who work the leases first, the counterparties
 * you meet with after.
 */
export async function getPeopleDirectory(): Promise<PersonGroup[]> {
  const [members, employees, contractors, providers, owners, gatherers] =
    await Promise.all([
      getOrgMembers(),
      getEmployees(),
      getContractors(),
      getServiceProviders(),
      getRoyaltyOwners(),
      getGatherers(),
    ]);

  const raw: { label: string; names: string[] }[] = [
    { label: "Members", names: memberNames(members) },
    { label: "Employees", names: employees.map((e) => e.name) },
    { label: "Contractors", names: contractors.map((c) => c.name) },
    {
      // The named contact, falling back to the company when there isn't one:
      // "Basin Wireline" is a usable attendee, an empty string is not.
      label: "Service providers",
      names: providers.map((p) => p.contact?.trim() || p.company),
    },
    { label: "Royalty owners", names: owners.map((o) => o.name) },
    { label: "Gatherers", names: gatherers.map((g) => g.name) },
  ];

  // Deduped ACROSS groups, first occurrence winning, because the same person is
  // routinely both an org member and an employee. Two identical checkboxes in
  // one menu would toggle the same value while looking independent.
  const seen = new Set<string>();
  const groups: PersonGroup[] = [];
  for (const group of raw) {
    const names = [...new Set(group.names.map((n) => n?.trim()).filter(Boolean))]
      .filter((name) => !seen.has(name))
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) seen.add(name);
    if (names.length) groups.push({ label: group.label, names });
  }
  return groups;
}

/** Every name in the directory, flat — for callers that don't group. */
export function flattenPeople(groups: PersonGroup[]): string[] {
  return groups.flatMap((g) => g.names);
}
