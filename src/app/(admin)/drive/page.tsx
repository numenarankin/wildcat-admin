import { DriveBrowser, type DriveCrumb } from "@/components/admin/drive/drive-browser";
import { GoogleNotConnected } from "@/components/admin/drive/not-connected";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { googleAdminId } from "@/lib/admin/google/guard";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { folderPath, getFile, listFolder, listSharedDrives, searchDrive } from "@/lib/admin/google/drive/client";
import { FOLDER_MIME, isDriveId, toDriveRow, type DriveRow } from "@/lib/admin/google/drive/map";

export const metadata = { title: "Drive" };

const TOP: DriveCrumb = { id: "root", name: "Drive" };

/**
 * The admin's Google Drive, read only (docs/plans/google-integration.md 7.4).
 * `?folder=<id>` opens a folder, `?q=` searches all of Drive. The top level is
 * My Drive's contents with each shared drive listed as a folder.
 */
export default async function AdminDrivePage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; q?: string }>;
}) {
  await requireAdminPage("drive");
  const google = await getGoogleSettings();
  const userId = google?.services.includes("drive") ? await googleAdminId() : null;
  if (!userId) return <GoogleNotConnected title="Drive" service="Drive" />;

  const { folder, q } = await searchParams;
  const query = q?.trim() ?? "";
  const folderId = folder && isDriveId(folder) ? folder : "root";

  let crumbs: DriveCrumb[] = [TOP];
  let rows: DriveRow[] = [];
  let truncated = false;
  let error: string | null = null;
  try {
    if (query) {
      const found = await searchDrive(userId, query);
      rows = found.files.map(toDriveRow);
      truncated = found.truncated;
    } else if (folderId === "root") {
      const [mine, drives] = await Promise.all([listFolder(userId, "root"), listSharedDrives(userId)]);
      rows = [
        ...drives.map((d) => toDriveRow({ id: d.id, name: d.name, mimeType: FOLDER_MIME })),
        ...mine.files.map(toDriveRow),
      ];
      truncated = mine.truncated;
    } else {
      const [listing, path, root] = await Promise.all([
        listFolder(userId, folderId),
        folderPath(userId, folderId),
        getFile(userId, "root"),
      ]);
      rows = listing.files.map(toDriveRow);
      truncated = listing.truncated;
      // My Drive itself is the top crumb ("Drive"), so it is not repeated.
      crumbs = [TOP, ...path.filter((f) => f.id !== root.id).map((f) => ({ id: f.id, name: f.name }))];
    }
  } catch (e) {
    error = googleErrorMessage(e, "Drive");
  }

  return (
    <DriveBrowser
      key={`${folderId}:${query}`}
      crumbs={crumbs}
      rows={rows}
      query={query}
      truncated={truncated}
      error={error}
    />
  );
}
