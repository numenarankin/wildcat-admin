"use client";

/**
 * The sidebar's Leases flyout: hovering the nav item opens a second panel to the
 * right of the sidebar listing every lease, and hovering a lease opens a third
 * with the facilities on it, grouped oil tanks → saltwater tanks → gas meters →
 * saltwater meters → SWD wells → batteries → producing wells
 * (`LEASE_NAV_SECTIONS`).
 *
 * The panels are portalled to the body rather than nested in the sidebar: the
 * sidebar scrolls its own content, and an ancestor with a transform (the app
 * shell's mount animation) would make a `fixed` child position against IT
 * instead of the viewport. Portalled, they anchor off the measured right edge of
 * the sidebar container, so they sit flush whether it is expanded or collapsed
 * to icons.
 *
 * Data comes from the root layout (`LeaseNavProvider`), read on every page
 * load so the first hover is instant; when the layout had nothing it loads
 * once, on the first open, through `getLeaseNavTree`. Never re-read per hover.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { SearchMd } from "@untitledui/icons";
import {
	ChevronRightIcon,
	CircleIcon,
	CylinderIcon,
	DropletIcon,
	GaugeIcon,
	LayersIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import type { SidebarNavItem } from "@/components/app-shared";
import { getLeaseNavTree } from "@/lib/leases/actions";
import { useLeaseNavTree } from "@/components/leases/lease-nav-context";
import {
	filterLeaseNav,
	type LeaseNavKind,
	type LeaseNavLease,
} from "@/lib/leases/nav-tree";
import { cn } from "@/lib/utils";

/** Panel width, and the offset the facilities panel sits at. Matches `--sidebar-width`. */
const PANEL_WIDTH = 256;

/** Grace period for crossing the gap between the trigger and the panels. */
const CLOSE_DELAY_MS = 160;

const KIND_ICON: Record<LeaseNavKind, typeof CircleIcon> = {
	activeWell: CircleIcon,
	oilTank: CylinderIcon,
	waterTank: CylinderIcon,
	gasMeter: GaugeIcon,
	battery: LayersIcon,
	inactiveWell: CircleIcon,
	pluggedWell: CircleIcon,
	swdWell: DropletIcon,
	swdBattery: LayersIcon,
	swdTank: CylinderIcon,
	waterMeter: GaugeIcon,
};

export function LeaseNavFlyout({
	item,
	isActive,
}: {
	item: SidebarNavItem;
	isActive: boolean;
}) {
	const { isMobile } = useSidebar();
	const preloaded = useLeaseNavTree();
	const [open, setOpen] = useState(false);
	const [fetched, setFetched] = useState<LeaseNavLease[] | null>(null);
	// The layout's copy wins whenever it has one: it is re-read on every page
	// load, so it is never staler than what a hover would fetch.
	const leases = preloaded ?? fetched;
	const [failed, setFailed] = useState(false);
	const [query, setQuery] = useState("");
	const [activeLease, setActiveLease] = useState<string | null>(null);
	const [left, setLeft] = useState(0);
	const triggerRef = useRef<HTMLLIElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loading = useRef(false);

	const cancelClose = useCallback(() => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	}, []);

	const close = useCallback(() => {
		cancelClose();
		setOpen(false);
		setActiveLease(null);
		setQuery("");
	}, [cancelClose]);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = setTimeout(close, CLOSE_DELAY_MS);
	}, [cancelClose, close]);

	const openFlyout = useCallback(() => {
		cancelClose();
		// Anchor off the sidebar's own right edge so the panel is flush with it in
		// both widths, and through the collapse transition.
		const sidebar = triggerRef.current?.closest<HTMLElement>(
			'[data-slot="sidebar-container"]'
		);
		if (sidebar) setLeft(sidebar.getBoundingClientRect().right);
		setOpen(true);
		if (leases || loading.current) return;
		loading.current = true;
		getLeaseNavTree()
			.then(setFetched)
			.catch(() => setFailed(true))
			.finally(() => {
				loading.current = false;
			});
	}, [cancelClose, leases]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, close]);

	useEffect(() => cancelClose, [cancelClose]);

	const shown = leases ? filterLeaseNav(leases, query) : [];
	const active = shown.find((l) => l.id === activeLease) ?? null;

	return (
		<SidebarMenuItem
			ref={triggerRef}
			onMouseEnter={isMobile ? undefined : openFlyout}
			onMouseLeave={isMobile ? undefined : scheduleClose}
		>
			{/* Every link in here closes the menu on the way out: navigating is the
			    end of its job, and otherwise it hangs over the page the click just
			    opened until the pointer happens to leave it. */}
			<SidebarMenuButton
				isActive={isActive}
				onClick={close}
				render={<Link href={item.path ?? "#"} />}
			>
				{item.icon}
				<span>{item.title}</span>
			</SidebarMenuButton>
			{open && !isMobile && (
				<FlyoutPanels
					left={left}
					leases={shown}
					loaded={leases !== null}
					failed={failed}
					query={query}
					onQueryChange={setQuery}
					activeLease={active}
					onHoverLease={setActiveLease}
					onEnter={cancelClose}
					onLeave={scheduleClose}
					onNavigate={close}
				/>
			)}
		</SidebarMenuItem>
	);
}

