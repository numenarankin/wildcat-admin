import { DriveDocView } from "@/components/admin/drive/drive-doc-view";
import { GoogleNotConnected } from "@/components/admin/drive/not-connected";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { googleAdminId } from "@/lib/admin/google/guard";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { getFile } from "@/lib/admin/google/drive/client";
import { getDocument } from "@/lib/admin/google/docs/client";
import { docToHtml } from "@/lib/admin/google/docs/model";
import { isDriveId } from "@/lib/admin/google/drive/map";

export const metadata = { title: "Doc" };

/**
 * A Google Doc in our editor, read only until editing ships (plan section 8,
 * phase 8). `?from=` is the Drive folder it was opened from, for Back.
 */
export default async function AdminDriveDocPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  await requireAdminPage("drive");
  const google = await getGoogleSettings();
  const userId = google?.services.includes("drive") ? await googleAdminId() : null;
  if (!userId) return <GoogleNotConnected title="Drive" service="Drive" />;

  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  const backFolder = from && isDriveId(from) ? from : "root";
  if (!isDriveId(id)) {
    return <DriveDocView id={id} title="Doc" html={null} webViewLink={null} backFolder={backFolder} error="Not a Google Doc id." />;
  }

  let view: { title: string; html: string; webViewLink: string | null } | null = null;
  let error: string | null = null;
  try {
    const [doc, file] = await Promise.all([getDocument(userId, id), getFile(userId, id)]);
    view = { title: doc.title || file.name, html: docToHtml(doc), webViewLink: file.webViewLink ?? null };
  } catch (e) {
    error = googleErrorMessage(e, "Drive");
  }
  return (
    <DriveDocView
      id={id}
      title={view?.title ?? "Doc"}
      html={view?.html ?? null}
      webViewLink={view?.webViewLink ?? null}
      backFolder={backFolder}
      error={error}
    />
  );
}
