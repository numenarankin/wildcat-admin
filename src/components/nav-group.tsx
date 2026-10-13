"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { SidebarNavGroup } from "@/components/app-shared";
import { LeaseNavFlyout } from "@/components/leases/lease-nav-flyout";
import { ChevronRightIcon } from "lucide-react";

/**
 * Whether a nav path matches the current route. The home route ("/") only
 * matches exactly; every other route also matches its nested sub-routes
 * (e.g. /wells stays active on /wells/123).
 */
function isPathActive(pathname: string, path?: string): boolean {
	if (!path) return false;
	if (path === "/") return pathname === "/";
	return pathname === path || pathname.startsWith(`${path}/`);
}

export function NavGroup({ label, items }: SidebarNavGroup) {
	const pathname = usePathname();

	return (
		<SidebarGroup>
			{label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
			<SidebarMenu>
				{items.map((item) => {
					const subActive = item.subItems?.some((i) =>
						isPathActive(pathname, i.path)
					);
					const itemActive = isPathActive(pathname, item.path) || subActive;
					// A flyout item owns its own menu row: the panels have to hang off
					// the row's position, and it has no sub-items to collapse.
					if (item.flyout === "leases") {
						return (
							<LeaseNavFlyout
								key={item.title}
								item={item}
								isActive={!!itemActive}
							/>
						);
					}
					return (
						<Collapsible className="group/collapsible" defaultOpen={itemActive} key={item.title} render={<SidebarMenuItem />}>{item.subItems?.length ? (
									<>
										<CollapsibleTrigger render={<SidebarMenuButton isActive={itemActive} tooltip={item.title} />}>{item.icon}<span>{item.title}</span><ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" /></CollapsibleTrigger>
										<CollapsibleContent>
											<SidebarMenuSub>
												{item.subItems?.map((subItem) => (
													<SidebarMenuSubItem key={subItem.title}>
														<SidebarMenuSubButton isActive={isPathActive(pathname, subItem.path)} render={<Link href={subItem.path ?? "#"} />}>{subItem.icon}<span>{subItem.title}</span></SidebarMenuSubButton>
													</SidebarMenuSubItem>
												))}
											</SidebarMenuSub>
										</CollapsibleContent>
									</>
								) : (
									<SidebarMenuButton isActive={itemActive} tooltip={item.title} render={<Link href={item.path ?? "#"} />}>{item.icon}<span>{item.title}</span></SidebarMenuButton>
								)}</Collapsible>
					);
				})}
			</SidebarMenu>
		</SidebarGroup>
	);
}
