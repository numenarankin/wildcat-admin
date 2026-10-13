import type { ReactNode } from "react";
import { Receipt } from "@untitledui/icons";
import {
	FilesIcon,
	StickyNoteIcon,
	GaugeIcon,
	DropletIcon,
	MapIcon,
	GanttChartIcon,
	WrenchIcon,
	CalendarIcon,
	MessageSquareIcon,
	UsersIcon,
	CalculatorIcon,
	CylinderIcon,
	WaypointsIcon,
	DollarSignIcon,
	WalletIcon,
	FileTextIcon,
	ScrollTextIcon,
	GitCommitHorizontalIcon,
	HashIcon,
	BarChart3Icon,
	LineChartIcon,
	LifeBuoyIcon,
	DatabaseIcon,
	SettingsIcon,
	TelescopeIcon,
	HandshakeIcon,
	LandmarkIcon,
	ListTodoIcon,
	MailIcon,
	HardDriveIcon,
} from "lucide-react";
import { SparkleIcon } from "@/components/ai/sparkle-icon";
import type { PermissionKey } from "@/lib/settings/org";

export type SidebarNavItem = {
	title: string;
	path?: string;
	icon?: ReactNode;
	isActive?: boolean;
	subItems?: SidebarNavItem[];
	/**
	 * Capability required to see this item. An array means "any of these".
	 * Omit for items everyone can reach (Home, Settings).
	 */
	permission?: PermissionKey | PermissionKey[];
	/**
	 * Shelved / work-in-progress page: hidden from the sidebar by default so the
	 * dev sidebar matches production (WYSIWYG). A dev opts it back in by setting
	 * `NEXT_PUBLIC_SHOW_DEV_NAV=true`. The page itself lives under `/dev/*` and is
	 * separately gated to non-production by `app/dev/layout.tsx`.
	 */
	devOnly?: boolean;
	/**
	 * Opens a hover flyout to the right of the sidebar instead of being just a
	 * link. `"leases"` lists the org's leases and, per lease, the facilities on
	 * it (`@/components/leases/lease-nav-flyout`); the item still navigates on
	 * click. Desktop only — the mobile sidebar is a sheet with no room beside it.
	 */
	flyout?: "leases";
	/**
	 * Unreleased feature: hidden unless the signed-in user carries
	 * `org_members.early_access`. UI hiding only — the page and its API routes
	 * re-check the flag server-side (`@/lib/auth/early-access`).
	 */
	earlyAccess?: boolean;
};

export type SidebarNavGroup = {
	label?: string;
	items: SidebarNavItem[];
};

export const navGroups: SidebarNavGroup[] = [
	{
		label: "Workspace",
		items: [
			// Home is intentionally omitted: `/` redirects to the Dashboard (see
			// app/route.ts), which is the first entry here for the same reason.
			{
				title: "Dashboard",
				path: "/dashboard",
				icon: <BarChart3Icon />,
				permission: "view_analytics",
			},
			{
				title: "Orion",
				path: "/orion",
				icon: <SparkleIcon />,
				permission: "use_ai",
			},
			{
				title: "Projects",
				path: "/projects",
				icon: <GanttChartIcon />,
				permission: "manage_projects",
			},
			{
				title: "Files",
				path: "/files",
				icon: <FilesIcon />,
				permission: "manage_files",
			},
			{
				title: "Notes",
				path: "/notes",
				icon: <StickyNoteIcon />,
				permission: ["view_notes", "manage_notes"],
			},
			{
				title: "Agenda",
				path: "/agenda",
				icon: <CalendarIcon />,
				permission: ["manage_personal_agenda", "manage_org_agenda"],
			},
			// No `permission`: messaging is open to every member by design (see
			// `docs/plans/org-messaging.md` §3). Access is enforced by channel
			// membership in RLS, not by a capability key.
			{
				title: "Messages",
				path: "/messages",
				icon: <MessageSquareIcon />,
			},
		],
	},
	{
		label: "Operations",
		items: [
			{
				title: "Leases",
				path: "/leases",
				icon: <MapIcon />,
				flyout: "leases",
				permission: ["view_leases"],
			},
			{
				title: "Production",
				path: "/production",
				icon: <GaugeIcon />,
				permission: ["view_well_production"],
			},
			{
				title: "Disposal",
				path: "/disposal",
				icon: <DropletIcon />,
				// SWD / injection-well capture.
				permission: ["view_disposal"],
			},
			{
				title: "Facilities",
				path: "/facilities",
				icon: <CylinderIcon />,
				// Per-commodity flow map: wells → tanks / meters → SWD wells.
				permission: ["view_facilities"],
			},
			{
				// The same map over a made-up operation, or over the fleet an RRC
				// operator number would bring in. Reads none of this org's rows.
				title: "Facilities lab",
				path: "/dev/facilities",
				devOnly: true,
				icon: <WaypointsIcon />,
				permission: ["view_facilities"],
			},
			{
				// Shelved: parked under /dev until it ships, so it 404s in
				// production and stays out of the sidebar.
				title: "Data Entry",
				path: "/dev/data-entry",
				devOnly: true,
				icon: <DatabaseIcon />,
			},
			{
				title: "Inventory",
				path: "/inventory",
				icon: <WrenchIcon />,
				permission: "manage_inventory",
			},
			{
				title: "Scout",
				path: "/scout",
				icon: <TelescopeIcon />,
				// Every Texas RRC wellbore, clustered, with operator detail on
				// click. Reads Archon's RRC dataset and the Tiger mirror — the
				// public state record, not this org's data — so it carries no
				// capability key and no early-access flag: every signed-in member
				// gets it. The server-side gates are `requireUser()` on the pages
				// and `forbidUnlessSignedIn()` on /api/scout/*, which protect the
				// service-role credential rather than any row.
			},
		],
	},
	{
		label: "Finance",
		items: [
			{
				title: "Accounting",
				path: "/dev/accounting",
				devOnly: true,
				icon: <CalculatorIcon />,
				permission: ["view_revenue", "manage_statements"],
			},
			{
				title: "Revenue",
				path: "/revenue",
				icon: <DollarSignIcon />,
				// Revenue transactions + the purchaser settlement statements that
				// feed the ledger; same accounting gate as Accounting.
				permission: ["view_revenue", "manage_statements"],
			},
			{
				title: "Invoices",
				path: "/invoices",
				icon: <Receipt />,
				// Vendor invoices: the payables mirror of a settlement statement.
				// Gates on the keys the page itself requires. Advertising the
				// revenue keys here hid the page from members holding only
				// invoice keys, and offered it to members it then turned away.
				permission: ["view_invoices", "manage_invoices"],
			},
			{
				title: "Expenses",
				path: "/dev/expenses",
				devOnly: true,
				icon: <WalletIcon />,
				permission: ["view_revenue", "manage_statements"],
			},
			{
				title: "Prices",
				path: "/prices",
				icon: <LineChartIcon />,
				permission: "view_pricing",
			},
		],
	},
	{
		label: "Admin",
		items: [
			{
				title: "People",
				path: "/people",
				icon: <UsersIcon />,
				permission: ["view_people", "manage_people"],
			},
			{
				title: "Reports",
				path: "/reports",
				icon: <FileTextIcon />,
				// The hub aggregates production and financial reports, and a
				// single report can carry both, so `view_reports` is only
				// grantable to a member who can view each (see PERMISSION_DEFS).
				// Gate on that one key: production access alone used to show this
				// link to pumpers, whom the page then turned away.
				permission: ["view_reports"],
			},
			{
				// Styling bench for the export documents: every report rendered
				// from in-repo fixtures. No org data, so no capability gate.
				title: "Report samples",
				path: "/dev/reports",
				devOnly: true,
				icon: <FileTextIcon />,
			},
		],
	},
];

