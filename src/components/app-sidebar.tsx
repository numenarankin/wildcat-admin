"use client";

import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";
import { usePathname } from "next/navigation";
import {
	adminFooterNavLinks,
	adminNavGroups,
	footerNavLinks,
	isAdminPath,
	navGroups,
	type SidebarNavGroup,
	type SidebarNavItem,
} from "@/components/app-shared";
import { NavGroup } from "@/components/nav-group";
import { usePermissions } from "@/components/auth/permissions-context";
import { useEarlyAccess } from "@/components/auth/early-access-context";
import { usePlatformAdmin } from "@/components/auth/platform-admin-context";
import { useAdminPages } from "@/components/auth/admin-pages-context";
import { pageKeyForPath, type AdminPageKey } from "@/lib/admin/pages";

/** Keep only items the user is allowed to see, then drop now-empty groups. */
function visibleGroups(
	groups: SidebarNavGroup[],
	allowed: ReadonlySet<string>,
	earlyAccess: boolean
): SidebarNavGroup[] {
	// Shelved (`devOnly`) items stay OUT of the sidebar so it mirrors production,
	// unless a dev opts in with NEXT_PUBLIC_SHOW_DEV_NAV=true to work on one.
	const showDevNav = process.env.NEXT_PUBLIC_SHOW_DEV_NAV === "true";
	const canSee = (item: SidebarNavItem): boolean => {
		if (item.devOnly && !showDevNav) return false;
		// Unreleased features are visible only to the early-access cohort.
		if (item.earlyAccess && !earlyAccess) return false;
		if (!item.permission) return true;
		const wanted = Array.isArray(item.permission)
			? item.permission
			: [item.permission];
		return wanted.some((p) => allowed.has(p));
	};
	return groups
		.map((group) => ({ ...group, items: group.items.filter(canSee) }))
		.filter((group) => group.items.length > 0);
}

/**
 * The admin navigation, cut to the pages on the viewer's list. An item whose
 * path is no catalog page is kept: the catalog (`@/lib/admin/pages`) names
 * every page, and a test holds the two in step.
 */
function visibleAdminGroups(
	groups: SidebarNavGroup[],
	pages: ReadonlySet<AdminPageKey>
): SidebarNavGroup[] {
	const canSee = (item: SidebarNavItem): boolean => {
		const key = item.path ? pageKeyForPath(item.path) : null;
		return key === null || pages.has(key);
	};
	return groups
		.map((group) => ({ ...group, items: group.items.filter(canSee) }))
		.filter((group) => group.items.length > 0);
}

export function AppSidebar() {
	const permissions = usePermissions();
	const earlyAccess = useEarlyAccess();
	// The admin navigation is drawn only for a platform admin ON the admin
	// side. An outsider's 404 at /admin/anything keeps the app's own sidebar,
	// so the 404 gives nothing away.
	const platformAdmin = usePlatformAdmin();
	const adminPages = useAdminPages();
	const pathname = usePathname();
	const admin = platformAdmin && isAdminPath(pathname);
	const groups = admin
		? visibleAdminGroups(adminNavGroups, adminPages)
		: visibleGroups(navGroups, permissions, earlyAccess);
	const footer = admin
		? visibleAdminGroups([{ items: adminFooterNavLinks }], adminPages).flatMap((g) => g.items)
		: footerNavLinks;
	return (
		<Sidebar
			className={cn(
				"*:data-[slot=sidebar-inner]:bg-background",
				"*:data-[slot=sidebar-inner]:dark:bg-[radial-gradient(60%_18%_at_10%_0%,--theme(--color-foreground/.08),transparent)]",
				"**:data-[slot=sidebar-menu-button]:[&>span]:text-foreground/75"
			)}
			collapsible="icon"
			variant="sidebar"
		>
			<SidebarHeader className="h-14 justify-center border-b px-2">
				<SidebarMenuButton render={<a href="#link" />}><Image src="/slim_normal.png" alt="WildcatIQ logo" width={16} height={16} className="size-4 shrink-0" /><span className="text-base font-semibold text-foreground!">WildcatIQ</span></SidebarMenuButton>
			</SidebarHeader>
			<SidebarContent>
				{groups.map((group, index) => (
					<NavGroup key={`sidebar-group-${index}`} {...group} />
				))}
			</SidebarContent>
			<SidebarFooter className="gap-0 p-0">
				{footer.length > 0 && (
					<SidebarMenu className="border-t p-2">
						{footer.map((item) => (
							<SidebarMenuItem key={item.title}>
								<SidebarMenuButton className="text-muted-foreground" isActive={item.isActive} size="sm" tooltip={item.title} render={<Link href={item.path ?? "#"} />}>{item.icon}<span>{item.title}</span></SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				)}
				<div className="border-t px-4 pt-4 pb-2 transition-opacity group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0">
					<p className="text-nowrap text-[9px] text-muted-foreground">
						© {new Date().getFullYear()} Wildcat Labs, Inc.
					</p>
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}
