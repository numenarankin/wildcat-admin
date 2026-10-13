/**
 * The organization permission catalog and member types. This module is PURE
 * (no server-only imports) so it is safe to import from client components that
 * render the permissions UI. Server-side data access lives in `./org-data`.
 *
 * See `docs/permissions.md` for the design: the catalog, the Field/Office/Admin
 * role presets, and how the keys map onto database RLS.
 */

/**
 * Every grantable capability key, in catalog order. Keys are PERSISTED in
 * `org_members.permissions` and referenced by the database RLS policies, so they
 * must stay stable. Labels/descriptions (below) are UI-only and free to reword.
 */
export const PERMISSION_KEYS = [
  "admin",
  "manage_skills",
  "manage_files",
  "view_notes",
  "manage_notes",
  "add_wells",
  "add_injection_wells",
  "view_well_production",
  "manage_oil_production",
  "manage_gas_production",
  "manage_allocation",
  "manage_well_equipment",
  "manage_well_service",
  "view_disposal",
  "manage_disposal",
  "view_facilities",
  "manage_facilities",
  "view_leases",
  "manage_leases",
  "view_people",
  "manage_people",
  "view_revenue",
  "manage_statements",
  "view_invoices",
  "manage_invoices",
  "manage_projects",
  "manage_inventory",
  "manage_personal_agenda",
  "manage_org_agenda",
  "use_ai",
  "view_reports",
  "view_analytics",
  "view_pricing",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** A named cluster of related permissions, used to lay out the editor modal. */
export type PermissionGroup =
  | "General"
  | "Skills"
  | "Files"
  | "Notes"
  | "Wells"
  | "Disposal"
  | "Facilities"
  | "Leases"
  | "People"
  | "Revenue"
  | "Invoices"
  | "Projects"
  | "Inventory"
  | "Agenda"
  | "AI"
  | "Reports"
  | "Analytics"
  | "Pricing";

export interface PermissionDef {
  key: PermissionKey;
  label: string;
  description: string;
  group: PermissionGroup;
  /**
   * Permissions this one automatically grants. Granting a `manage_*` capability
   * implies its `view_*` counterpart; the editor reflects this by checking and
   * locking the implied switch. `admin` implies everything and is handled
   * separately (see {@link expandPermissions}).
   */
  implies?: PermissionKey[];
  /**
   * Permissions that must ALREADY be held before this one can be granted. The
   * mirror image of {@link implies}: `implies` widens a grant, `requires`
   * blocks one. Enforced in {@link cleanPermissions}, so a stored array that
   * keeps this key after a prerequisite is revoked is not representable, and
   * the editor disables the switch until the prerequisites are on.
   */
  requires?: PermissionKey[];
}

/**
 * The catalog of grantable capabilities. Each is a piece of functionality the
 * org can switch on or off per member via the permissions modal.
 */
export const PERMISSION_DEFS: readonly PermissionDef[] = [
  {
    key: "admin",
    label: "Admin",
    description:
      "Full access, including members and billing. Every permission below, granted automatically.",
    group: "General",
  },
  {
    key: "manage_skills",
    label: "Manage skills",
    description: "View and configure Orion skills.",
    group: "Skills",
  },
  {
    key: "manage_files",
    label: "Files",
    description: "Open, upload, edit, and delete files and documents.",
    group: "Files",
  },
  {
    key: "view_notes",
    label: "View notes",
    description: "Read notes and their facility/people tags.",
    group: "Notes",
  },
  {
    key: "manage_notes",
    label: "Notes",
    description: "Create, edit, tag, and delete notes.",
    group: "Notes",
    implies: ["view_notes"],
  },
  {
    key: "add_wells",
    label: "Add wells",
    description: "Create and edit producing wells.",
    group: "Wells",
    implies: ["view_well_production"],
  },
  {
    key: "add_injection_wells",
    label: "Add injection wells",
    description: "Create and edit disposal/injection wells.",
    group: "Wells",
    implies: ["view_disposal"],
  },
  {
    key: "view_well_production",
    label: "View well production",
    description: "View production readings and well figures.",
    group: "Wells",
  },
  {
    key: "manage_oil_production",
    label: "Manage oil production",
    description: "Gauge oil tanks, record run tickets, and call in loads.",
    group: "Wells",
    implies: ["view_well_production"],
  },
  {
    key: "manage_gas_production",
    label: "Manage gas production",
    description: "Record meter readings, volume statements, and gas well tests.",
    group: "Wells",
    implies: ["view_well_production"],
  },
  {
    key: "manage_allocation",
    label: "Manage allocation",
    description:
      "Set well-test and allocation splits that divide production across wells.",
    group: "Wells",
    implies: ["view_well_production"],
  },
  {
    key: "manage_well_equipment",
    label: "Manage well equipment",
    description: "Add and edit equipment on a well.",
    group: "Wells",
    implies: ["view_well_production"],
  },
  {
    key: "manage_well_service",
    label: "Manage well service",
    description: "Record well service and workover history.",
    group: "Wells",
    implies: ["view_well_production"],
  },
  {
    key: "view_disposal",
    label: "View disposal",
    description: "View saltwater disposal tanks, wells, and injection readings.",
    group: "Disposal",
  },
  {
    key: "manage_disposal",
    label: "Manage disposal",
    description: "Record disposal tank and injection readings.",
    group: "Disposal",
    implies: ["view_disposal"],
  },
  {
    key: "view_facilities",
    label: "View facilities",
    description: "View the cross-substance flow map.",
    group: "Facilities",
  },
  {
    key: "manage_facilities",
    label: "Manage facilities",
    description: "Edit the facilities flow map.",
    group: "Facilities",
    implies: ["view_facilities"],
  },
  {
    key: "view_leases",
    label: "View leases",
    description: "View leases and their wells, tanks, meters, and interest.",
    group: "Leases",
  },
  {
    key: "manage_leases",
    label: "Manage leases",
    description:
      "Create and edit leases, assign wells/tanks/meters, and edit owner interest.",
    group: "Leases",
    implies: ["view_leases"],
  },
  {
    key: "view_people",
    label: "View people",
    description: "View contractors, service providers, and royalty owners.",
    group: "People",
  },
  {
    key: "manage_people",
    label: "Manage people",
    description:
      "Add and edit contractors, service providers, and royalty owners.",
    group: "People",
    implies: ["view_people"],
  },
  {
    key: "view_revenue",
    label: "View revenue",
    description: "View revenue and settlement statements.",
    group: "Revenue",
  },
  {
    key: "manage_statements",
    label: "Manage statements",
    description:
      "Upload, review, and reconcile settlement statements, and edit revenue.",
    group: "Revenue",
    implies: ["view_revenue"],
  },
  {
    key: "view_invoices",
    label: "View invoices",
    description:
      "View vendor invoices, field tickets, and the job history behind them.",
    group: "Invoices",
  },
  {
    key: "manage_invoices",
    label: "Manage invoices",
    description:
      "Upload, extract, review, and allocate vendor invoices and field tickets.",
    group: "Invoices",
    implies: ["view_invoices"],
  },
  {
    key: "manage_projects",
    label: "Projects",
    description: "View and manage projects.",
    group: "Projects",
  },
  {
    key: "manage_inventory",
    label: "Inventory",
    description: "View and manage inventory records.",
    group: "Inventory",
  },
  {
    key: "manage_personal_agenda",
    label: "Personal agenda",
    description: "Manage their own tasks and calendar events.",
    group: "Agenda",
  },
  {
    key: "manage_org_agenda",
    label: "Org agenda",
    description: "Create tasks and events for others and for the organization.",
    group: "Agenda",
  },
  {
    key: "use_ai",
    label: "Use AI",
    description: "Chat with the Orion assistant and scan documents.",
    group: "AI",
  },
  {
    key: "view_reports",
    label: "View reports",
    description:
      "Open the report hub. Needs production and revenue viewing, because a single report can carry both.",
    group: "Reports",
    // Reports mix the two domains in one document: the Company Digest is one
    // report that carries production volumes AND revenue. Gating the hub on
    // either one alone let a production-only member read revenue through it.
    requires: ["view_well_production", "view_revenue"],
  },
  {
    key: "view_analytics",
    label: "View analytics",
    description: "View analytics dashboards.",
    group: "Analytics",
  },
  {
    key: "view_pricing",
    label: "View pricing",
    description: "View posted prices and price projections.",
    group: "Pricing",
  },
];

const DEF_BY_KEY: Record<PermissionKey, PermissionDef> = Object.fromEntries(
  PERMISSION_DEFS.map((d) => [d.key, d])
) as Record<PermissionKey, PermissionDef>;

/** Lookup helper for UI code that wants a permission's label/description/group. */
export function permissionDef(key: PermissionKey): PermissionDef {
  return DEF_BY_KEY[key];
}

/** Permission group order for the editor modal. */
export const PERMISSION_GROUP_ORDER: PermissionGroup[] = [
  "Skills",
  "Files",
  "Notes",
  "Wells",
  "Disposal",
  "Facilities",
  "Leases",
  "People",
  "Revenue",
  "Invoices",
  "Projects",
  "Inventory",
  "Agenda",
  "AI",
  "Reports",
  "Analytics",
  "Pricing",
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = [...PERMISSION_KEYS];

const PERMISSION_KEY_SET = new Set<string>(PERMISSION_KEYS);

/** Type guard: is an arbitrary string a known permission key? */
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

/**
 * Drop unknown/legacy keys, de-duplicate, preserve catalog order, and drop any
 * key whose prerequisites are not met.
 *
 * The prerequisite pass runs on both the write path (saving the permissions
 * modal) and the read path (resolving a member's effective set), which is what
 * makes revocation work: an admin who switches revenue viewing off strips
 * `view_reports` with it, without having to remember to.
 */
export function cleanPermissions(keys: readonly string[]): PermissionKey[] {
  const set = new Set(keys.filter(isPermissionKey) as PermissionKey[]);
  let kept = PERMISSION_KEYS.filter((k) => set.has(k));
  // To a fixed point, since dropping a key can strip a prerequisite another key
  // was leaning on. One pass would be enough for today's single rule; a chain
  // of them would not, and the loop costs nothing on a 33-key array.
  for (;;) {
    const next = kept.filter((k) => missingPrerequisites(kept, k).length === 0);
    if (next.length === kept.length) return next;
    kept = next;
  }
}

/**
 * Which of `key`'s prerequisites `granted` does not cover. Empty when the key
 * is grantable. Checked against the EXPANDED set, so holding `manage_statements`
 * satisfies a `view_revenue` prerequisite the way it satisfies everything else.
 */
export function missingPrerequisites(
  granted: readonly PermissionKey[],
  key: PermissionKey
): PermissionKey[] {
  const required = DEF_BY_KEY[key]?.requires;
  if (!required?.length) return [];
  const held = new Set(expandPermissions(granted));
  return required.filter((r) => !held.has(r));
}

/**
 * Expand a raw permission list into the full EFFECTIVE set: `admin` grants
 * everything, and each granted permission pulls in the ones it implies (e.g.
 * `manage_statements` -> `view_revenue`). Returns catalog order.
 */
export function expandPermissions(keys: readonly PermissionKey[]): PermissionKey[] {
  const set = new Set<PermissionKey>();
  const add = (k: PermissionKey) => {
    if (set.has(k)) return;
    set.add(k);
    DEF_BY_KEY[k]?.implies?.forEach(add);
  };
  for (const k of keys) add(k);
  if (set.has("admin")) {
    return [...PERMISSION_KEYS];
  }
  return PERMISSION_KEYS.filter((k) => set.has(k));
}

/** Does this (raw) permission list effectively grant `target`? */
export function permissionsInclude(
  keys: readonly PermissionKey[],
  target: PermissionKey
): boolean {
  return expandPermissions(keys).includes(target);
}

/** What a freshly-invited member starts with: nothing, until granted in the
 * permissions modal. Every capability is off by default. */
export const DEFAULT_PERMISSIONS: PermissionKey[] = [];

/**
 * A one-click bundle of capabilities for the permissions editor. Presets are
 * NOT stored — applying one just pre-checks its switches, which the admin can
 * still adjust. A member's effective access is always the raw key list.
 * See `docs/permissions.md` -> Role bundles.
 */
export interface RolePreset {
  id: "field" | "office" | "admin";
  label: string;
  description: string;
  permissions: PermissionKey[];
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: "field",
    label: "Field",
    description:
      "Pumpers and field managers: full field capture, no back-office or revenue.",
    permissions: [
      "manage_oil_production",
      "manage_gas_production",
      "manage_disposal",
      "manage_allocation",
      "manage_well_equipment",
      "manage_well_service",
      "add_wells",
      "add_injection_wells",
      "manage_facilities",
      "view_leases",
      "manage_inventory",
      "manage_files",
      "manage_notes",
      "manage_personal_agenda",
      "use_ai",
    ],
  },
  {
    id: "office",
    label: "Office",
    description:
      "Bookkeeping, land/lease, and analysis: everything back-office, no field writes.",
    permissions: [
      "manage_statements",
      // Accounts payable sits with the same people who own settlement
      // statements; Field gets neither.
      "manage_invoices",
      "manage_people",
      "manage_leases",
      "manage_projects",
      "manage_inventory",
      "view_well_production",
      "view_disposal",
      "view_facilities",
      "view_pricing",
      "view_reports",
      "view_analytics",
      "manage_files",
      "manage_notes",
      "manage_personal_agenda",
      "manage_org_agenda",
      "use_ai",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Full access, including members, billing, and skills.",
    permissions: ["admin"],
  },
];

/**
 * "removed" is a soft delete, not a state a member can be invited into. Both
 * `current_org_id()` and `has_capability()` filter on `status = 'active'`, so
 * the row stops authorizing anything the moment it lands here — see
 * `supabase/migrations/2026080904000_member_offboarding.sql`.
 */
export type MemberStatus = "active" | "invited" | "removed";

export interface OrgMember {
  id: string;
  name: string;
  email: string;
  isOwner: boolean;
  permissions: PermissionKey[];
  status: MemberStatus;
  /** When they were offboarded — set if and only if `status` is "removed". */
  removedAt: string | null;
  avatarUrl: string | null;
  /**
   * Opt-in to unreleased features (today: Scout). Not a permission key — see
   * supabase/migrations/2026080300100_org_members_early_access.sql for why the
   * two are kept separate. Admin-writable only.
   */
  earlyAccess: boolean;
}
