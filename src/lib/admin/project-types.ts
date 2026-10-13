/**
 * Admin project shapes, shared by the server reads and the client workspace
 * (no `server-only`, so components can import them).
 */

/** A file uploaded into an admin project (`admin_project_files`). */
export interface AdminProjectFile {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
}
