"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { adminNavLinks, isAdminPath, navLinks } from "@/components/app-shared";
import { useBreadcrumbLabel } from "@/components/breadcrumb-context";
import { usePlatformAdmin } from "@/components/auth/platform-admin-context";

/**
 * Sections whose index page is a set of tabs named by the detail route's middle
 * segment (`/production/wells/[well]` → the Wells tab). Only these get a middle
 * crumb, because only these have a tab for it to link back to.
 */
const TABBED_SECTIONS = new Set(["production", "disposal"]);

/** Title-cases a URL slug as a fallback before the page registers its label. */
function prettifySlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Click-to-edit trailing crumb (used to rename a project). */
function EditableCrumb({
	value,
	onCommit,
}: {
	value: string;
	onCommit: (name: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);

	function commit() {
		setEditing(false);
		const trimmed = draft.trim();
		if (trimmed && trimmed !== value) onCommit(trimmed);
	}

	if (editing) {
		return (
			<input
				ref={inputRef}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						setDraft(value);
						setEditing(false);
					}
				}}
				className="w-40 rounded border border-border bg-background px-1.5 py-0.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={() => {
				setDraft(value);
				setEditing(true);
			}}
			title="Click to rename"
			className="rounded px-1 hover:bg-accent"
		>
			{value}
		</button>
	);
}

export function AppBreadcrumbs() {
	const pathname = usePathname();
	const ctx = useBreadcrumbLabel();
	const platformAdmin = usePlatformAdmin();
	const segments = pathname.split("/").filter(Boolean);

	// A section is the first segment (`/sales`), and it is only a section for a
	// platform admin: an outsider's 404 there names nothing, same as the sidebar.
	const admin = platformAdmin && isAdminPath(pathname);
	const sectionDepth = 1;
	const sectionPath = `/${segments.slice(0, sectionDepth).join("/")}`;
	const links = admin ? adminNavLinks : navLinks;

	const section =
		links.find((item) => item.path === sectionPath) ??
		(segments.length === 0
			? navLinks.find((item) => item.path === "/")
			: undefined);

	if (!section?.title) {
		return null;
	}

	const isDetail = segments.length > sectionDepth;
	// The trailing crumb names the record, so its slug fallback is the LAST
	// segment — on `/production/wells/baldwin` that is the well, not "wells".
	const detailLabel =
		ctx?.label ?? prettifySlug(segments[segments.length - 1] ?? "");
	const rename = ctx?.rename ?? null;
	// The middle crumb (Wells / Tanks / Meters / Batteries), linking back to the
	// index tab it came from rather than dumping the user on the default tab.
	const group =
		segments.length > 2 && TABBED_SECTIONS.has(segments[0])
			? segments[1]
			: null;

	return (
		<Breadcrumb>
			<BreadcrumbList>
				<BreadcrumbItem>
					{isDetail && section.path ? (
						<BreadcrumbLink
							render={<Link href={section.path} />}
							className="flex items-center gap-2 [&>svg]:size-3.5"
						>
							{section.icon}
							{section.title}
						</BreadcrumbLink>
					) : (
						<BreadcrumbPage className="flex items-center gap-2 [&>svg]:size-3.5">
							{section.icon}
							{section.title}
						</BreadcrumbPage>
					)}
				</BreadcrumbItem>
				{group && (
					<>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbLink
								render={<Link href={`/${segments[0]}?tab=${group}`} />}
							>
								{prettifySlug(group)}
							</BreadcrumbLink>
						</BreadcrumbItem>
					</>
				)}
				{isDetail && (
					<>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							{rename ? (
									<EditableCrumb value={detailLabel} onCommit={rename} />
								) : (
									<BreadcrumbPage>{detailLabel}</BreadcrumbPage>
								)}
						</BreadcrumbItem>
					</>
				)}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
