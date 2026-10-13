"use client";

import { motion, useReducedMotion } from "framer-motion";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { AppMain } from "@/components/app-main";
import { AiDrawer } from "@/components/ai/ai-drawer";
import { BreadcrumbProvider } from "@/components/breadcrumb-context";
import { PermissionsProvider } from "@/components/auth/permissions-context";
import { EarlyAccessProvider } from "@/components/auth/early-access-context";
import { PlatformAdminProvider } from "@/components/auth/platform-admin-context";
import { AdminPagesProvider } from "@/components/auth/admin-pages-context";
import { CreditsProvider } from "@/components/billing/credits-context";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import type { Profile } from "@/lib/settings/profile";
import type { PermissionKey } from "@/lib/settings/org";
import type { AdminPageKey } from "@/lib/admin/pages";
import type { NotificationSeed } from "@/lib/notifications/recent";
import type { OrgOption } from "@/lib/auth/org-types";
import { useTheme } from "@/components/theme-provider";
import { THEME_CLASSES } from "@/lib/theme";

/**
 * The admin app's chrome: the admin branch of the customer app's `AppShell`,
 * on its own. Only rendered under the `(admin)` layout, which has already
 * confirmed the viewer is on `platform_admins`, so the admin Orion drawer is
 * unconditional here. The navigation shows the pages on their list
 * (`adminPages`), which the sidebar reads through `AdminPagesProvider`.
 */
export function AdminShell({
	children,
	profile,
	userEmail,
	userId,
	credits,
	permissions,
	adminPages,
	notifications,
	orgs,
	currentOrgId,
	sidebarOpen,
}: {
	children: React.ReactNode;
	profile: Profile;
	userEmail: string;
	userId: string;
	credits: number;
	permissions: PermissionKey[];
	/** The admin pages the viewer may open; the sidebar draws only these. */
	adminPages: AdminPageKey[];
	notifications: NotificationSeed;
	orgs: OrgOption[];
	currentOrgId: string | null;
	/** Whether the sidebar starts expanded: the viewer's last choice, else collapsed. */
	sidebarOpen: boolean;
}) {
	const still = useReducedMotion();
	const { theme } = useTheme();
	const EASE = [0.16, 1, 0.3, 1] as const;

	return (
		<PermissionsProvider permissions={permissions}>
		<EarlyAccessProvider earlyAccess={false}>
		<PlatformAdminProvider platformAdmin>
		<AdminPagesProvider pages={adminPages}>
		<CreditsProvider credits={credits}>
		<NotificationsProvider
			userId={userId}
			initialItems={notifications.items}
			initialUnread={notifications.unreadCount}
		>
		<BreadcrumbProvider>
			<motion.div
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: still ? 0 : 0.14, ease: EASE }}
				className={THEME_CLASSES[theme].join(" ")}
			>
			<SidebarProvider defaultOpen={sidebarOpen}>
				<AppSidebar />
				<SidebarInset className="min-w-0">
					<AppHeader
						profile={profile}
						userEmail={userEmail}
						credits={credits}
						orgs={orgs}
						currentOrgId={currentOrgId}
					/>
					<AppMain>{children}</AppMain>
				</SidebarInset>
				<AiDrawer admin />
			</SidebarProvider>
			</motion.div>
		</BreadcrumbProvider>
		</NotificationsProvider>
		</CreditsProvider>
		</AdminPagesProvider>
		</PlatformAdminProvider>
		</EarlyAccessProvider>
		</PermissionsProvider>
	);
}
