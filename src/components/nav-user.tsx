"use client";

import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	BookOpenIcon,
	LogOutIcon,
	LifeBuoyIcon,
	MoonIcon,
	SettingsIcon,
	SunIcon,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { SwitchOrgModal } from "@/components/orgs/switch-org-modal";
import type { OrgOption } from "@/lib/auth/org-types";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useCredits } from "@/components/billing/credits-context";
import { wildcatAppUrl } from "@/lib/wildcat-app-url";

export interface NavUserProps {
	name: string;
	email: string;
	avatarUrl?: string | null;
	/** Total AI credits remaining for the org (0 when unconfigured). */
	credits: number;
	/** Every workspace this user can enter. One for almost everyone. */
	orgs?: OrgOption[];
	/** The workspace this page was rendered for. */
	currentOrgId?: string | null;
	/** Switch seams for the dev harness; production uses the real action. */
	onEnterOrg?: (orgId: string) => Promise<void>;
	onEnteredOrg?: () => void;
}

/** Up-to-two-letter initials for the avatar fallback. */
function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function NavUser({
	name,
	email,
	avatarUrl,
	credits,
	orgs = [],
	currentOrgId = null,
	onEnterOrg,
	onEnteredOrg,
}: NavUserProps) {
	const user = { name, email, avatar: avatarUrl ?? undefined };
	const [menuOpen, setMenuOpen] = useState(false);
	const [switchOpen, setSwitchOpen] = useState(false);
	const { theme, setTheme } = useTheme();
	const currentOrg = orgs.find((o) => o.id === currentOrgId) ?? null;
	const router = useRouter();
	const { openBuyCredits } = useCredits();

	function openCredits() {
		setMenuOpen(false);
		openBuyCredits();
	}

	function openSwitch() {
		setMenuOpen(false);
		setSwitchOpen(true);
	}

	function openSupport() {
		setMenuOpen(false);
		// Customer-side support chat lives in the customer app.
		window.location.assign(wildcatAppUrl("/support"));
	}

	async function handleSignOut() {
		// Clear the Supabase session cookies, then hard-navigate. Proxy sees no
		// session and redirects to /auth.
		try {
			await getSupabaseBrowser().auth.signOut();
		} catch {
			// Even if sign-out errors, fall through to the redirect.
		}
		window.location.href = "/auth";
	}

	return (
		<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						aria-label="Account menu"
						className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					/>
				}
			>
				<Avatar className="size-8">
					<AvatarImage src={user.avatar} />
					<AvatarFallback>{initials(user.name)}</AvatarFallback>
				</Avatar>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				<div className="flex items-center gap-3 px-1.5 py-1.5">
					<Avatar className="size-10">
						<AvatarImage src={user.avatar} />
						<AvatarFallback>{initials(user.name)}</AvatarFallback>
					</Avatar>
					<div className="min-w-0">
						<div className="font-medium text-foreground">{user.name}</div>
						<div className="max-w-full overflow-hidden overflow-ellipsis whitespace-nowrap text-muted-foreground text-xs">
							{user.email}
						</div>
					</div>
				</div>
				<DropdownMenuSeparator />
				<div className="flex items-center justify-between gap-2 px-1.5 py-1.5">
					<span className="text-sm text-foreground">
						AI Credits:{" "}
						<span className="font-mono font-medium">
							{credits.toLocaleString()}
						</span>
					</span>
					<button
						type="button"
						onClick={openCredits}
						className="shrink-0 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-black shadow-sm transition-colors hover:bg-muted"
					>
						Buy more
					</button>
				</div>
				{/* Which workspace this session is in. A user can belong to
				    several operators, and everything on screen belongs to
				    exactly one of them. */}
				{currentOrg && (
					<>
						<DropdownMenuSeparator />
						<div className="flex items-center justify-between gap-2 px-1.5 py-1.5">
							<span className="min-w-0">
								<span className="block text-[0.65rem] font-mono uppercase tracking-wider text-muted-foreground">
									Workspace
								</span>
								<span className="block truncate text-sm text-foreground">
									{currentOrg.name}
								</span>
							</span>
							{orgs.length > 1 && (
								<button
									type="button"
									onClick={openSwitch}
									className="shrink-0 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-black shadow-sm transition-colors hover:bg-muted"
								>
									Switch
								</button>
							)}
						</div>
					</>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						render={<Link href={wildcatAppUrl("/docs")} />}
					>
						<BookOpenIcon />
						Help docs
					</DropdownMenuItem>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						render={<Link href="/settings" />}
					>
						<SettingsIcon />
						Settings
					</DropdownMenuItem>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={openSupport}
					>
						<LifeBuoyIcon />
						Chat with support
					</DropdownMenuItem>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
					>
						{theme === "dark" ? <SunIcon /> : <MoonIcon />}
						{theme === "dark" ? "Light mode" : "Dark mode"}
					</DropdownMenuItem>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						variant="destructive"
						onClick={handleSignOut}
					>
						<LogOutIcon
						/>
						Sign out
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
			<SwitchOrgModal
				open={switchOpen}
				onClose={() => setSwitchOpen(false)}
				orgs={orgs}
				currentOrgId={currentOrgId}
				{...(onEnterOrg ? { onEnter: onEnterOrg } : {})}
				{...(onEnteredOrg ? { onEntered: onEnteredOrg } : {})}
			/>
		</DropdownMenu>
	);
}
