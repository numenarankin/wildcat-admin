import "server-only";
import { googleFetch, googleFetchRaw, googleUrl } from "@/lib/admin/google/fetch";
import { EXPORTS, FILE_FIELDS, qLiteral, type DriveFile } from "@/lib/admin/google/drive/map";

/**
 * Drive API v3, read only for now. `userId` is always the session's.
 * Every call includes shared drives (`supportsAllDrives`).
 */

const BASE = "https://www.googleapis.com/drive/v3";
/** A folder or search shows at most this many rows (10 pages). */
export const MAX_ROWS = 1000;

interface FileList {
  files?: DriveFile[];
  nextPageToken?: string;
}

async function listAll(userId: string, q: string, orderBy: string | undefined): Promise<{ files: DriveFile[]; truncated: boolean }> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<FileList>(
      userId,
      "drive",
      googleUrl(`${BASE}/files`, {
        q,
        orderBy,
        pageSize: 100,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
        pageToken,
      })
    );
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && files.length < MAX_ROWS);
  return { files: files.slice(0, MAX_ROWS), truncated: Boolean(pageToken) || files.length > MAX_ROWS };
}

/** A folder's children, folders first then by name (Drive's own order). */
export function listFolder(userId: string, folderId: string) {
  return listAll(userId, `${qLiteral(folderId)} in parents and trashed=false`, "folder,name");
}

/** Full-text search across everything the account can see. Relevance order (no orderBy). */
export function searchDrive(userId: string, term: string) {
  return listAll(userId, `fullText contains ${qLiteral(term)} and trashed=false`, undefined);
}

export function getFile(userId: string, fileId: string): Promise<DriveFile> {
  return googleFetch<DriveFile>(
    userId,
    "drive",
    googleUrl(`${BASE}/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: true })
  );
}

/** Shared drives, shown beside My Drive at the top level. */
export async function listSharedDrives(userId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<{ drives?: { id: string; name: string }[]; nextPageToken?: string }>(
      userId,
      "drive",
      googleUrl(`${BASE}/drives`, { pageSize: 100, pageToken })
    );
    out.push(...(page.drives ?? []).map((d) => ({ id: d.id, name: d.name })));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * The folders from the top down to `folderId`, for the breadcrumbs. Stops at
 * a folder with no parent (My Drive, a shared drive root, or something shared
 * with the admin from outside), and after 20 hops whatever happens.
 */
export async function folderPath(userId: string, folderId: string): Promise<DriveFile[]> {
  const path: DriveFile[] = [];
  let id: string | undefined = folderId;
  for (let hop = 0; id && hop < 20; hop++) {
    const folder = await getFile(userId, id);
    path.unshift(folder);
    id = folder.parents?.[0];
  }
  return path;
}

/** The bytes of a file: exported for Google-native types, raw otherwise. */
export function downloadFile(userId: string, file: Pick<DriveFile, "id" | "mimeType">): Promise<Response> {
  const ex = EXPORTS[file.mimeType];
  const id = encodeURIComponent(file.id);
  return googleFetchRaw(
    userId,
    "drive",
    ex
      ? googleUrl(`${BASE}/files/${id}/export`, { mimeType: ex.mimeType })
      : googleUrl(`${BASE}/files/${id}`, { alt: "media", supportsAllDrives: true })
  );
}

/** Drive API v3 `Comment`, the fields read here. */
export interface DriveComment {
  id: string;
  author?: { displayName?: string; emailAddress?: string };
  content?: string;
  /** The doc text the comment is anchored to. */
  quotedFileContent?: { value?: string };
  createdTime?: string;
  resolved?: boolean;
  deleted?: boolean;
  replies?: {
    author?: { displayName?: string; emailAddress?: string };
    content?: string;
    createdTime?: string;
    deleted?: boolean;
    /** "resolve" / "reopen" for a reply that changed the thread's state. */
    action?: string;
  }[];
}

const COMMENT_FIELDS =
  "nextPageToken,comments(id,author(displayName,emailAddress),content,quotedFileContent(value),createdTime,resolved,deleted,replies(author(displayName,emailAddress),content,createdTime,deleted,action))";

/** Every comment thread on a file, oldest first, with replies. Drive requires `fields` here. */
export async function listComments(userId: string, fileId: string): Promise<DriveComment[]> {
  const out: DriveComment[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<{ comments?: DriveComment[]; nextPageToken?: string }>(
      userId,
      "drive",
      googleUrl(`${BASE}/files/${encodeURIComponent(fileId)}/comments`, {
        fields: COMMENT_FIELDS,
        pageSize: 100,
        includeDeleted: false,
        pageToken,
      })
    );
    out.push(...(page.comments ?? []).filter((c) => !c.deleted));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}
