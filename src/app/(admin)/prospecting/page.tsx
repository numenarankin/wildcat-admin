import { requireAdminPage } from "@/lib/auth/platform-admin";
import { hasRrcDb } from "@/lib/scout/rrc-db";
import { tileVersion, warmTileIndex } from "@/lib/scout/live-tiler";
import { FALLBACK_PRICES } from "@/lib/scout/revenue";
import { getCommodityQuotes } from "@/lib/pricing/feed";
import type { CommodityPrices } from "@/lib/analytics/types";
import { parseReconLink } from "@/lib/recon-alerts/types";
import { getTargets } from "@/lib/admin/targets";
import { getEnrichQueue } from "@/lib/admin/outreach/research";
import { getEnrollments } from "@/lib/admin/outreach/sequences";
import { getProspectingSettings, getScheduledEmails } from "@/lib/admin/outreach/settings";
import { readEmailIndex } from "@/lib/admin/google/gmail/index-read";
import { getEmailSettings } from "@/lib/admin/google/gmail/email-settings";
import { googleAdminId } from "@/lib/admin/google/guard";
import { getProfile } from "@/lib/settings/profile";
import { getSessionUser } from "@/lib/auth/session";
import { displayFirstName } from "@/lib/user";
import { ProspectingWorkspace } from "@/components/admin/prospecting/prospecting-workspace";

export const metadata = { title: "Prospecting" };

/**
 * Prospecting: the insiders' desk for finding operators to sell to. Its Map
 * tab is the customer app's Recon page (`wildcat/src/app/recon/page.tsx`) with
 * its basemap in the admin theme: every RRC wellbore in Texas, clustered, with the operator's
 * dossier a click away. The tile, operator and dossier routes under
 * `/api/scout/*` repeat the platform-admin gate, since they reach the RRC
 * mirror through a connection that bypasses RLS.
 */
export default async function AdminProspectingPage({
  searchParams,
}: {
  /** Recon's deep links (`?well=`, `?permit=`, `?permitNo=`, `?alert=`). */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage("prospecting");
  const link = parseReconLink(await searchParams);

  if (!hasRrcDb()) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center text-sm text-muted-foreground">
          The map is not configured. Set{" "}
          <code className="font-mono">RRC_DATABASE_URL</code> in{" "}
          <code className="font-mono">.env</code>.
        </div>
      </div>
    );
  }

  // Build the tile index while the client boots Mapbox, so the first tile
  // request doesn't pay for it. Deliberately not awaited.
  warmTileIndex();

  const quotes = await getCommodityQuotes().catch(() => []);
  const prices: CommodityPrices = {
    oilPerBbl: quotes.find((q) => q.label === "WTI")?.price ?? FALLBACK_PRICES.oilPerBbl,
    gasPerMcf: quotes.find((q) => q.label === "Nat Gas")?.price ?? FALLBACK_PRICES.gasPerMcf,
  };

  const [targets, queue, enrollments, scheduled, settings, emailSettings, profile, user, googleId] = await Promise.all([
    getTargets(prices),
    getEnrichQueue(),
    getEnrollments(),
    getScheduledEmails(),
    getProspectingSettings(),
    getEmailSettings(),
    getProfile(),
    getSessionUser(),
    googleAdminId(),
  ]);
  // The compose card's autofill; empty without a connected Google account.
  const emailIndex = googleId
    ? await readEmailIndex(googleId).catch(() => ({ contacts: [], subjects: [] }))
    : { contacts: [], subjects: [] };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProspectingWorkspace
        prices={prices}
        targets={targets}
        queue={queue}
        enrollments={enrollments}
        scheduled={scheduled}
        settings={settings}
        emailIndex={emailIndex}
        emailSettings={emailSettings}
        firstName={displayFirstName(profile.name, user?.email)}
        // Read here, not in the client: it comes from the points file on disk.
        tileVersion={await tileVersion()}
        link={link}
      />
    </div>
  );
}