export const footerNavLinks: SidebarNavItem[] = [];

/**
 * Routes that are NOT in the sidebar but are still first-class pages: they are
 * reached from the profile menu (`nav-user.tsx`). They stay registered here
 * because `navLinks` is what names a section — a path missing from it renders
 * no breadcrumbs at all.
 */
export const unlistedNavLinks: SidebarNavItem[] = [
	{
		title: "Support",
		path: "/support",
		icon: <LifeBuoyIcon />,
	},
	{
		title: "Settings",
		path: "/settings",
		icon: <SettingsIcon />,
	},
];

function flattenGroups(groups: SidebarNavGroup[]): SidebarNavItem[] {
	return groups.flatMap((group) =>
		group.items.flatMap((item) =>
			item.subItems?.length ? [item, ...item.subItems] : [item]
		)
	);
}

export const navLinks: SidebarNavItem[] = [
	...flattenGroups(navGroups),
	...footerNavLinks,
	...unlistedNavLinks,
];

/**
 * The /admin side: Wildcat insiders' view over every customer, reachable only
 * by accounts on `platform_admins` (`@/lib/auth/platform-admin`). Same chrome
 * as the app, different navigation. No `permission` keys: org capabilities do
 * not apply here. Access is page-level instead (`platform_admins.pages`, the
 * catalog in `@/lib/admin/pages`): the sidebar matches each item to a page by
 * its path and draws only the pages on the viewer's list. A test keeps this
 * list and the catalog in step.
 */
export const adminNavGroups: SidebarNavGroup[] = [
	{
		label: "Workspace",
		items: [
			{ title: "Dashboard", path: "/dashboard", icon: <BarChart3Icon /> },
			{ title: "Orion", path: "/orion", icon: <SparkleIcon /> },
			{ title: "Projects", path: "/projects", icon: <GanttChartIcon /> },
			{ title: "Tasks", path: "/tasks", icon: <ListTodoIcon /> },
			{ title: "Calendar", path: "/calendar", icon: <CalendarIcon /> },
			{ title: "Email", path: "/email", icon: <MailIcon /> },
			{ title: "Slack", path: "/slack", icon: <HashIcon /> },
			{ title: "Drive", path: "/drive", icon: <HardDriveIcon /> },
		],
	},
	{
		label: "Business",
		items: [
			{ title: "Analytics", path: "/analytics", icon: <LineChartIcon /> },
			{ title: "Finance", path: "/finance", icon: <LandmarkIcon /> },
			{ title: "Clients", path: "/clients", icon: <UsersIcon /> },
			{ title: "Sales", path: "/sales", icon: <HandshakeIcon /> },
			{ title: "Prospecting", path: "/prospecting", icon: <TelescopeIcon /> },
			{ title: "Support", path: "/support", icon: <LifeBuoyIcon /> },
		],
	},
	{
		label: "Engineering",
		items: [
			{ title: "Logs", path: "/logs", icon: <ScrollTextIcon /> },
			{ title: "Git", path: "/git", icon: <GitCommitHorizontalIcon /> },
		],
	},
];

/** Settings sits under the groups, as the app's own footer links do. */
export const adminFooterNavLinks: SidebarNavItem[] = [
	{ title: "Settings", path: "/settings", icon: <SettingsIcon /> },
];

export const adminNavLinks: SidebarNavItem[] = [
	...flattenGroups(adminNavGroups),
	...adminFooterNavLinks,
];

/**
 * Every route in this app is the admin side; it is its own deployment now, not
 * a subtree of the customer app. Kept as a function so the chrome copied from
 * the customer app reads the same.
 */
export function isAdminPath(pathname: string): boolean {
	void pathname;
	return true;
}
