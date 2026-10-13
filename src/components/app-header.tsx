import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { DecorIcon } from "@/components/decor-icon";
import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { CustomSidebarTrigger } from "@/components/custom-sidebar-trigger";
import { NavUser } from "@/components/nav-user";
import { AiDrawerTrigger } from "@/components/ai/ai-drawer-trigger";
import { VoiceModeToggle } from "@/components/ai/voice-mode-toggle";
import { PriceTicker } from "@/components/price-ticker";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { usePathname } from "next/navigation";
import { Can } from "@/components/auth/permissions-context";
import { usePlatformAdmin } from "@/components/auth/platform-admin-context";
import { isAdminPath } from "@/components/app-shared";
import { displayFirstName } from "@/lib/user";
import type { Profile } from "@/lib/settings/profile";
import type { OrgOption } from "@/lib/auth/org-types";

// AppHeader lives inside the client AppShell, so it can't fetch data itself
// (an async client component loops on an uncached promise). The profile + the
// session email are fetched in the server layout and passed down.
export function AppHeader({
	profile,
	userEmail,
	credits,
	orgs,
	currentOrgId,
	minimal = false,
}: {
	profile: Profile;
	userEmail: string;
	credits: number;
	/** Every workspace this user can enter, for the account menu's switcher. */
	orgs: OrgOption[];
	/** The workspace they are in now. */
	currentOrgId: string | null;
	/**
	 * Drop the left half (sidebar trigger + breadcrumbs) and the bottom border,
	 * keeping only the account cluster on the right. For the pages that render
	 * without the sidebar but still need somewhere to reach the account menu.
	 */
	minimal?: boolean;
}) {
	// On the admin side the Orion button opens the ADMIN drawer, which is
	// gated by the admin list rather than an org capability, and there is no
	// voice loop to toggle. Both hooks run unconditionally.
	const platformAdmin = usePlatformAdmin();
	const pathname = usePathname();
	const admin = platformAdmin && isAdminPath(pathname);
	const name = profile.name.trim() || displayFirstName(null, userEmail);
	return (
		<header
			className={cn(
				"sticky top-0 z-50 flex shrink-0 items-center gap-2 px-4 md:px-6",
				minimal
					? "h-auto justify-end pt-6 pb-3"
					: "h-14 justify-between border-b",
				"bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/50"
			)}
		>
			{!minimal && (
				<>
					<DecorIcon className="hidden md:block" position="bottom-left" />
					<div className="flex items-center gap-3">
						<CustomSidebarTrigger />
						<Separator
							className="mr-2 h-4 data-[orientation=vertical]:self-center"
							orientation="vertical"
						/>
						<AppBreadcrumbs />
					</div>
				</>
			)}
			<div className="flex items-center gap-3">
				<PriceTicker />
				{/* Voice + Orion triggers only for users who hold `use_ai`. The
				    Orion trigger opens the drawer, which the minimal layout does
				    not render: there Orion is already on screen beside the page,
				    so the button would toggle nothing. */}
				{admin ? (
					<AiDrawerTrigger />
				) : (
					<Can permission="use_ai">
						<VoiceModeToggle />
						{!minimal && <AiDrawerTrigger />}
					</Can>
				)}
				{/* Alerts bell: right of the Orion (AI drawer) trigger. Shown to
				    everyone — notifications aren't gated by `use_ai`. */}
				<NotificationBell />
				<Separator
					className="h-4 data-[orientation=vertical]:self-center"
					orientation="vertical"
				/>
				<NavUser
					name={name}
					email={userEmail}
					avatarUrl={profile.avatarUrl}
					credits={credits}
					orgs={orgs}
					currentOrgId={currentOrgId}
				/>
			</div>
		</header>
	);
}