function FlyoutPanels({
	left,
	leases,
	loaded,
	failed,
	query,
	onQueryChange,
	activeLease,
	onHoverLease,
	onEnter,
	onLeave,
	onNavigate,
}: {
	left: number;
	leases: LeaseNavLease[];
	loaded: boolean;
	failed: boolean;
	query: string;
	onQueryChange: (value: string) => void;
	activeLease: LeaseNavLease | null;
	onHoverLease: (id: string | null) => void;
	onEnter: () => void;
	onLeave: () => void;
	onNavigate: () => void;
}) {
	// Safe without a mounted guard: the panels only render once the pointer has
	// entered the trigger, which cannot happen during SSR or hydration.
	return createPortal(
		<div
			data-slot="lease-nav-flyout"
			// Starts under the app header (`h-14`, sticky at `z-50`) and runs to
			// the bottom, so the topbar stays readable while the menu is open.
			className="fixed bottom-0 top-14 z-40 flex"
			style={{ left }}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
		>
			<div
				className="flex h-full flex-col border-r bg-background shadow-lg"
				style={{ width: PANEL_WIDTH }}
			>
				<div className="relative flex shrink-0 items-center border-b p-2">
					<SearchMd className="pointer-events-none absolute left-4 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						placeholder="Search leases"
						aria-label="Search leases"
						className="pl-7"
					/>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-2">
					{!loaded && !failed && (
						<p className="px-2 py-1.5 text-sm text-muted-foreground">
							Loading leases…
						</p>
					)}
					{failed && (
						<p className="px-2 py-1.5 text-sm text-muted-foreground">
							Leases could not be loaded.
						</p>
					)}
					{loaded && leases.length === 0 && (
						<p className="px-2 py-1.5 text-sm text-muted-foreground">
							{query ? "No matching leases." : "No leases yet."}
						</p>
					)}
					{leases.map((lease) => (
						<Link
							key={lease.id}
							href={lease.href}
							onClick={onNavigate}
							onMouseEnter={() => onHoverLease(lease.id)}
							className={cn(
								"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/75 hover:bg-accent hover:text-foreground",
								activeLease?.id === lease.id && "bg-accent text-foreground"
							)}
						>
							<span className="truncate">{lease.name}</span>
							{lease.facilityCount > 0 && (
								<ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
							)}
						</Link>
					))}
				</div>
			</div>
			{activeLease && (
				<div
					className="flex h-full flex-col border-r bg-background shadow-lg"
					style={{ width: PANEL_WIDTH }}
				>
					<div className="min-h-0 flex-1 overflow-y-auto p-2">
						{activeLease.sections.length === 0 && (
							<p className="px-2 py-1.5 text-sm text-muted-foreground">
								No facilities on this lease.
							</p>
						)}
						{activeLease.sections.map((section) => (
							<div key={section.kind} className="pb-2">
								<p className="px-2 py-1 text-xs font-medium text-muted-foreground">
									{section.label}
								</p>
								{section.items.map((facility) => {
									const Icon = KIND_ICON[facility.kind];
									return (
										<Link
											key={facility.key}
											href={facility.href}
											onClick={onNavigate}
											className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/75 hover:bg-accent hover:text-foreground"
										>
											<Icon className="size-3.5 shrink-0 text-muted-foreground" />
											<span className="truncate">{facility.name}</span>
										</Link>
									);
								})}
							</div>
						))}
					</div>
				</div>
			)}
		</div>,
		document.body
	);
}
