import "server-only";
import { googleFetch, googleUrl } from "@/lib/admin/google/fetch";
import type { DocsDocument } from "@/lib/admin/google/docs/model";

/** Docs API v1 `documents.get`, through the Drive connection (it grants `documents`). */
export function getDocument(userId: string, documentId: string): Promise<DocsDocument> {
  return googleFetch<DocsDocument>(
    userId,
    "drive",
    googleUrl(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`)
  );
}
